#include "audio_formats.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/*
 * Clean-room Ultra-Hi-Res 1-bit DSD (.dsf Sony & .dff DSDIFF) decoder:
 * Supports DSD64 (2.8224 MHz), DSD128 (5.6448 MHz), DSD256 (11.2896 MHz),
 * DSD512 (22.5792 MHz), and DSD1024 (45.1584 MHz).
 *
 * Output Modes:
 * - OM_DSD_MODE_PCM: 128-tap Blackman-Harris low-pass FIR (~28 kHz corner)
 *   evaluated via 16-stage byte lookup tables + 128-bit shift registers (zero memmove!),
 *   decimating 16:1 (DSD64/128), 32:1 (DSD256), 64:1 (DSD512), or 128:1 (DSD1024 -> 352.8 kHz).
 * - OM_DSD_MODE_DOP: Packs 16 DSD bits (2 MSB-ordered bytes) per channel into 24-bit DoP
 *   words with alternating 0x05 / 0xFA markers at dsd_rate / 16.
 * - OM_DSD_MODE_NATIVE: Packs 32 raw MSB-ordered DSD bits (4 bytes) per channel per frame
 *   for zero-overhead ASIO Native DSD Direct hardware playback at dsd_rate / 32.
 */

#define DFF_CACHE_FRAMES 32768U

typedef struct {
    FILE         *fp;
    bool          is_dsf;          /* true = DSF (block-interleaved), false = DFF (byte-interleaved) */
    bool          lsb_first;       /* true when DSF bits_per_sample == 1 */
    om_dsd_mode_t dsd_mode;
    uint8_t       dop_marker;      /* Alternates 0x05 <-> 0xFA per frame */
    uint32_t      dsd_rate;
    uint32_t      block_size_ch;   /* DSF bytes per channel block (usually 4096) */
    uint64_t      data_offset;
    uint64_t      data_bytes;
    uint64_t      total_dsd_bytes_per_ch;
    uint64_t      cur_dsd_byte_per_ch;

    /* Block / stream I/O cache (used by both DSF and DFF to eliminate per-byte syscalls) */
    uint8_t      *block_buf;
    uint32_t      block_pos;       /* Current frame/byte index inside block_buf */
    uint32_t      block_frames;    /* Valid frames currently buffered in block_buf */
    bool          block_valid;

    /* 128-tap FIR decimation state per channel: 16 history bytes in two 64-bit shift registers */
    uint64_t      hist_hi[OM_MAX_CHANNELS];
    uint64_t      hist_lo[OM_MAX_CHANNELS];
    double        fir_lut[16][256];
    uint8_t       bit_rev[256];
    uint32_t      decim_bytes;     /* 2=16:1, 4=32:1, 8=64:1 (DSD512), 16=128:1 (DSD1024) */
} dsd_priv_t;

static inline uint32_t dsd_u32_le(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static inline uint64_t dsd_u64_le(const uint8_t *p) {
    return (uint64_t)dsd_u32_le(p) | ((uint64_t)dsd_u32_le(p + 4) << 32);
}

static inline uint32_t dsd_u32_be(const uint8_t *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

static inline uint64_t dsd_u64_be(const uint8_t *p) {
    return ((uint64_t)dsd_u32_be(p) << 32) | (uint64_t)dsd_u32_be(p + 4);
}

static void dsd_reset_history(dsd_priv_t *d) {
    for (int ch = 0; ch < OM_MAX_CHANNELS; ch++) {
        /* 0x69 = 01101001b -> balanced 50% density = exact 0.0 DC silence in 1-bit DSD */
        d->hist_hi[ch] = 0x6969696969696969ULL;
        d->hist_lo[ch] = 0x6969696969696969ULL;
    }
}

static void dsd_init_tables(dsd_priv_t *d) {
    for (int b = 0; b < 256; b++) {
        uint8_t r = 0;
        for (int k = 0; k < 8; k++) {
            if (b & (1 << k)) r |= (uint8_t)(1 << (7 - k));
        }
        d->bit_rev[b] = r;
    }

    /*
     * Design normalized 128-tap 4-term Blackman-Harris low-pass FIR (~28 kHz cutoff,
     * >92 dB sidelobe rejection to strip Sigma-Delta ultrasonic quantization noise
     * across DSD64 through DSD1024).
     */
    double taps[128];
    double fc = 28000.0 / (double)d->dsd_rate;
    if (fc > 0.20) fc = 0.20;
    double sum = 0.0;
    for (int n = 0; n < 128; n++) {
        double m = (double)n - 63.5;
        double sinc = (fabs(m) < 1e-9) ? (2.0 * fc) : (sin(2.0 * M_PI * fc * m) / (M_PI * m));
        double w = 0.35875
                 - 0.48829 * cos(2.0 * M_PI * (double)n / 127.0)
                 + 0.14128 * cos(4.0 * M_PI * (double)n / 127.0)
                 - 0.01168 * cos(6.0 * M_PI * (double)n / 127.0);
        taps[n] = sinc * w;
        sum += taps[n];
    }

    /* SACD/DSD standard 0 dB SACD reference is 50% modulation index (+6 dB headroom -> * 1.6) */
    double norm = (sum > 0.0) ? (1.6 / sum) : (1.0 / 128.0);
    for (int n = 0; n < 128; n++) taps[n] *= norm;

    /* Precompute 16 byte-tables over MSB-first bytes: bit 7 is oldest in byte, bit 0 is newest */
    for (int stage = 0; stage < 16; stage++) {
        for (int byte_val = 0; byte_val < 256; byte_val++) {
            double acc = 0.0;
            for (int bit = 0; bit < 8; bit++) {
                int tap_idx = stage * 8 + bit;
                double s = ((byte_val >> (7 - bit)) & 1) ? 1.0 : -1.0;
                acc += s * taps[tap_idx];
            }
            d->fir_lut[stage][byte_val] = acc;
        }
    }

    dsd_reset_history(d);
}

/* Fetch 1 MSB-first DSD byte per channel at current position using buffered block reads */
static inline bool dsd_next_msb_bytes(dsd_priv_t * restrict d, uint16_t channels, uint8_t * restrict out_bytes) {
    if (d->cur_dsd_byte_per_ch >= d->total_dsd_bytes_per_ch) return false;

    if (d->is_dsf) {
        if (!d->block_valid || d->block_pos >= d->block_frames) {
            size_t blk_total = (size_t)d->block_size_ch * channels;
            size_t got = fread(d->block_buf, 1, blk_total, d->fp);
            if (got < channels) return false;
            d->block_pos = 0;
            d->block_frames = d->block_size_ch;
            d->block_valid = true;
        }
        if (d->lsb_first) {
            for (uint16_t ch = 0; ch < channels; ch++) {
                uint8_t raw = d->block_buf[(size_t)ch * d->block_size_ch + d->block_pos];
                out_bytes[ch] = d->bit_rev[raw];
            }
        } else {
            for (uint16_t ch = 0; ch < channels; ch++) {
                out_bytes[ch] = d->block_buf[(size_t)ch * d->block_size_ch + d->block_pos];
            }
        }
        d->block_pos++;
    } else {
        if (!d->block_valid || d->block_pos >= d->block_frames) {
            uint64_t rem = d->total_dsd_bytes_per_ch - d->cur_dsd_byte_per_ch;
            size_t want_frames = (rem < DFF_CACHE_FRAMES) ? (size_t)rem : (size_t)DFF_CACHE_FRAMES;
            size_t got_bytes = fread(d->block_buf, 1, want_frames * channels, d->fp);
            size_t got_frames = got_bytes / channels;
            if (got_frames == 0) return false;
            d->block_pos = 0;
            d->block_frames = (uint32_t)got_frames;
            d->block_valid = true;
        }
        const uint8_t *src = d->block_buf + (size_t)d->block_pos * channels;
        for (uint16_t ch = 0; ch < channels; ch++) {
            out_bytes[ch] = src[ch]; /* DSDIFF is already MSB-first */
        }
        d->block_pos++;
    }

    d->cur_dsd_byte_per_ch++;
    return true;
}

static inline double dsd_eval_fir128(const dsd_priv_t * restrict d, uint64_t hi, uint64_t lo) {
    double s0 = d->fir_lut[0][(hi >> 56) & 0xFFU] + d->fir_lut[1][(hi >> 48) & 0xFFU]
              + d->fir_lut[2][(hi >> 40) & 0xFFU] + d->fir_lut[3][(hi >> 32) & 0xFFU];
    double s1 = d->fir_lut[4][(hi >> 24) & 0xFFU] + d->fir_lut[5][(hi >> 16) & 0xFFU]
              + d->fir_lut[6][(hi >>  8) & 0xFFU] + d->fir_lut[7][ hi        & 0xFFU];
    double s2 = d->fir_lut[8][(lo >> 56) & 0xFFU] + d->fir_lut[9][(lo >> 48) & 0xFFU]
              + d->fir_lut[10][(lo >> 40) & 0xFFU] + d->fir_lut[11][(lo >> 32) & 0xFFU];
    double s3 = d->fir_lut[12][(lo >> 24) & 0xFFU] + d->fir_lut[13][(lo >> 16) & 0xFFU]
              + d->fir_lut[14][(lo >>  8) & 0xFFU] + d->fir_lut[15][ lo        & 0xFFU];
    double sum = (s0 + s1) + (s2 + s3);
    if (sum > 1.0) sum = 1.0;
    if (sum < -1.0) sum = -1.0;
    return sum;
}

static int dsd_read_frames(om_decoder_t *dec, int32_t * restrict out_i32, double * restrict out_f64, size_t max_frames) {
    dsd_priv_t * restrict d = (dsd_priv_t *)dec->priv;
    if (!d || !d->fp || max_frames == 0) return 0;

    const uint16_t channels = dec->info.channels;
    size_t produced = 0;

    if (d->dsd_mode == OM_DSD_MODE_DOP) {
        while (produced < max_frames) {
            uint8_t b0[OM_MAX_CHANNELS], b1[OM_MAX_CHANNELS];
            if (!dsd_next_msb_bytes(d, channels, b0)) break;
            if (!dsd_next_msb_bytes(d, channels, b1)) break;

            uint32_t marker = d->dop_marker;
            d->dop_marker = (marker == 0x05U) ? 0xFAU : 0x05U;

            for (uint16_t ch = 0; ch < channels; ch++) {
                uint32_t word24 = (marker << 16) | ((uint32_t)b0[ch] << 8) | (uint32_t)b1[ch];
                int32_t signed24 = (word24 & 0x800000U) ? (int32_t)(word24 | 0xFF000000U) : (int32_t)word24;
                size_t idx = produced * channels + ch;
                if (out_i32) out_i32[idx] = signed24;
                if (out_f64) out_f64[idx] = (double)signed24 * (1.0 / 8388608.0);
            }
            produced++;
        }
        return (int)produced;
    }

    if (d->dsd_mode == OM_DSD_MODE_NATIVE) {
        /* Pack 4 MSB-first DSD bytes (32 1-bit samples) per int32 word for ASIO DSD Direct */
        while (produced < max_frames) {
            uint8_t b0[OM_MAX_CHANNELS], b1[OM_MAX_CHANNELS], b2[OM_MAX_CHANNELS], b3[OM_MAX_CHANNELS];
            if (!dsd_next_msb_bytes(d, channels, b0)) break;
            if (!dsd_next_msb_bytes(d, channels, b1)) break;
            if (!dsd_next_msb_bytes(d, channels, b2)) break;
            if (!dsd_next_msb_bytes(d, channels, b3)) break;

            for (uint16_t ch = 0; ch < channels; ch++) {
                uint32_t word32 = ((uint32_t)b0[ch] << 24) | ((uint32_t)b1[ch] << 16)
                                | ((uint32_t)b2[ch] << 8)  | (uint32_t)b3[ch];
                size_t idx = produced * channels + ch;
                if (out_i32) out_i32[idx] = (int32_t)word32;
                if (out_f64) out_f64[idx] = 0.0;
            }
            produced++;
        }
        return (int)produced;
    }

    /* Fast Stereo Fast-Path for 128-tap PCM FIR Decimation (DSD64 .. DSD1024) */
    const uint32_t decim_bytes = d->decim_bytes;
    if (channels == 2) {
        uint64_t hiL = d->hist_hi[0], loL = d->hist_lo[0];
        uint64_t hiR = d->hist_hi[1], loR = d->hist_lo[1];
        uint8_t step_b[2];

        while (produced < max_frames) {
            bool ok = true;
            for (uint32_t k = 0; k < decim_bytes; k++) {
                if (!dsd_next_msb_bytes(d, 2, step_b)) {
                    ok = false;
                    break;
                }
                hiL = (hiL << 8) | (loL >> 56);
                loL = (loL << 8) | (uint64_t)step_b[0];
                hiR = (hiR << 8) | (loR >> 56);
                loR = (loR << 8) | (uint64_t)step_b[1];
            }
            if (!ok) break;

            double sumL = dsd_eval_fir128(d, hiL, loL);
            double sumR = dsd_eval_fir128(d, hiR, loR);
            size_t base = produced * 2U;
            if (out_f64) {
                out_f64[base + 0] = sumL;
                out_f64[base + 1] = sumR;
            }
            if (out_i32) {
                out_i32[base + 0] = om_f64_to_i32(sumL, 24);
                out_i32[base + 1] = om_f64_to_i32(sumR, 24);
            }
            produced++;
        }

        d->hist_hi[0] = hiL; d->hist_lo[0] = loL;
        d->hist_hi[1] = hiR; d->hist_lo[1] = loR;
        return (int)produced;
    }

    /* General N-channel PCM FIR Decimation */
    while (produced < max_frames) {
        uint8_t step_b[OM_MAX_CHANNELS];
        bool ok = true;
        for (uint32_t k = 0; k < decim_bytes; k++) {
            if (!dsd_next_msb_bytes(d, channels, step_b)) {
                ok = false;
                break;
            }
            for (uint16_t ch = 0; ch < channels; ch++) {
                uint64_t hi = d->hist_hi[ch];
                uint64_t lo = d->hist_lo[ch];
                d->hist_hi[ch] = (hi << 8) | (lo >> 56);
                d->hist_lo[ch] = (lo << 8) | (uint64_t)step_b[ch];
            }
        }
        if (!ok) break;

        for (uint16_t ch = 0; ch < channels; ch++) {
            double sum = dsd_eval_fir128(d, d->hist_hi[ch], d->hist_lo[ch]);
            size_t idx = produced * channels + ch;
            if (out_f64) out_f64[idx] = sum;
            if (out_i32) out_i32[idx] = om_f64_to_i32(sum, 24);
        }
        produced++;
    }

    return (int)produced;
}

static uint32_t dsd_bytes_per_out_frame(const dsd_priv_t *d) {
    if (d->dsd_mode == OM_DSD_MODE_DOP) return 2U;
    if (d->dsd_mode == OM_DSD_MODE_NATIVE) return 4U;
    return d->decim_bytes;
}

static int dsd_seek_frame(om_decoder_t *dec, uint64_t target_frame) {
    dsd_priv_t *d = (dsd_priv_t *)dec->priv;
    if (!d || !d->fp) return -1;

    uint32_t bytes_per_out = dsd_bytes_per_out_frame(d);
    uint64_t target_dsd_byte = target_frame * bytes_per_out;
    if (target_dsd_byte > d->total_dsd_bytes_per_ch) {
        target_dsd_byte = d->total_dsd_bytes_per_ch;
    }

    uint16_t ch = dec->info.channels;
    if (d->is_dsf) {
        uint64_t blk_idx = target_dsd_byte / d->block_size_ch;
        uint32_t in_blk = (uint32_t)(target_dsd_byte % d->block_size_ch);
        uint64_t file_pos = d->data_offset + blk_idx * (uint64_t)d->block_size_ch * ch;
#ifdef _WIN32
        if (_fseeki64(d->fp, (int64_t)file_pos, SEEK_SET) != 0) return -1;
#else
        if (fseeko(d->fp, (off_t)file_pos, SEEK_SET) != 0) return -1;
#endif
        d->block_valid = false;
        d->cur_dsd_byte_per_ch = blk_idx * d->block_size_ch;
        uint8_t dummy[OM_MAX_CHANNELS];
        for (uint32_t i = 0; i < in_blk; i++) {
            if (!dsd_next_msb_bytes(d, ch, dummy)) break;
        }
    } else {
        uint64_t file_pos = d->data_offset + target_dsd_byte * ch;
#ifdef _WIN32
        if (_fseeki64(d->fp, (int64_t)file_pos, SEEK_SET) != 0) return -1;
#else
        if (fseeko(d->fp, (off_t)file_pos, SEEK_SET) != 0) return -1;
#endif
        d->block_valid = false;
        d->cur_dsd_byte_per_ch = target_dsd_byte;
    }

    dsd_reset_history(d);
    d->dop_marker = 0x05U;
    return 0;
}

static void dsd_close(om_decoder_t *dec) {
    if (!dec || !dec->priv) return;
    dsd_priv_t *d = (dsd_priv_t *)dec->priv;
    if (d->fp) fclose(d->fp);
    free(d->block_buf);
    free(d);
    dec->priv = NULL;
}

int om_decoder_open_dsd_ex(const char *path, om_dsd_mode_t dsd_mode, om_decoder_t *out_dec, char *err, size_t err_cap) {
    memset(out_dec, 0, sizeof(*out_dec));
    FILE *fp = fopen(path, "rb");
    if (!fp) {
        snprintf(err, err_cap, "Cannot open DSD file: %s", path);
        return -1;
    }

    uint8_t magic[4];
    if (fread(magic, 1, 4, fp) != 4) {
        fclose(fp);
        snprintf(err, err_cap, "Truncated DSD header");
        return -1;
    }

    dsd_priv_t *d = (dsd_priv_t *)calloc(1, sizeof(*d));
    d->fp = fp;
    d->dop_marker = 0x05U;
    uint16_t channels = 0;

    if (memcmp(magic, "DSD ", 4) == 0) {
        /* Sony DSF format */
        uint8_t dsd_hdr[24];
        if (fread(dsd_hdr, 1, 24, fp) != 24 || dsd_u64_le(dsd_hdr) != 28ULL) {
            fclose(fp); free(d);
            snprintf(err, err_cap, "Invalid DSF DSD header");
            return -1;
        }
        uint8_t fmt_hdr[52];
        if (fread(fmt_hdr, 1, 52, fp) != 52 || memcmp(fmt_hdr, "fmt ", 4) != 0) {
            fclose(fp); free(d);
            snprintf(err, err_cap, "Invalid DSF fmt chunk");
            return -1;
        }
        channels = (uint16_t)dsd_u32_le(fmt_hdr + 24);
        d->dsd_rate = dsd_u32_le(fmt_hdr + 28);
        uint32_t bps = dsd_u32_le(fmt_hdr + 32);
        uint64_t sample_count_1bit = dsd_u64_le(fmt_hdr + 36);
        d->block_size_ch = dsd_u32_le(fmt_hdr + 44);
        if (d->block_size_ch == 0) d->block_size_ch = 4096;

        uint8_t data_hdr[12];
        if (fread(data_hdr, 1, 12, fp) != 12 || memcmp(data_hdr, "data", 4) != 0) {
            fclose(fp); free(d);
            snprintf(err, err_cap, "Missing DSF data chunk");
            return -1;
        }
        uint64_t data_chunk_sz = dsd_u64_le(data_hdr + 4);
        d->is_dsf = true;
        d->lsb_first = (bps == 1);
#ifdef _WIN32
        d->data_offset = (uint64_t)_ftelli64(fp);
#else
        d->data_offset = (uint64_t)ftello(fp);
#endif
        d->data_bytes = (data_chunk_sz > 12) ? (data_chunk_sz - 12) : 0;
        d->total_dsd_bytes_per_ch = sample_count_1bit / 8ULL;
        if (d->total_dsd_bytes_per_ch == 0 && channels > 0) {
            d->total_dsd_bytes_per_ch = d->data_bytes / channels;
        }
        if (channels > 0 && channels <= OM_MAX_CHANNELS) {
            d->block_buf = (uint8_t *)malloc((size_t)d->block_size_ch * channels);
        }
    } else if (memcmp(magic, "FRM8", 4) == 0) {
        /* Philips DSDIFF (.dff) format */
        uint8_t rest[12];
        if (fread(rest, 1, 12, fp) != 12 || memcmp(rest + 8, "DSD ", 4) != 0) {
            fclose(fp); free(d);
            snprintf(err, err_cap, "Invalid DSDIFF FRM8 header");
            return -1;
        }
        bool got_dsd = false;
        while (!got_dsd) {
            uint8_t chdr[12];
            if (fread(chdr, 1, 12, fp) != 12) break;
            uint64_t csz = dsd_u64_be(chdr + 4);
#ifdef _WIN32
            int64_t cpos = _ftelli64(fp);
#else
            off_t cpos = ftello(fp);
#endif
            if (memcmp(chdr, "PROP", 4) == 0 && csz >= 4) {
                uint8_t ptype[4];
                if (fread(ptype, 1, 4, fp) == 4 && memcmp(ptype, "SND ", 4) == 0) {
                    uint64_t pend = (uint64_t)cpos + csz;
                    while (true) {
#ifdef _WIN32
                        uint64_t cur = (uint64_t)_ftelli64(fp);
#else
                        uint64_t cur = (uint64_t)ftello(fp);
#endif
                        if (cur + 12 > pend) break;
                        uint8_t sh[12];
                        if (fread(sh, 1, 12, fp) != 12) break;
                        uint64_t ssz = dsd_u64_be(sh + 4);
#ifdef _WIN32
                        int64_t spos = _ftelli64(fp);
#else
                        off_t spos = ftello(fp);
#endif
                        if (memcmp(sh, "FS  ", 4) == 0 && ssz >= 4) {
                            uint8_t b[4];
                            if (fread(b, 1, 4, fp) == 4) d->dsd_rate = dsd_u32_be(b);
                        } else if (memcmp(sh, "CHNL", 4) == 0 && ssz >= 2) {
                            uint8_t b[2];
                            if (fread(b, 1, 2, fp) == 2) channels = (uint16_t)((b[0] << 8) | b[1]);
                        }
                        uint64_t sskip = ssz + (ssz & 1ULL);
#ifdef _WIN32
                        _fseeki64(fp, spos + (int64_t)sskip, SEEK_SET);
#else
                        fseeko(fp, spos + (off_t)sskip, SEEK_SET);
#endif
                    }
                }
            } else if (memcmp(chdr, "DSD ", 4) == 0) {
                d->data_offset = (uint64_t)cpos;
                d->data_bytes = csz;
                got_dsd = true;
                break;
            }
            uint64_t cskip = csz + (csz & 1ULL);
#ifdef _WIN32
            if (_fseeki64(fp, cpos + (int64_t)cskip, SEEK_SET) != 0) break;
#else
            if (fseeko(fp, cpos + (off_t)cskip, SEEK_SET) != 0) break;
#endif
        }
        if (!got_dsd || channels == 0 || d->dsd_rate == 0) {
            fclose(fp); free(d);
            snprintf(err, err_cap, "Incomplete DSDIFF chunks");
            return -1;
        }
        d->is_dsf = false;
        d->lsb_first = false;
        d->total_dsd_bytes_per_ch = d->data_bytes / channels;
        if (channels <= OM_MAX_CHANNELS) {
            d->block_buf = (uint8_t *)malloc((size_t)DFF_CACHE_FRAMES * channels);
        }
#ifdef _WIN32
        _fseeki64(fp, (int64_t)d->data_offset, SEEK_SET);
#else
        fseeko(fp, (off_t)d->data_offset, SEEK_SET);
#endif
    } else {
        fclose(fp); free(d);
        snprintf(err, err_cap, "Unknown DSD signature");
        return -1;
    }

    if (channels == 0 || channels > OM_MAX_CHANNELS || d->dsd_rate < 2822400 || !d->block_buf) {
        snprintf(err, err_cap, "Unsupported DSD stream layout (%u ch, %u Hz)", channels, d->dsd_rate);
        fclose(fp); free(d->block_buf); free(d);
        return -1;
    }

    /*
     * Decimation ratio selection for PCM mode:
     * - DSD64  (2.8224 / 3.072 MHz):  16:1 -> 176.4 / 192 kHz (2 bytes/frame)
     * - DSD128 (5.6448 / 6.144 MHz):  16:1 -> 352.8 / 384 kHz (2 bytes/frame)
     * - DSD256 (11.2896 / 12.288 MHz): 32:1 -> 352.8 / 384 kHz (4 bytes/frame)
     * - DSD512 (22.5792 / 24.576 MHz): 64:1 -> 352.8 / 384 kHz (8 bytes/frame)
     * - DSD1024 (45.1584 / 49.152 MHz): 128:1 -> 352.8 / 384 kHz (16 bytes/frame)
     */
    if (d->dsd_rate >= 44000000U) {
        d->decim_bytes = 16U;
    } else if (d->dsd_rate >= 22000000U) {
        d->decim_bytes = 8U;
    } else if (d->dsd_rate >= 11000000U) {
        d->decim_bytes = 4U;
    } else {
        d->decim_bytes = 2U;
    }

    /* DoP above DSD512 exceeds 1.536 MHz PCM carrier limits; fall back safely if needed */
    if (dsd_mode == OM_DSD_MODE_DOP && d->dsd_rate > 25000000U) {
        dsd_mode = OM_DSD_MODE_PCM;
    }

    d->dsd_mode = dsd_mode;
    dsd_init_tables(d);

    uint32_t bytes_per_out = dsd_bytes_per_out_frame(d);
    uint32_t out_rate = d->dsd_rate / (bytes_per_out * 8U);

    out_dec->name = (dsd_mode == OM_DSD_MODE_NATIVE) ? "DSD (Native Direct)"
                  : (dsd_mode == OM_DSD_MODE_DOP)    ? "DSD (DoP)"
                                                     : "DSD (PCM 128-tap FIR)";
    out_dec->priv = d;
    out_dec->info.codec = OM_CODEC_DSD;
    out_dec->info.sample_rate = out_rate;
    out_dec->info.dsd_bit_rate = d->dsd_rate;
    out_dec->info.channels = channels;
    out_dec->info.bit_depth = (dsd_mode == OM_DSD_MODE_NATIVE) ? 32 : 24;
    out_dec->info.is_float = (dsd_mode == OM_DSD_MODE_PCM);
    out_dec->info.is_dop = (dsd_mode == OM_DSD_MODE_DOP);
    out_dec->info.is_dsd_native = (dsd_mode == OM_DSD_MODE_NATIVE);
    out_dec->info.total_frames = d->total_dsd_bytes_per_ch / bytes_per_out;
    out_dec->info.duration_sec = (double)out_dec->info.total_frames / (double)out_rate;
    out_dec->read_frames = dsd_read_frames;
    out_dec->seek_frame = dsd_seek_frame;
    out_dec->close = dsd_close;
    return 0;
}

int om_decoder_open_dsd(const char *path, bool prefer_dop, om_decoder_t *out_dec, char *err, size_t err_cap) {
    return om_decoder_open_dsd_ex(path, prefer_dop ? OM_DSD_MODE_DOP : OM_DSD_MODE_PCM, out_dec, err, err_cap);
}
