#include "audio_formats.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * Clean-room ISO BMFF (.m4a/.mp4) Demuxer + Apple Lossless (ALAC) Decoder.
 * Supports:
 * - Standard 32-bit (`stco`) and 64-bit (`co64`) chunk offset tables
 * - Variable sample sizes (`stsz`) and chunk-to-sample runs (`stsc`)
 * - Both uncompressed ALAC frames (`is_not_compressed == 1`) and compressed
 *   adaptive Golomb-Rice + backward-adaptive FIR LPC frames (`is_not_compressed == 0`),
 *   including 16-bit, 20-bit, 24-bit, and 32-bit stereo/mono streams.
 */

typedef struct {
    uint32_t first_chunk;
    uint32_t samples_per_chunk;
} alac_stsc_t;

typedef struct {
    uint64_t offset;
    uint32_t size;
    uint32_t duration_frames;
} alac_pkt_t;

typedef struct {
    FILE       *fp;
    /* ALACSpecificConfig (24 bytes) */
    uint32_t    frame_length;
    uint8_t     bit_depth;
    uint8_t     pb;
    uint8_t     mb;
    uint8_t     kb;
    uint8_t     num_channels;
    uint32_t    max_frame_bytes;
    uint32_t    sample_rate;

    /* Packet index */
    alac_pkt_t *pkts;
    uint32_t    num_pkts;
    uint32_t    cur_pkt;
    uint64_t    frames_decoded;

    /* Packet buffer & decoded frame staging */
    uint8_t    *pkt_buf;
    size_t      pkt_cap;
    int32_t    *ch_buf[OM_MAX_CHANNELS];
    uint16_t   *extra_buf[OM_MAX_CHANNELS];
    int32_t    *res_buf;
    uint32_t    blk_frames;
    uint32_t    blk_pos;
} alac_priv_t;

typedef struct {
    const uint8_t *data;
    size_t         bit_pos;
    size_t         bit_len;
} alac_br_t;

static uint16_t rd_be16(const uint8_t *p) {
    return (uint16_t)(((uint16_t)p[0] << 8) | p[1]);
}

static uint32_t rd_be32(const uint8_t *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8)  | (uint32_t)p[3];
}

static uint64_t rd_be64(const uint8_t *p) {
    return ((uint64_t)rd_be32(p) << 32) | (uint64_t)rd_be32(p + 4);
}

static inline uint32_t br_peek(const alac_br_t *br, int nbits) {
    if (nbits <= 0 || br->bit_pos >= br->bit_len) return 0;
    size_t byte_idx = br->bit_pos >> 3;
    int bit_off = (int)(br->bit_pos & 7U);
    size_t total_bytes = (br->bit_len + 7U) >> 3;

    uint64_t acc = 0;
    for (int i = 0; i < 5; i++) {
        acc <<= 8;
        if (byte_idx + (size_t)i < total_bytes) {
            acc |= br->data[byte_idx + (size_t)i];
        }
    }
    int shift = 40 - bit_off - nbits;
    uint64_t mask = (nbits == 32) ? 0xFFFFFFFFULL : ((1ULL << nbits) - 1ULL);
    return (uint32_t)((acc >> shift) & mask);
}

static inline uint32_t br_read(alac_br_t *br, int nbits) {
    uint32_t v = br_peek(br, nbits);
    br->bit_pos += (size_t)nbits;
    if (br->bit_pos > br->bit_len) br->bit_pos = br->bit_len;
    return v;
}

static inline int32_t sign_extend_n(uint32_t val, int bits) {
    if (bits >= 32) return (int32_t)val;
    uint32_t shift = (uint32_t)(32 - bits);
    return ((int32_t)(val << shift)) >> shift;
}

static inline int lead_zeros32(uint32_t x) {
    if (x == 0) return 32;
#if defined(__GNUC__) || defined(__clang__)
    return __builtin_clz(x);
#else
    int n = 0;
    while ((x & 0x80000000U) == 0) { n++; x <<= 1; }
    return n;
#endif
}

/* Decode one unsigned ALAC Golomb-Rice value (leading 1s terminated by 0) */
static inline uint32_t alac_dyn_get(alac_br_t *br, uint32_t m, int k, int max_bits, int max_prefix) {
    int prefix = 0;
    while (prefix < max_prefix && br->bit_pos < br->bit_len) {
        if (br_read(br, 1) == 0) break;
        prefix++;
    }
    if (prefix >= max_prefix) {
        return br_read(br, max_bits);
    }
    if (k <= 1) {
        return (uint32_t)prefix;
    }
    uint32_t v = br_peek(br, k);
    if (v > 1U) {
        br->bit_pos += (size_t)k;
        return (uint32_t)prefix * m + v - 1U;
    } else {
        br->bit_pos += (size_t)(k - 1);
        return (uint32_t)prefix * m;
    }
}

static bool alac_rice_decompress(
    alac_br_t *br,
    int32_t *pred_err,
    uint32_t num_samples,
    int bps,
    uint32_t rice_history_mult,
    uint8_t mb0,
    uint8_t kb
) {
    uint32_t history = mb0;
    uint32_t wb = (1U << kb) - 1U;
    int sign_modifier = 0;
    uint32_t i = 0;

    while (i < num_samples) {
        int lg = 31 - lead_zeros32((history >> 9) + 3U);
        int k = (lg > (int)kb) ? (int)kb : (lg < 0 ? 0 : lg);
        uint32_t m = ((1U << k) - 1U) & wb;

        uint32_t x = alac_dyn_get(br, m, k, bps, 9);
        uint32_t n = x + (uint32_t)sign_modifier;
        sign_modifier = 0;

        /* ALAC zig-zag: 0->0, 1->-1, 2->+1, 3->-2, 4->+2 */
        pred_err[i] = (int32_t)((n >> 1) ^ -(int32_t)(n & 1U));

        if (n > 0xFFFFU) {
            history = 0xFFFFU;
        } else {
            history += (n * rice_history_mult) - ((history * rice_history_mult) >> 9);
        }

        i++;
        if (history < 128U && i < num_samples) {
            int kz = lead_zeros32(history) - 24 + (int)((history + 16U) >> 6);
            if (kz > (int)kb) kz = (int)kb;
            if (kz < 0) kz = 0;
            uint32_t mz = (((1U << kz) - 1U) & wb);
            uint32_t zrun = alac_dyn_get(br, mz, kz, 16, 16);
            if (zrun > 0) {
                if (i + zrun > num_samples) zrun = num_samples - i;
                memset(&pred_err[i], 0, zrun * sizeof(int32_t));
                i += zrun;
            }
            history = 0;
            if (zrun <= 0xFFFFU) sign_modifier = 1;
        }
    }
    return true;
}

static inline int alac_sign_of(int32_t v) {
    return (v > 0) - (v < 0);
}

static void alac_lpc_decompress(
    const int32_t *err_in,
    int32_t *out,
    uint32_t num_samples,
    int16_t *coefs,
    uint32_t num_active,
    uint32_t chan_bits,
    uint32_t denshift
) {
    if (num_samples == 0) return;

    out[0] = err_in[0];
    if (num_active == 0) {
        if (num_samples > 1) {
            memcpy(&out[1], &err_in[1], (num_samples - 1) * sizeof(int32_t));
        }
        return;
    }

    if (num_active == 31) {
        /* Simple 1st-order delta predictor */
        for (uint32_t i = 1; i < num_samples; i++) {
            out[i] = sign_extend_n((uint32_t)(out[i - 1] + err_in[i]), (int)chan_bits);
        }
        return;
    }

    uint32_t warm = (num_active < num_samples - 1) ? num_active : (num_samples - 1);
    for (uint32_t i = 1; i <= warm; i++) {
        out[i] = sign_extend_n((uint32_t)(out[i - 1] + err_in[i]), (int)chan_bits);
    }

    int32_t denhalf = (denshift > 0) ? (1 << (denshift - 1)) : 0;

    for (uint32_t i = num_active + 1; i < num_samples; i++) {
        int32_t top = out[i - num_active - 1];
        int64_t sum = 0;
        for (uint32_t j = 0; j < num_active; j++) {
            sum += (int64_t)coefs[j] * (int64_t)(out[i - 1 - j] - top);
        }
        int32_t pred = (int32_t)((sum + denhalf) >> denshift);
        int32_t del = err_in[i];
        out[i] = sign_extend_n((uint32_t)(top + pred + del), (int)chan_bits);

        if (del > 0) {
            for (int j = (int)num_active - 1; j >= 0; j--) {
                int32_t dd = top - out[i - 1 - (uint32_t)j];
                int sgn = alac_sign_of(dd);
                coefs[j] = (int16_t)(coefs[j] - sgn);
                del -= ((sgn * dd) >> denshift) * (int)(num_active - (uint32_t)j);
                if (del <= 0) break;
            }
        } else if (del < 0) {
            for (int j = (int)num_active - 1; j >= 0; j--) {
                int32_t dd = top - out[i - 1 - (uint32_t)j];
                int sgn = -alac_sign_of(dd);
                coefs[j] = (int16_t)(coefs[j] - sgn);
                del -= ((sgn * dd) >> denshift) * (int)(num_active - (uint32_t)j);
                if (del >= 0) break;
            }
        }
    }
}

static bool alac_decode_packet(om_decoder_t *dec) {
    alac_priv_t *a = (alac_priv_t *)dec->priv;
    if (a->cur_pkt >= a->num_pkts) return false;

    alac_pkt_t pkt = a->pkts[a->cur_pkt++];
    if (pkt.size == 0) return false;
    if (pkt.size > a->pkt_cap) {
        a->pkt_cap = pkt.size + 4096;
        a->pkt_buf = (uint8_t *)realloc(a->pkt_buf, a->pkt_cap);
    }

#ifdef _WIN32
    if (_fseeki64(a->fp, (int64_t)pkt.offset, SEEK_SET) != 0) return false;
#else
    if (fseeko(a->fp, (off_t)pkt.offset, SEEK_SET) != 0) return false;
#endif
    if (fread(a->pkt_buf, 1, pkt.size, a->fp) != pkt.size) return false;

    alac_br_t br = { a->pkt_buf, 0, (size_t)pkt.size * 8U };
    uint32_t out_ch_offset = 0;
    uint32_t decoded_samples = 0;

    while (br.bit_pos + 3 <= br.bit_len) {
        uint32_t tag = br_read(&br, 3);
        if (tag == 7U) { /* ID_END */
            break;
        }
        if (tag == 4U) { /* ID_DSE (data stream element) */
            (void)br_read(&br, 4);
            uint32_t align_flag = br_read(&br, 1);
            uint32_t cnt = br_read(&br, 8);
            if (cnt == 255U) cnt += br_read(&br, 8);
            if (align_flag) br.bit_pos = (br.bit_pos + 7U) & ~7ULL;
            br.bit_pos += (size_t)cnt * 8U;
            continue;
        }
        if (tag == 6U) { /* ID_FIL (fill element) */
            uint32_t cnt = br_read(&br, 4);
            if (cnt == 15U) cnt += br_read(&br, 8) - 1U;
            br.bit_pos += (size_t)cnt * 8U;
            continue;
        }
        if (tag != 0U && tag != 1U) {
            return false;
        }

        uint32_t elem_ch = (tag == 0U) ? 1U : 2U;
        if (out_ch_offset + elem_ch > dec->info.channels) return false;

        (void)br_read(&br, 4);  /* element_instance_tag */
        (void)br_read(&br, 12); /* unused header bits */
        uint32_t has_size = br_read(&br, 1);
        uint32_t extra_bytes = br_read(&br, 2);
        uint32_t is_uncompressed = br_read(&br, 1);

        uint32_t nsamples = has_size ? br_read(&br, 32) : a->frame_length;
        if (nsamples == 0 || nsamples > a->frame_length * 2U) return false;

        if (is_uncompressed) {
            int bps = (int)a->bit_depth;
            for (uint32_t i = 0; i < nsamples; i++) {
                for (uint32_t c = 0; c < elem_ch; c++) {
                    uint32_t raw = br_read(&br, bps);
                    a->ch_buf[out_ch_offset + c][i] = sign_extend_n(raw, bps);
                }
            }
        } else {
            uint8_t interlacing_shift = (uint8_t)br_read(&br, 8);
            uint8_t interlacing_leftweight = (uint8_t)br_read(&br, 8);

            uint32_t pred_type[2] = {0}, lpc_quant[2] = {0}, rice_mod[2] = {0}, num_coefs[2] = {0};
            int16_t coefs[2][32];
            memset(coefs, 0, sizeof(coefs));

            for (uint32_t c = 0; c < elem_ch; c++) {
                pred_type[c] = br_read(&br, 4);
                lpc_quant[c] = br_read(&br, 4);
                rice_mod[c]  = br_read(&br, 3);
                num_coefs[c] = br_read(&br, 5);
                for (uint32_t k = 0; k < num_coefs[c]; k++) {
                    coefs[c][k] = (int16_t)br_read(&br, 16);
                }
            }

            if (extra_bytes > 0) {
                int ebits = (int)(extra_bytes * 8U);
                for (uint32_t i = 0; i < nsamples; i++) {
                    for (uint32_t c = 0; c < elem_ch; c++) {
                        a->extra_buf[out_ch_offset + c][i] = (uint16_t)br_read(&br, ebits);
                    }
                }
            }

            uint32_t chan_bits = (uint32_t)a->bit_depth - (extra_bytes * 8U) + (elem_ch - 1U);

            for (uint32_t c = 0; c < elem_ch; c++) {
                uint32_t mult = (rice_mod[c] * a->pb) / 4U;
                if (!alac_rice_decompress(&br, a->res_buf, nsamples, (int)chan_bits, mult, a->mb, a->kb)) {
                    return false;
                }
                if (pred_type[c] == 15U) {
                    /* Two-pass: 1st-order delta pass followed by LPC pass */
                    alac_lpc_decompress(a->res_buf, a->ch_buf[out_ch_offset + c], nsamples, NULL, 31, chan_bits, 0);
                    memcpy(a->res_buf, a->ch_buf[out_ch_offset + c], nsamples * sizeof(int32_t));
                }
                alac_lpc_decompress(
                    a->res_buf,
                    a->ch_buf[out_ch_offset + c],
                    nsamples,
                    coefs[c],
                    num_coefs[c],
                    chan_bits,
                    lpc_quant[c]
                );
            }

            /* Stereo mid-side decorrelation */
            if (elem_ch == 2U && interlacing_leftweight != 0) {
                int32_t *u0 = a->ch_buf[out_ch_offset];
                int32_t *u1 = a->ch_buf[out_ch_offset + 1];
                for (uint32_t i = 0; i < nsamples; i++) {
                    int32_t mid = u0[i];
                    int32_t side = u1[i];
                    int32_t right = mid - ((side * (int32_t)interlacing_leftweight) >> interlacing_shift);
                    int32_t left = right + side;
                    u0[i] = left;
                    u1[i] = right;
                }
            }

            /* Re-attach uncompressed lower bits for 20/24/32-bit streams */
            if (extra_bytes > 0) {
                uint32_t shift = extra_bytes * 8U;
                for (uint32_t c = 0; c < elem_ch; c++) {
                    int32_t *chp = a->ch_buf[out_ch_offset + c];
                    uint16_t *ext = a->extra_buf[out_ch_offset + c];
                    for (uint32_t i = 0; i < nsamples; i++) {
                        chp[i] = (int32_t)(((uint32_t)chp[i] << shift) | (uint32_t)ext[i]);
                    }
                }
            }
        }

        decoded_samples = nsamples;
        out_ch_offset += elem_ch;
    }

    if (decoded_samples == 0) return false;
    if (pkt.duration_frames > 0 && pkt.duration_frames < decoded_samples) {
        decoded_samples = pkt.duration_frames;
    }
    a->blk_frames = decoded_samples;
    a->blk_pos = 0;
    return true;
}

static int alac_read_frames(om_decoder_t *dec, int32_t *out_i32, double *out_f64, size_t max_frames) {
    alac_priv_t *a = (alac_priv_t *)dec->priv;
    if (!a || !a->fp || max_frames == 0) return 0;

    uint16_t channels = dec->info.channels;
    uint16_t bit_depth = dec->info.bit_depth;
    size_t produced = 0;

    while (produced < max_frames) {
        if (dec->info.total_frames > 0 && a->frames_decoded >= dec->info.total_frames) break;
        if (a->blk_pos >= a->blk_frames) {
            if (!alac_decode_packet(dec)) break;
        }

        uint32_t avail = a->blk_frames - a->blk_pos;
        size_t want = max_frames - produced;
        if (avail < want) want = avail;

        for (size_t i = 0; i < want; i++) {
            uint32_t sidx = a->blk_pos + (uint32_t)i;
            size_t dbase = (produced + i) * channels;
            for (uint16_t ch = 0; ch < channels; ch++) {
                int32_t v = a->ch_buf[ch][sidx];
                if (out_i32) out_i32[dbase + ch] = v;
                if (out_f64) out_f64[dbase + ch] = om_i32_to_f64(v, bit_depth);
            }
        }
        a->blk_pos += (uint32_t)want;
        a->frames_decoded += want;
        produced += want;
    }
    return (int)produced;
}

static int alac_seek_frame(om_decoder_t *dec, uint64_t target_frame) {
    alac_priv_t *a = (alac_priv_t *)dec->priv;
    if (!a || !a->fp) return -1;
    if (target_frame > dec->info.total_frames) target_frame = dec->info.total_frames;

    uint64_t acc = 0;
    uint32_t pkt_idx = 0;
    while (pkt_idx < a->num_pkts) {
        uint32_t dur = a->pkts[pkt_idx].duration_frames ? a->pkts[pkt_idx].duration_frames : a->frame_length;
        if (acc + dur > target_frame) break;
        acc += dur;
        pkt_idx++;
    }

    a->cur_pkt = pkt_idx;
    a->blk_frames = 0;
    a->blk_pos = 0;
    a->frames_decoded = acc;

    if (acc < target_frame && pkt_idx < a->num_pkts) {
        if (alac_decode_packet(dec)) {
            uint32_t skip = (uint32_t)(target_frame - acc);
            if (skip > a->blk_frames) skip = a->blk_frames;
            a->blk_pos = skip;
            a->frames_decoded += skip;
        }
    }
    return 0;
}

static void alac_close(om_decoder_t *dec) {
    if (!dec || !dec->priv) return;
    alac_priv_t *a = (alac_priv_t *)dec->priv;
    if (a->fp) fclose(a->fp);
    free(a->pkts);
    free(a->pkt_buf);
    free(a->res_buf);
    for (int i = 0; i < OM_MAX_CHANNELS; i++) {
        free(a->ch_buf[i]);
        free(a->extra_buf[i]);
    }
    free(a);
    dec->priv = NULL;
}

/* Temporary ISO BMFF stbl parsing context */
typedef struct {
    bool         got_alac_cfg;
    uint8_t      alac_cfg[24];
    uint32_t    *stts_cnt;
    uint32_t    *stts_dur;
    uint32_t     stts_len;
    alac_stsc_t *stsc;
    uint32_t     stsc_len;
    uint32_t     fixed_sample_size;
    uint32_t    *sample_sizes;
    uint32_t     num_samples;
    uint64_t    *chunk_offsets;
    uint32_t     num_chunks;
} mp4_parse_ctx_t;

static void mp4_walk_boxes(FILE *fp, uint64_t start, uint64_t end, mp4_parse_ctx_t *ctx, int depth) {
    if (depth > 12) return;
    uint64_t pos = start;

    while (pos + 8 <= end) {
#ifdef _WIN32
        if (_fseeki64(fp, (int64_t)pos, SEEK_SET) != 0) break;
#else
        if (fseeko(fp, (off_t)pos, SEEK_SET) != 0) break;
#endif
        uint8_t hdr[16];
        if (fread(hdr, 1, 8, fp) != 8) break;
        uint64_t bsize = rd_be32(hdr);
        uint8_t *btype = hdr + 4;
        uint64_t hlen = 8;

        if (bsize == 1) {
            if (fread(hdr + 8, 1, 8, fp) != 8) break;
            bsize = rd_be64(hdr + 8);
            hlen = 16;
        } else if (bsize == 0) {
            bsize = end - pos;
        }
        if (bsize < hlen || pos + bsize > end) break;

        uint64_t payload = pos + hlen;
        uint64_t box_end = pos + bsize;

        if (memcmp(btype, "moov", 4) == 0 || memcmp(btype, "trak", 4) == 0 ||
            memcmp(btype, "mdia", 4) == 0 || memcmp(btype, "minf", 4) == 0 ||
            memcmp(btype, "stbl", 4) == 0) {
            mp4_walk_boxes(fp, payload, box_end, ctx, depth + 1);
        } else if (memcmp(btype, "stsd", 4) == 0 && bsize >= hlen + 16) {
            uint8_t buf[256];
            size_t rlen = (size_t)((box_end - payload) < sizeof(buf) ? (box_end - payload) : sizeof(buf));
            if (fread(buf, 1, rlen, fp) == rlen && rlen >= 44) {
                /* Scan inside stsd for nested 'alac' specific config box (size >= 36) */
                for (size_t off = 16; off + 36 <= rlen; off++) {
                    if (memcmp(buf + off + 4, "alac", 4) == 0) {
                        uint32_t sub_sz = rd_be32(buf + off);
                        if (sub_sz >= 36 && off + 12 + 24 <= rlen) {
                            memcpy(ctx->alac_cfg, buf + off + 12, 24);
                            ctx->got_alac_cfg = true;
                            break;
                        }
                    }
                }
            }
        } else if (memcmp(btype, "stts", 4) == 0 && !ctx->stts_cnt && bsize >= hlen + 8) {
            uint8_t h8[8];
            if (fread(h8, 1, 8, fp) == 8) {
                uint32_t cnt = rd_be32(h8 + 4);
                if ((uint64_t)cnt * 8ULL <= (box_end - payload - 8ULL)) {
                    ctx->stts_cnt = (uint32_t *)calloc(cnt, sizeof(uint32_t));
                    ctx->stts_dur = (uint32_t *)calloc(cnt, sizeof(uint32_t));
                    ctx->stts_len = cnt;
                    for (uint32_t i = 0; i < cnt; i++) {
                        uint8_t e[8];
                        if (fread(e, 1, 8, fp) != 8) break;
                        ctx->stts_cnt[i] = rd_be32(e);
                        ctx->stts_dur[i] = rd_be32(e + 4);
                    }
                }
            }
        } else if (memcmp(btype, "stsc", 4) == 0 && !ctx->stsc && bsize >= hlen + 8) {
            uint8_t h8[8];
            if (fread(h8, 1, 8, fp) == 8) {
                uint32_t cnt = rd_be32(h8 + 4);
                if ((uint64_t)cnt * 12ULL <= (box_end - payload - 8ULL)) {
                    ctx->stsc = (alac_stsc_t *)calloc(cnt, sizeof(alac_stsc_t));
                    ctx->stsc_len = cnt;
                    for (uint32_t i = 0; i < cnt; i++) {
                        uint8_t e[12];
                        if (fread(e, 1, 12, fp) != 12) break;
                        ctx->stsc[i].first_chunk = rd_be32(e);
                        ctx->stsc[i].samples_per_chunk = rd_be32(e + 4);
                    }
                }
            }
        } else if (memcmp(btype, "stsz", 4) == 0 && !ctx->sample_sizes && bsize >= hlen + 12) {
            uint8_t h12[12];
            if (fread(h12, 1, 12, fp) == 12) {
                ctx->fixed_sample_size = rd_be32(h12 + 4);
                uint32_t cnt = rd_be32(h12 + 8);
                ctx->num_samples = cnt;
                if (ctx->fixed_sample_size == 0 && (uint64_t)cnt * 4ULL <= (box_end - payload - 12ULL)) {
                    ctx->sample_sizes = (uint32_t *)calloc(cnt, sizeof(uint32_t));
                    for (uint32_t i = 0; i < cnt; i++) {
                        uint8_t e[4];
                        if (fread(e, 1, 4, fp) != 4) break;
                        ctx->sample_sizes[i] = rd_be32(e);
                    }
                }
            }
        } else if (memcmp(btype, "stco", 4) == 0 && !ctx->chunk_offsets && bsize >= hlen + 8) {
            uint8_t h8[8];
            if (fread(h8, 1, 8, fp) == 8) {
                uint32_t cnt = rd_be32(h8 + 4);
                if ((uint64_t)cnt * 4ULL <= (box_end - payload - 8ULL)) {
                    ctx->chunk_offsets = (uint64_t *)calloc(cnt, sizeof(uint64_t));
                    ctx->num_chunks = cnt;
                    for (uint32_t i = 0; i < cnt; i++) {
                        uint8_t e[4];
                        if (fread(e, 1, 4, fp) != 4) break;
                        ctx->chunk_offsets[i] = rd_be32(e);
                    }
                }
            }
        } else if (memcmp(btype, "co64", 4) == 0 && !ctx->chunk_offsets && bsize >= hlen + 8) {
            uint8_t h8[8];
            if (fread(h8, 1, 8, fp) == 8) {
                uint32_t cnt = rd_be32(h8 + 4);
                if ((uint64_t)cnt * 8ULL <= (box_end - payload - 8ULL)) {
                    ctx->chunk_offsets = (uint64_t *)calloc(cnt, sizeof(uint64_t));
                    ctx->num_chunks = cnt;
                    for (uint32_t i = 0; i < cnt; i++) {
                        uint8_t e[8];
                        if (fread(e, 1, 8, fp) != 8) break;
                        ctx->chunk_offsets[i] = rd_be64(e);
                    }
                }
            }
        }

        pos = box_end;
    }
}

static void mp4_ctx_free(mp4_parse_ctx_t *ctx) {
    free(ctx->stts_cnt);
    free(ctx->stts_dur);
    free(ctx->stsc);
    free(ctx->sample_sizes);
    free(ctx->chunk_offsets);
}

int om_decoder_open_alac(const char *path, om_decoder_t *out_dec, char *err, size_t err_cap) {
    memset(out_dec, 0, sizeof(*out_dec));
    FILE *fp = fopen(path, "rb");
    if (!fp) {
        snprintf(err, err_cap, "Cannot open ALAC/M4A file: %s", path);
        return -1;
    }

#ifdef _WIN32
    _fseeki64(fp, 0, SEEK_END);
    uint64_t file_size = (uint64_t)_ftelli64(fp);
    _fseeki64(fp, 0, SEEK_SET);
#else
    fseeko(fp, 0, SEEK_END);
    uint64_t file_size = (uint64_t)ftello(fp);
    fseeko(fp, 0, SEEK_SET);
#endif

    mp4_parse_ctx_t ctx;
    memset(&ctx, 0, sizeof(ctx));
    mp4_walk_boxes(fp, 0, file_size, &ctx, 0);

    if (!ctx.got_alac_cfg || ctx.num_samples == 0 || ctx.num_chunks == 0 || ctx.stsc_len == 0) {
        mp4_ctx_free(&ctx);
        fclose(fp);
        snprintf(err, err_cap, "Missing ALAC configuration or MP4 sample table");
        return -1;
    }

    uint32_t frame_length = rd_be32(ctx.alac_cfg + 0);
    uint8_t  bit_depth    = ctx.alac_cfg[5];
    uint8_t  pb           = ctx.alac_cfg[6];
    uint8_t  mb           = ctx.alac_cfg[7];
    uint8_t  kb           = ctx.alac_cfg[8];
    uint8_t  channels     = ctx.alac_cfg[9];
    uint32_t max_frm_sz   = rd_be32(ctx.alac_cfg + 12);
    uint32_t sample_rate  = rd_be32(ctx.alac_cfg + 20);
    (void)rd_be16;

    if (frame_length == 0) frame_length = 4096;
    if (channels == 0 || channels > OM_MAX_CHANNELS || sample_rate == 0 ||
        (bit_depth != 16 && bit_depth != 20 && bit_depth != 24 && bit_depth != 32)) {
        mp4_ctx_free(&ctx);
        fclose(fp);
        snprintf(err, err_cap, "Unsupported ALAC stream (%u ch, %u-bit, %u Hz)", channels, bit_depth, sample_rate);
        return -1;
    }

    alac_pkt_t *pkts = (alac_pkt_t *)calloc(ctx.num_samples, sizeof(alac_pkt_t));
    uint32_t s_idx = 0;
    for (uint32_t st = 0; st < ctx.stsc_len && s_idx < ctx.num_samples; st++) {
        uint32_t c_start = ctx.stsc[st].first_chunk - 1U;
        uint32_t c_end = (st + 1 < ctx.stsc_len) ? (ctx.stsc[st + 1].first_chunk - 1U) : ctx.num_chunks;
        if (c_end > ctx.num_chunks) c_end = ctx.num_chunks;

        for (uint32_t c = c_start; c < c_end && s_idx < ctx.num_samples; c++) {
            uint64_t off = ctx.chunk_offsets[c];
            for (uint32_t k = 0; k < ctx.stsc[st].samples_per_chunk && s_idx < ctx.num_samples; k++) {
                uint32_t sz = ctx.fixed_sample_size ? ctx.fixed_sample_size : ctx.sample_sizes[s_idx];
                pkts[s_idx].offset = off;
                pkts[s_idx].size = sz;
                pkts[s_idx].duration_frames = frame_length;
                off += sz;
                s_idx++;
            }
        }
    }

    uint64_t total_frames = 0;
    uint32_t p_cursor = 0;
    for (uint32_t i = 0; i < ctx.stts_len; i++) {
        for (uint32_t j = 0; j < ctx.stts_cnt[i] && p_cursor < s_idx; j++) {
            pkts[p_cursor].duration_frames = ctx.stts_dur[i];
            total_frames += ctx.stts_dur[i];
            p_cursor++;
        }
    }
    if (total_frames == 0) total_frames = (uint64_t)s_idx * frame_length;
    mp4_ctx_free(&ctx);

    alac_priv_t *a = (alac_priv_t *)calloc(1, sizeof(*a));
    a->fp = fp;
    a->frame_length = frame_length;
    a->bit_depth = bit_depth;
    a->pb = pb ? pb : 40;
    a->mb = mb ? mb : 10;
    a->kb = kb ? kb : 14;
    a->num_channels = channels;
    a->max_frame_bytes = max_frm_sz ? max_frm_sz : (frame_length * channels * 4U + 1024U);
    a->sample_rate = sample_rate;
    a->pkts = pkts;
    a->num_pkts = s_idx;
    a->pkt_cap = a->max_frame_bytes + 4096U;
    a->pkt_buf = (uint8_t *)malloc(a->pkt_cap);
    a->res_buf = (int32_t *)calloc(frame_length * 2U, sizeof(int32_t));
    for (uint8_t ch = 0; ch < channels; ch++) {
        a->ch_buf[ch] = (int32_t *)calloc(frame_length * 2U, sizeof(int32_t));
        a->extra_buf[ch] = (uint16_t *)calloc(frame_length * 2U, sizeof(uint16_t));
    }

    out_dec->name = "ALAC";
    out_dec->priv = a;
    out_dec->info.codec = OM_CODEC_ALAC;
    out_dec->info.sample_rate = sample_rate;
    out_dec->info.channels = channels;
    out_dec->info.bit_depth = bit_depth;
    out_dec->info.is_float = false;
    out_dec->info.is_dop = false;
    out_dec->info.total_frames = total_frames;
    out_dec->info.duration_sec = (double)total_frames / (double)sample_rate;
    out_dec->read_frames = alac_read_frames;
    out_dec->seek_frame = alac_seek_frame;
    out_dec->close = alac_close;
    return 0;
}
