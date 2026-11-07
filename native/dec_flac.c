#include "audio_formats.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FLAC_INBUF_SIZE 65536
#define FLAC_MAX_BLOCK  65536

typedef struct {
    uint64_t sample_number;
    uint64_t stream_offset;
} flac_seekpoint_t;

typedef struct {
    FILE    *fp;
    uint64_t audio_offset;
    uint64_t frames_decoded;

    /* Bitreader buffer */
    uint8_t  inbuf[FLAC_INBUF_SIZE];
    size_t   inbuf_len;
    size_t   inbuf_byte;
    uint64_t bit_acc;
    int      bit_cnt;
    bool     eof_hit;

    /* Decoded block ring / staging */
    int64_t *sub_buf[OM_MAX_CHANNELS];
    uint32_t blk_frames;
    uint32_t blk_pos;

    /* Optional seektable */
    flac_seekpoint_t *seekpts;
    size_t            num_seekpts;
} flac_priv_t;

static void flac_br_reset(flac_priv_t *f) {
    f->inbuf_len = 0;
    f->inbuf_byte = 0;
    f->bit_acc = 0;
    f->bit_cnt = 0;
    f->eof_hit = false;
}

static inline bool flac_br_refill(flac_priv_t *f, int need_bits) {
    while (f->bit_cnt < need_bits) {
        if (f->inbuf_byte >= f->inbuf_len) {
            if (f->eof_hit) return false;
            f->inbuf_len = fread(f->inbuf, 1, FLAC_INBUF_SIZE, f->fp);
            f->inbuf_byte = 0;
            if (f->inbuf_len == 0) {
                f->eof_hit = true;
                return f->bit_cnt >= need_bits;
            }
        }
        f->bit_acc = (f->bit_acc << 8) | (uint64_t)f->inbuf[f->inbuf_byte++];
        f->bit_cnt += 8;
        if (f->bit_cnt > 56) break;
    }
    return f->bit_cnt >= need_bits;
}

static inline bool flac_br_read_u(flac_priv_t *f, int nbits, uint64_t *out) {
    if (nbits == 0) {
        *out = 0;
        return true;
    }
    if (nbits <= 56) {
        if (!flac_br_refill(f, nbits)) return false;
        f->bit_cnt -= nbits;
        uint64_t mask = (nbits == 64) ? ~0ULL : ((1ULL << nbits) - 1ULL);
        *out = (f->bit_acc >> f->bit_cnt) & mask;
        return true;
    }
    uint64_t hi = 0, lo = 0;
    int hi_bits = nbits - 32;
    if (!flac_br_read_u(f, hi_bits, &hi)) return false;
    if (!flac_br_read_u(f, 32, &lo)) return false;
    *out = (hi << 32) | lo;
    return true;
}

static inline bool flac_br_read_s(flac_priv_t *f, int nbits, int64_t *out) {
    if (nbits <= 0) {
        *out = 0;
        return true;
    }
    uint64_t u = 0;
    if (!flac_br_read_u(f, nbits, &u)) return false;
    if (nbits < 64 && (u & (1ULL << (nbits - 1)))) {
        u |= (~0ULL << nbits);
    }
    *out = (int64_t)u;
    return true;
}

static inline void flac_br_align_byte(flac_priv_t *f) {
    int rem = f->bit_cnt & 7;
    if (rem > 0) {
        f->bit_cnt -= rem;
    }
}

static inline bool flac_br_read_unary_zeros(flac_priv_t *f, uint32_t *out_q) {
    uint32_t q = 0;
    while (true) {
        if (f->bit_cnt == 0) {
            if (!flac_br_refill(f, 8) && f->bit_cnt == 0) return false;
        }
        uint64_t bit = (f->bit_acc >> (f->bit_cnt - 1)) & 1ULL;
        f->bit_cnt--;
        if (bit == 1ULL) {
            *out_q = q;
            return true;
        }
        q++;
        if (q > 1048576U) return false;
    }
}

static bool flac_read_utf8_num(flac_priv_t *f, uint64_t *out) {
    uint64_t b0 = 0;
    if (!flac_br_read_u(f, 8, &b0)) return false;
    if ((b0 & 0x80U) == 0) {
        *out = b0;
        return true;
    }
    int bytes = 0;
    uint8_t mask = 0x80U;
    while (b0 & mask) {
        bytes++;
        mask >>= 1;
    }
    if (bytes < 2 || bytes > 7) return false;
    uint64_t val = b0 & (mask - 1U);
    for (int i = 1; i < bytes; i++) {
        uint64_t bx = 0;
        if (!flac_br_read_u(f, 8, &bx)) return false;
        if ((bx & 0xC0U) != 0x80U) return false;
        val = (val << 6) | (bx & 0x3FU);
    }
    *out = val;
    return true;
}

static bool flac_decode_residuals(flac_priv_t *f, int64_t *dst, uint32_t block_size, uint32_t pred_order) {
    uint64_t method = 0, porder = 0;
    if (!flac_br_read_u(f, 2, &method)) return false;
    if (method > 1) return false;
    if (!flac_br_read_u(f, 4, &porder)) return false;

    int param_bits = (method == 0) ? 4 : 5;
    uint64_t esc_val = (method == 0) ? 15ULL : 31ULL;
    uint32_t num_parts = 1U << porder;
    uint32_t out_idx = pred_order;

    for (uint32_t p = 0; p < num_parts; p++) {
        uint64_t rparam = 0;
        if (!flac_br_read_u(f, param_bits, &rparam)) return false;

        uint32_t part_samples = (block_size >> porder);
        if (p == 0) {
            if (part_samples < pred_order) return false;
            part_samples -= pred_order;
        }
        if (out_idx + part_samples > block_size) return false;

        if (rparam == esc_val) {
            uint64_t raw_bits = 0;
            if (!flac_br_read_u(f, 5, &raw_bits)) return false;
            for (uint32_t i = 0; i < part_samples; i++) {
                int64_t sv = 0;
                if (raw_bits > 0) {
                    if (!flac_br_read_s(f, (int)raw_bits, &sv)) return false;
                }
                dst[out_idx++] = sv;
            }
        } else {
            int k = (int)rparam;
            for (uint32_t i = 0; i < part_samples; i++) {
                uint32_t q = 0;
                uint64_t r = 0;
                if (!flac_br_read_unary_zeros(f, &q)) return false;
                if (k > 0 && !flac_br_read_u(f, k, &r)) return false;
                uint64_t u = ((uint64_t)q << k) | r;
                int64_t sv = (u & 1ULL) ? (-(int64_t)(u >> 1) - 1) : (int64_t)(u >> 1);
                dst[out_idx++] = sv;
            }
        }
    }
    return out_idx == block_size;
}

static bool flac_decode_subframe(flac_priv_t *f, int64_t *buf, uint32_t block_size, int subframe_bps) {
    uint64_t zero_bit = 0, type_code = 0, wasted_flag = 0;
    if (!flac_br_read_u(f, 1, &zero_bit) || zero_bit != 0) return false;
    if (!flac_br_read_u(f, 6, &type_code)) return false;
    if (!flac_br_read_u(f, 1, &wasted_flag)) return false;

    int wasted = 0;
    if (wasted_flag) {
        uint32_t q = 0;
        if (!flac_br_read_unary_zeros(f, &q)) return false;
        wasted = (int)q + 1;
    }
    int bps = subframe_bps - wasted;
    if (bps <= 0 || bps > 33) return false;

    if (type_code == 0) {
        /* CONSTANT */
        int64_t v = 0;
        if (!flac_br_read_s(f, bps, &v)) return false;
        for (uint32_t i = 0; i < block_size; i++) buf[i] = v;
    } else if (type_code == 1) {
        /* VERBATIM */
        for (uint32_t i = 0; i < block_size; i++) {
            if (!flac_br_read_s(f, bps, &buf[i])) return false;
        }
    } else if (type_code >= 8 && type_code <= 12) {
        /* FIXED predictor order 0..4 */
        uint32_t order = (uint32_t)(type_code - 8);
        if (order > block_size) return false;
        for (uint32_t i = 0; i < order; i++) {
            if (!flac_br_read_s(f, bps, &buf[i])) return false;
        }
        if (!flac_decode_residuals(f, buf, block_size, order)) return false;
        for (uint32_t i = order; i < block_size; i++) {
            int64_t pred = 0;
            switch (order) {
                case 0: pred = 0; break;
                case 1: pred = buf[i - 1]; break;
                case 2: pred = 2 * buf[i - 1] - buf[i - 2]; break;
                case 3: pred = 3 * buf[i - 1] - 3 * buf[i - 2] + buf[i - 3]; break;
                case 4: pred = 4 * buf[i - 1] - 6 * buf[i - 2] + 4 * buf[i - 3] - buf[i - 4]; break;
            }
            buf[i] += pred;
        }
    } else if (type_code >= 32 && type_code <= 63) {
        /* LPC predictor order 1..32 */
        uint32_t order = (uint32_t)(type_code - 32) + 1U;
        if (order > block_size) return false;
        for (uint32_t i = 0; i < order; i++) {
            if (!flac_br_read_s(f, bps, &buf[i])) return false;
        }
        uint64_t prec_m1 = 0;
        int64_t qlp_shift = 0;
        if (!flac_br_read_u(f, 4, &prec_m1)) return false;
        if (prec_m1 == 15) return false;
        int coef_prec = (int)prec_m1 + 1;
        if (!flac_br_read_s(f, 5, &qlp_shift)) return false;
        if (qlp_shift < 0) qlp_shift = 0;

        int64_t coefs[32];
        for (uint32_t i = 0; i < order; i++) {
            if (!flac_br_read_s(f, coef_prec, &coefs[i])) return false;
        }
        if (!flac_decode_residuals(f, buf, block_size, order)) return false;
        for (uint32_t i = order; i < block_size; i++) {
            int64_t sum = 0;
            for (uint32_t j = 0; j < order; j++) {
                sum += coefs[j] * buf[i - j - 1];
            }
            buf[i] += (sum >> qlp_shift);
        }
    } else {
        return false;
    }

    if (wasted > 0) {
        for (uint32_t i = 0; i < block_size; i++) {
            buf[i] <<= wasted;
        }
    }
    return true;
}

static bool flac_decode_next_block(om_decoder_t *dec) {
    flac_priv_t *f = (flac_priv_t *)dec->priv;
    flac_br_align_byte(f);

    /* Sync search for 0xFFF8 / 0xFFF9 (14-bit sync 0x3FFE) */
    uint64_t b0 = 0;
    bool synced = false;
    for (int tries = 0; tries < 131072; tries++) {
        if (!flac_br_read_u(f, 8, &b0)) return false;
        if (b0 == 0xFFU) {
            if (!flac_br_refill(f, 8)) return false;
            uint64_t peek = (f->bit_acc >> (f->bit_cnt - 8)) & 0xFFU;
            if ((peek & 0xFCU) == 0xF8U) {
                synced = true;
                break;
            }
        }
    }
    if (!synced) return false;

    uint64_t hdr2 = 0, b3 = 0, b4 = 0;
    if (!flac_br_read_u(f, 8, &hdr2)) return false;
    if (!flac_br_read_u(f, 8, &b3)) return false;
    if (!flac_br_read_u(f, 8, &b4)) return false;

    uint32_t bs_code = (uint32_t)((b3 >> 4) & 0x0FU);
    uint32_t sr_code = (uint32_t)(b3 & 0x0FU);
    uint32_t ch_assign = (uint32_t)((b4 >> 4) & 0x0FU);
    uint32_t bps_code = (uint32_t)((b4 >> 1) & 0x07U);

    uint64_t frame_or_sample = 0;
    if (!flac_read_utf8_num(f, &frame_or_sample)) return false;

    uint32_t block_size = 0;
    if (bs_code == 1) block_size = 192;
    else if (bs_code >= 2 && bs_code <= 5) block_size = 576U << (bs_code - 2);
    else if (bs_code == 6) {
        uint64_t v = 0;
        if (!flac_br_read_u(f, 8, &v)) return false;
        block_size = (uint32_t)v + 1U;
    } else if (bs_code == 7) {
        uint64_t v = 0;
        if (!flac_br_read_u(f, 16, &v)) return false;
        block_size = (uint32_t)v + 1U;
    } else if (bs_code >= 8 && bs_code <= 15) {
        block_size = 256U << (bs_code - 8);
    } else {
        return false;
    }
    if (block_size == 0 || block_size > FLAC_MAX_BLOCK) return false;

    if (sr_code == 12) {
        uint64_t dummy = 0;
        if (!flac_br_read_u(f, 8, &dummy)) return false;
    } else if (sr_code == 13 || sr_code == 14) {
        uint64_t dummy = 0;
        if (!flac_br_read_u(f, 16, &dummy)) return false;
    }

    uint64_t crc8 = 0;
    if (!flac_br_read_u(f, 8, &crc8)) return false;

    int bps = (int)dec->info.bit_depth;
    if (bps_code == 1) bps = 8;
    else if (bps_code == 2) bps = 12;
    else if (bps_code == 4) bps = 16;
    else if (bps_code == 5) bps = 20;
    else if (bps_code == 6) bps = 24;
    else if (bps_code == 7) bps = 32;

    uint16_t channels = (ch_assign < 8) ? (uint16_t)(ch_assign + 1) : 2;
    if (channels != dec->info.channels) return false;

    for (uint16_t ch = 0; ch < channels; ch++) {
        int sub_bps = bps;
        if ((ch_assign == 8 && ch == 1) ||
            (ch_assign == 9 && ch == 0) ||
            (ch_assign == 10 && ch == 1)) {
            sub_bps = bps + 1;
        }
        if (!flac_decode_subframe(f, f->sub_buf[ch], block_size, sub_bps)) return false;
    }

    if (ch_assign == 8) {
        for (uint32_t i = 0; i < block_size; i++) {
            f->sub_buf[1][i] = f->sub_buf[0][i] - f->sub_buf[1][i];
        }
    } else if (ch_assign == 9) {
        for (uint32_t i = 0; i < block_size; i++) {
            f->sub_buf[0][i] = f->sub_buf[0][i] + f->sub_buf[1][i];
        }
    } else if (ch_assign == 10) {
        for (uint32_t i = 0; i < block_size; i++) {
            int64_t mid = f->sub_buf[0][i];
            int64_t side = f->sub_buf[1][i];
            mid = (mid << 1) | (side & 1);
            f->sub_buf[0][i] = (mid + side) >> 1;
            f->sub_buf[1][i] = (mid - side) >> 1;
        }
    }

    flac_br_align_byte(f);
    uint64_t crc16 = 0;
    if (!flac_br_read_u(f, 16, &crc16)) return false;

    f->blk_frames = block_size;
    f->blk_pos = 0;
    return true;
}

static int flac_read_frames(om_decoder_t *dec, int32_t *out_i32, double *out_f64, size_t max_frames) {
    flac_priv_t *f = (flac_priv_t *)dec->priv;
    if (!f || !f->fp || max_frames == 0) return 0;

    uint16_t channels = dec->info.channels;
    uint16_t bit_depth = dec->info.bit_depth;
    size_t produced = 0;

    while (produced < max_frames) {
        if (dec->info.total_frames > 0 && f->frames_decoded >= dec->info.total_frames) break;

        if (f->blk_pos >= f->blk_frames) {
            if (!flac_decode_next_block(dec)) break;
        }

        uint32_t avail = f->blk_frames - f->blk_pos;
        size_t want = max_frames - produced;
        if (avail < want) want = avail;
        if (dec->info.total_frames > 0 && f->frames_decoded + want > dec->info.total_frames) {
            want = (size_t)(dec->info.total_frames - f->frames_decoded);
        }

        for (size_t i = 0; i < want; i++) {
            uint32_t src_idx = f->blk_pos + (uint32_t)i;
            size_t dst_base = (produced + i) * channels;
            for (uint16_t ch = 0; ch < channels; ch++) {
                int32_t v = (int32_t)f->sub_buf[ch][src_idx];
                if (out_i32) out_i32[dst_base + ch] = v;
                if (out_f64) out_f64[dst_base + ch] = om_i32_to_f64(v, bit_depth);
            }
        }

        f->blk_pos += (uint32_t)want;
        f->frames_decoded += want;
        produced += want;
    }

    return (int)produced;
}

static int flac_seek_frame(om_decoder_t *dec, uint64_t target_frame) {
    flac_priv_t *f = (flac_priv_t *)dec->priv;
    if (!f || !f->fp) return -1;
    if (dec->info.total_frames > 0 && target_frame > dec->info.total_frames) {
        target_frame = dec->info.total_frames;
    }

    uint64_t seek_byte = f->audio_offset;
    uint64_t base_sample = 0;
    for (size_t i = 0; i < f->num_seekpts; i++) {
        if (f->seekpts[i].sample_number != 0xFFFFFFFFFFFFFFFFULL &&
            f->seekpts[i].sample_number <= target_frame) {
            base_sample = f->seekpts[i].sample_number;
            seek_byte = f->audio_offset + f->seekpts[i].stream_offset;
        }
    }

#ifdef _WIN32
    if (_fseeki64(f->fp, (int64_t)seek_byte, SEEK_SET) != 0) return -1;
#else
    if (fseeko(f->fp, (off_t)seek_byte, SEEK_SET) != 0) return -1;
#endif
    flac_br_reset(f);
    f->blk_frames = 0;
    f->blk_pos = 0;
    f->frames_decoded = base_sample;

    while (f->frames_decoded < target_frame) {
        if (!flac_decode_next_block(dec)) break;
        uint64_t rem = target_frame - f->frames_decoded;
        if (rem >= f->blk_frames) {
            f->frames_decoded += f->blk_frames;
            f->blk_pos = f->blk_frames;
        } else {
            f->blk_pos = (uint32_t)rem;
            f->frames_decoded = target_frame;
        }
    }
    return 0;
}

static void flac_close(om_decoder_t *dec) {
    if (!dec || !dec->priv) return;
    flac_priv_t *f = (flac_priv_t *)dec->priv;
    if (f->fp) fclose(f->fp);
    for (int i = 0; i < OM_MAX_CHANNELS; i++) free(f->sub_buf[i]);
    free(f->seekpts);
    free(f);
    dec->priv = NULL;
}

int om_decoder_open_flac(const char *path, om_decoder_t *out_dec, char *err, size_t err_cap) {
    memset(out_dec, 0, sizeof(*out_dec));
    FILE *fp = fopen(path, "rb");
    if (!fp) {
        snprintf(err, err_cap, "Cannot open FLAC file: %s", path);
        return -1;
    }

    uint8_t magic[10];
    if (fread(magic, 1, 4, fp) != 4) {
        fclose(fp);
        snprintf(err, err_cap, "Truncated FLAC file");
        return -1;
    }
    /* Skip optional ID3v2 prefix */
    if (memcmp(magic, "ID3", 3) == 0) {
        if (fread(magic + 4, 1, 6, fp) != 6) {
            fclose(fp);
            snprintf(err, err_cap, "Corrupt ID3 header in FLAC");
            return -1;
        }
        uint32_t id3_sz = ((uint32_t)(magic[6] & 0x7F) << 21) |
                          ((uint32_t)(magic[7] & 0x7F) << 14) |
                          ((uint32_t)(magic[8] & 0x7F) << 7) |
                          (uint32_t)(magic[9] & 0x7F);
        fseek(fp, (long)(10 + id3_sz), SEEK_SET);
        if (fread(magic, 1, 4, fp) != 4) {
            fclose(fp);
            snprintf(err, err_cap, "Missing fLaC marker after ID3");
            return -1;
        }
    }
    if (memcmp(magic, "fLaC", 4) != 0) {
        fclose(fp);
        snprintf(err, err_cap, "Not a valid FLAC stream");
        return -1;
    }

    bool got_streaminfo = false, is_last = false;
    uint32_t sample_rate = 0;
    uint16_t channels = 0, bit_depth = 0;
    uint64_t total_samples = 0;
    flac_seekpoint_t *seekpts = NULL;
    size_t num_seekpts = 0;

    while (!is_last) {
        uint8_t bh[4];
        if (fread(bh, 1, 4, fp) != 4) break;
        is_last = (bh[0] & 0x80U) != 0;
        uint8_t btype = bh[0] & 0x7FU;
        uint32_t blen = ((uint32_t)bh[1] << 16) | ((uint32_t)bh[2] << 8) | (uint32_t)bh[3];

        if (btype == 0 && blen >= 34) {
            uint8_t si[34];
            if (fread(si, 1, 34, fp) != 34) break;
            sample_rate = ((uint32_t)si[10] << 12) | ((uint32_t)si[11] << 4) | ((uint32_t)si[12] >> 4);
            channels = (uint16_t)(((si[12] >> 1) & 0x07U) + 1U);
            bit_depth = (uint16_t)((((si[12] & 1U) << 4) | (si[13] >> 4)) + 1U);
            total_samples = ((uint64_t)(si[13] & 0x0FU) << 32) |
                            ((uint64_t)si[14] << 24) |
                            ((uint64_t)si[15] << 16) |
                            ((uint64_t)si[16] << 8) |
                            (uint64_t)si[17];
            if (blen > 34) fseek(fp, (long)(blen - 34), SEEK_CUR);
            got_streaminfo = true;
        } else if (btype == 3 && blen >= 18 && seekpts == NULL) {
            size_t cnt = blen / 18;
            seekpts = (flac_seekpoint_t *)calloc(cnt, sizeof(*seekpts));
            for (size_t i = 0; i < cnt; i++) {
                uint8_t sp[18];
                if (fread(sp, 1, 18, fp) != 18) break;
                seekpts[i].sample_number =
                    ((uint64_t)sp[0] << 56) | ((uint64_t)sp[1] << 48) |
                    ((uint64_t)sp[2] << 40) | ((uint64_t)sp[3] << 32) |
                    ((uint64_t)sp[4] << 24) | ((uint64_t)sp[5] << 16) |
                    ((uint64_t)sp[6] << 8)  | (uint64_t)sp[7];
                seekpts[i].stream_offset =
                    ((uint64_t)sp[8] << 56) | ((uint64_t)sp[9] << 48) |
                    ((uint64_t)sp[10] << 40)| ((uint64_t)sp[11] << 32) |
                    ((uint64_t)sp[12] << 24)| ((uint64_t)sp[13] << 16) |
                    ((uint64_t)sp[14] << 8) | (uint64_t)sp[15];
                num_seekpts++;
            }
            if (blen % 18) fseek(fp, (long)(blen % 18), SEEK_CUR);
        } else {
            fseek(fp, (long)blen, SEEK_CUR);
        }
    }

    if (!got_streaminfo || sample_rate == 0 || channels == 0 || channels > OM_MAX_CHANNELS) {
        free(seekpts);
        fclose(fp);
        snprintf(err, err_cap, "Invalid FLAC STREAMINFO");
        return -1;
    }

    flac_priv_t *f = (flac_priv_t *)calloc(1, sizeof(*f));
    f->fp = fp;
#ifdef _WIN32
    f->audio_offset = (uint64_t)_ftelli64(fp);
#else
    f->audio_offset = (uint64_t)ftello(fp);
#endif
    f->seekpts = seekpts;
    f->num_seekpts = num_seekpts;
    for (uint16_t ch = 0; ch < channels; ch++) {
        f->sub_buf[ch] = (int64_t *)calloc(FLAC_MAX_BLOCK, sizeof(int64_t));
    }
    flac_br_reset(f);

    out_dec->name = "FLAC";
    out_dec->priv = f;
    out_dec->info.codec = OM_CODEC_FLAC;
    out_dec->info.sample_rate = sample_rate;
    out_dec->info.channels = channels;
    out_dec->info.bit_depth = bit_depth;
    out_dec->info.is_float = false;
    out_dec->info.is_dop = false;
    out_dec->info.total_frames = total_samples;
    out_dec->info.duration_sec = (double)total_samples / (double)sample_rate;
    out_dec->read_frames = flac_read_frames;
    out_dec->seek_frame = flac_seek_frame;
    out_dec->close = flac_close;
    return 0;
}
