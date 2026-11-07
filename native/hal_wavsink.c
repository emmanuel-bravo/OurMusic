#include "hal.h"
#include "os_compat.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    FILE    *fp;
    bool     realtime_pace;
    uint64_t frames_written;
    uint16_t bytes_per_sample;
    uint8_t *pack_buf;
    size_t   pack_cap_frames;
} wavsink_priv_t;

static void wr_u16_le(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)(v & 0xFFU);
    p[1] = (uint8_t)((v >> 8) & 0xFFU);
}

static void wr_u32_le(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)(v & 0xFFU);
    p[1] = (uint8_t)((v >> 8) & 0xFFU);
    p[2] = (uint8_t)((v >> 16) & 0xFFU);
    p[3] = (uint8_t)((v >> 24) & 0xFFU);
}

static void write_wav_header(FILE *fp, uint32_t sr, uint16_t ch, uint16_t bits, uint64_t frames) {
    uint16_t bps_bytes = (uint16_t)(bits / 8);
    uint16_t block_align = (uint16_t)(ch * bps_bytes);
    uint32_t byte_rate = sr * block_align;
    uint64_t data_sz64 = frames * block_align;
    uint32_t data_sz = (data_sz64 > 0xFFFFFF00ULL) ? 0xFFFFFF00U : (uint32_t)data_sz64;
    uint32_t riff_sz = 36U + data_sz;

    uint8_t hdr[44];
    memcpy(hdr + 0, "RIFF", 4);
    wr_u32_le(hdr + 4, riff_sz);
    memcpy(hdr + 8, "WAVEfmt ", 8);
    wr_u32_le(hdr + 16, 16);
    wr_u16_le(hdr + 20, 1); /* PCM */
    wr_u16_le(hdr + 22, ch);
    wr_u32_le(hdr + 24, sr);
    wr_u32_le(hdr + 28, byte_rate);
    wr_u16_le(hdr + 32, block_align);
    wr_u16_le(hdr + 34, bits);
    memcpy(hdr + 36, "data", 4);
    wr_u32_le(hdr + 40, data_sz);

    fseek(fp, 0, SEEK_SET);
    fwrite(hdr, 1, 44, fp);
}

int om_wavsink_open(const char *wav_path, bool realtime_pace, const om_hal_request_t *req, om_hal_handle_t *out, char *err, size_t err_cap) {
    memset(out, 0, sizeof(*out));
    uint16_t bits = req->bit_depth;
    if (bits != 16 && bits != 24 && bits != 32) bits = 24;

    FILE *fp = NULL;
    if (wav_path && wav_path[0] != '\0') {
        fp = fopen(wav_path, "wb");
        if (!fp) {
            snprintf(err, err_cap, "Cannot create WAV capture file: %s", wav_path);
            return -1;
        }
        write_wav_header(fp, req->sample_rate, req->channels, bits, 0);
    }

    wavsink_priv_t *p = (wavsink_priv_t *)calloc(1, sizeof(*p));
    p->fp = fp;
    p->realtime_pace = realtime_pace;
    p->bytes_per_sample = (uint16_t)(bits / 8);
    p->pack_cap_frames = 4096;
    p->pack_buf = (uint8_t *)malloc(p->pack_cap_frames * req->channels * p->bytes_per_sample);

    snprintf(out->backend_name, sizeof(out->backend_name), "%s", fp ? "WAV Bit-Exact Sink" : "Null Timed Sink");
    snprintf(out->device_id, sizeof(out->device_id), "%s", fp ? wav_path : "null");
    out->actual_rate = req->sample_rate;
    out->actual_channels = req->channels;
    out->actual_bit_depth = bits;
    out->actual_is_float = false;
    out->bit_perfect_active = true;
    out->priv = p;
    return 0;
}

static inline int32_t rescale_int_sample(int32_t v, uint16_t src_bits, uint16_t dst_bits) {
    if (src_bits == dst_bits) return v;
    if (src_bits < dst_bits) return v << (dst_bits - src_bits);
    return v >> (src_bits - dst_bits);
}

int om_wavsink_write(om_hal_handle_t *h, const int32_t *pcm_i32, const double *pcm_f64, uint16_t src_bit_depth, size_t frames) {
    wavsink_priv_t *p = (wavsink_priv_t *)h->priv;
    if (!p || frames == 0) return 0;

    if (p->fp) {
        if (frames > p->pack_cap_frames) {
            p->pack_cap_frames = frames;
            p->pack_buf = (uint8_t *)realloc(p->pack_buf, frames * h->actual_channels * p->bytes_per_sample);
        }
        size_t total = frames * h->actual_channels;
        uint16_t dbits = h->actual_bit_depth;

        for (size_t i = 0; i < total; i++) {
            int32_t v = pcm_i32
                ? rescale_int_sample(pcm_i32[i], src_bit_depth, dbits)
                : om_f64_to_i32(pcm_f64 ? pcm_f64[i] : 0.0, dbits);

            uint8_t *dst = p->pack_buf + i * p->bytes_per_sample;
            if (dbits == 16) {
                wr_u16_le(dst, (uint16_t)(int16_t)v);
            } else if (dbits == 24) {
                uint32_t u = (uint32_t)v;
                dst[0] = (uint8_t)(u & 0xFFU);
                dst[1] = (uint8_t)((u >> 8) & 0xFFU);
                dst[2] = (uint8_t)((u >> 16) & 0xFFU);
            } else {
                wr_u32_le(dst, (uint32_t)v);
            }
        }
        fwrite(p->pack_buf, p->bytes_per_sample * h->actual_channels, frames, p->fp);
    }

    p->frames_written += frames;
    if (p->realtime_pace && h->actual_rate > 0) {
        uint32_t ms = (uint32_t)((frames * 1000ULL) / h->actual_rate);
        if (ms > 0) om_sleep_ms(ms);
    }
    return (int)frames;
}

void om_wavsink_close(om_hal_handle_t *h) {
    if (!h || !h->priv) return;
    wavsink_priv_t *p = (wavsink_priv_t *)h->priv;
    if (p->fp) {
        write_wav_header(p->fp, h->actual_rate, h->actual_channels, h->actual_bit_depth, p->frames_written);
        fclose(p->fp);
    }
    free(p->pack_buf);
    free(p);
    h->priv = NULL;
}
