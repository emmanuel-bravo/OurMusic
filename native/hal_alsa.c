#ifndef _WIN32

#include "hal.h"
#include "os_compat.h"
#include <alsa/asoundlib.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    bool              is_wavsink;
    snd_pcm_t        *pcm;
    snd_pcm_format_t  alsa_fmt;
    uint16_t          bytes_per_sample;
    uint8_t          *pack_buf;
    size_t            pack_cap_frames;
} alsa_priv_t;

size_t om_hal_enumerate_devices(om_hal_device_info_t *out_list, size_t max_items) {
    if (!out_list || max_items == 0) return 0;
    size_t count = 0;

    /* Always offer default ALSA endpoint first */
    snprintf(out_list[count].id, sizeof(out_list[count].id), "default");
    snprintf(out_list[count].name, sizeof(out_list[count].name), "ALSA Default Output");
    out_list[count].is_exclusive_capable = false;
    out_list[count].is_default = true;
    count++;

    void **hints = NULL;
    if (snd_device_name_hint(-1, "pcm", &hints) == 0 && hints) {
        for (void **p = hints; *p && count + 1 < max_items; p++) {
            char *name = snd_device_name_get_hint(*p, "NAME");
            char *desc = snd_device_name_get_hint(*p, "DESC");
            char *ioid = snd_device_name_get_hint(*p, "IOID");

            bool is_out = (!ioid || strcmp(ioid, "Output") == 0);
            if (name && is_out && strcmp(name, "null") != 0 && strcmp(name, "default") != 0) {
                /* Prioritize direct hardware (`hw:` / `front:` / `iec958:`) & `plughw:` endpoints */
                if (strncmp(name, "hw:", 3) == 0 ||
                    strncmp(name, "plughw:", 7) == 0 ||
                    strncmp(name, "sysdefault", 10) == 0 ||
                    strncmp(name, "front:", 6) == 0 ||
                    strncmp(name, "iec958:", 7) == 0) {
                    snprintf(out_list[count].id, sizeof(out_list[count].id), "%s", name);
                    if (desc) {
                        for (char *c = desc; *c; c++) {
                            if (*c == '\n' || *c == '\r') *c = ' ';
                        }
                        snprintf(out_list[count].name, sizeof(out_list[count].name), "%s (%s)", desc, name);
                    } else {
                        snprintf(out_list[count].name, sizeof(out_list[count].name), "ALSA %s", name);
                    }
                    out_list[count].is_exclusive_capable = (strncmp(name, "hw:", 3) == 0 || strncmp(name, "iec958:", 7) == 0);
                    out_list[count].is_default = false;
                    count++;
                }
            }
            if (name) free(name);
            if (desc) free(desc);
            if (ioid) free(ioid);
        }
        snd_device_name_free_hint(hints);
    }

    if (count < max_items) {
        snprintf(out_list[count].id, sizeof(out_list[count].id), "null");
        snprintf(out_list[count].name, sizeof(out_list[count].name), "Null Timed Sink (Headless / Test)");
        out_list[count].is_exclusive_capable = true;
        out_list[count].is_default = false;
        count++;
    }

    return count;
}

int om_hal_open(const char *device_id, const om_hal_request_t *req, om_hal_handle_t *out, char *err, size_t err_cap) {
    memset(out, 0, sizeof(*out));
    const char *dev = (device_id && device_id[0]) ? device_id : "default";

    if (strcmp(dev, "null") == 0) {
        return om_wavsink_open(NULL, true, req, out, err, err_cap);
    }
    if (strncmp(dev, "wav:", 4) == 0) {
        return om_wavsink_open(dev + 4, false, req, out, err, err_cap);
    }
    if (strncmp(dev, "wavrt:", 6) == 0) {
        return om_wavsink_open(dev + 6, true, req, out, err, err_cap);
    }

    snd_pcm_t *pcm = NULL;
    int rc = snd_pcm_open(&pcm, dev, SND_PCM_STREAM_PLAYBACK, 0);
    if (rc < 0) {
        snprintf(err, err_cap, "ALSA snd_pcm_open('%s') failed: %s", dev, snd_strerror(rc));
        return -1;
    }

    snd_pcm_hw_params_t *hw = NULL;
    snd_pcm_hw_params_malloc(&hw);
    rc = snd_pcm_hw_params_any(pcm, hw);
    if (rc < 0) {
        snd_pcm_hw_params_free(hw);
        snd_pcm_close(pcm);
        snprintf(err, err_cap, "ALSA hw_params_any failed: %s", snd_strerror(rc));
        return -1;
    }

    snd_pcm_hw_params_set_access(pcm, hw, SND_PCM_ACCESS_RW_INTERLEAVED);

    /* Explicitly disable ALSA software resampling when Bit-Perfect output is requested */
    bool no_resample_ok = false;
    if (req->prefer_bitperfect) {
        if (snd_pcm_hw_params_set_rate_resample(pcm, hw, 0) == 0) {
            no_resample_ok = true;
        }
    } else {
        snd_pcm_hw_params_set_rate_resample(pcm, hw, 1);
    }

    /* Negotiate closest lossless/high-precision sample format supported by hardware */
    snd_pcm_format_t chosen_fmt = SND_PCM_FORMAT_UNKNOWN;
    uint16_t chosen_bits = 16;
    uint16_t chosen_bps_bytes = 2;
    bool chosen_float = false;

    snd_pcm_format_t candidates[5];
    int ncand = 0;
    if (req->use_float_output && !req->prefer_bitperfect) {
        candidates[ncand++] = SND_PCM_FORMAT_FLOAT_LE;
    }
    if (req->bit_depth <= 16) {
        candidates[ncand++] = SND_PCM_FORMAT_S16_LE;
        candidates[ncand++] = SND_PCM_FORMAT_S32_LE;
        candidates[ncand++] = SND_PCM_FORMAT_S24_3LE;
    } else if (req->bit_depth == 24) {
        candidates[ncand++] = SND_PCM_FORMAT_S24_3LE;
        candidates[ncand++] = SND_PCM_FORMAT_S32_LE;
        candidates[ncand++] = SND_PCM_FORMAT_FLOAT_LE;
        candidates[ncand++] = SND_PCM_FORMAT_S16_LE;
    } else {
        candidates[ncand++] = SND_PCM_FORMAT_S32_LE;
        candidates[ncand++] = SND_PCM_FORMAT_FLOAT_LE;
        candidates[ncand++] = SND_PCM_FORMAT_S24_3LE;
        candidates[ncand++] = SND_PCM_FORMAT_S16_LE;
    }

    for (int i = 0; i < ncand; i++) {
        if (snd_pcm_hw_params_set_format(pcm, hw, candidates[i]) == 0) {
            chosen_fmt = candidates[i];
            break;
        }
    }
    if (chosen_fmt == SND_PCM_FORMAT_UNKNOWN) {
        snd_pcm_hw_params_free(hw);
        snd_pcm_close(pcm);
        snprintf(err, err_cap, "ALSA hardware rejected all PCM sample formats");
        return -1;
    }

    switch (chosen_fmt) {
        case SND_PCM_FORMAT_S16_LE:   chosen_bits = 16; chosen_bps_bytes = 2; chosen_float = false; break;
        case SND_PCM_FORMAT_S24_3LE:  chosen_bits = 24; chosen_bps_bytes = 3; chosen_float = false; break;
        case SND_PCM_FORMAT_S32_LE:   chosen_bits = 32; chosen_bps_bytes = 4; chosen_float = false; break;
        case SND_PCM_FORMAT_FLOAT_LE: chosen_bits = 32; chosen_bps_bytes = 4; chosen_float = true;  break;
        default:                      chosen_bits = 16; chosen_bps_bytes = 2; chosen_float = false; break;
    }

    unsigned int ch = req->channels;
    if (snd_pcm_hw_params_set_channels(pcm, hw, ch) < 0) {
        snd_pcm_hw_params_free(hw);
        snd_pcm_close(pcm);
        snprintf(err, err_cap, "ALSA hardware rejected %u channels", ch);
        return -1;
    }

    unsigned int actual_rate = req->sample_rate;
    int dir = 0;
    if (snd_pcm_hw_params_set_rate_near(pcm, hw, &actual_rate, &dir) < 0) {
        snd_pcm_hw_params_free(hw);
        snd_pcm_close(pcm);
        snprintf(err, err_cap, "ALSA hardware rejected sample rate %u Hz", req->sample_rate);
        return -1;
    }

    snd_pcm_uframes_t period_sz = 1024;
    snd_pcm_uframes_t buffer_sz = 8192;
    snd_pcm_hw_params_set_period_size_near(pcm, hw, &period_sz, NULL);
    snd_pcm_hw_params_set_buffer_size_near(pcm, hw, &buffer_sz);

    rc = snd_pcm_hw_params(pcm, hw);
    snd_pcm_hw_params_free(hw);
    if (rc < 0) {
        snd_pcm_close(pcm);
        snprintf(err, err_cap, "ALSA snd_pcm_hw_params commit failed: %s", snd_strerror(rc));
        return -1;
    }

    snd_pcm_prepare(pcm);

    alsa_priv_t *ap = (alsa_priv_t *)calloc(1, sizeof(*ap));
    ap->is_wavsink = false;
    ap->pcm = pcm;
    ap->alsa_fmt = chosen_fmt;
    ap->bytes_per_sample = chosen_bps_bytes;
    ap->pack_cap_frames = 4096;
    ap->pack_buf = (uint8_t *)malloc(ap->pack_cap_frames * ch * chosen_bps_bytes);

    bool rate_exact = (actual_rate == req->sample_rate);
    bool depth_lossless = (!chosen_float && chosen_bits >= req->bit_depth);

    snprintf(out->backend_name, sizeof(out->backend_name), "%s",
             (no_resample_ok && rate_exact) ? "ALSA Direct (No-Resample)" : "ALSA PCM");
    snprintf(out->device_id, sizeof(out->device_id), "%s", dev);
    out->actual_rate = actual_rate;
    out->actual_channels = (uint16_t)ch;
    out->actual_bit_depth = chosen_bits;
    out->actual_is_float = chosen_float;
    out->bit_perfect_active = (no_resample_ok && rate_exact && depth_lossless);
    out->priv = ap;
    return 0;
}

static inline int32_t scale_int_to_alsa(int32_t v, uint16_t src_bits, uint16_t dst_bits) {
    if (src_bits == dst_bits) return v;
    if (src_bits < dst_bits) return (int32_t)((uint32_t)v << (dst_bits - src_bits));
    return v >> (src_bits - dst_bits);
}

int om_hal_write(om_hal_handle_t *h, const int32_t *pcm_i32, const double *pcm_f64, uint16_t src_bit_depth, size_t frames) {
    if (!h || !h->priv || frames == 0) return 0;
    if (strcmp(h->device_id, "null") == 0 ||
        strcmp(h->backend_name, "WAV Bit-Exact Sink") == 0 ||
        strcmp(h->backend_name, "Null Timed Sink") == 0) {
        return om_wavsink_write(h, pcm_i32, pcm_f64, src_bit_depth, frames);
    }

    alsa_priv_t *ap = (alsa_priv_t *)h->priv;
    if (frames > ap->pack_cap_frames) {
        ap->pack_cap_frames = frames;
        ap->pack_buf = (uint8_t *)realloc(ap->pack_buf, frames * h->actual_channels * ap->bytes_per_sample);
    }

    size_t total_samples = frames * h->actual_channels;
    if (ap->alsa_fmt == SND_PCM_FORMAT_FLOAT_LE) {
        float *dst = (float *)ap->pack_buf;
        for (size_t i = 0; i < total_samples; i++) {
            double dv = pcm_f64 ? pcm_f64[i] : om_i32_to_f64(pcm_i32 ? pcm_i32[i] : 0, src_bit_depth);
            if (dv > 1.0) dv = 1.0;
            if (dv < -1.0) dv = -1.0;
            dst[i] = (float)dv;
        }
    } else if (ap->alsa_fmt == SND_PCM_FORMAT_S16_LE) {
        int16_t *dst = (int16_t *)ap->pack_buf;
        for (size_t i = 0; i < total_samples; i++) {
            int32_t v = pcm_i32 ? scale_int_to_alsa(pcm_i32[i], src_bit_depth, 16)
                                : om_f64_to_i32(pcm_f64 ? pcm_f64[i] : 0.0, 16);
            dst[i] = (int16_t)v;
        }
    } else if (ap->alsa_fmt == SND_PCM_FORMAT_S24_3LE) {
        for (size_t i = 0; i < total_samples; i++) {
            int32_t v = pcm_i32 ? scale_int_to_alsa(pcm_i32[i], src_bit_depth, 24)
                                : om_f64_to_i32(pcm_f64 ? pcm_f64[i] : 0.0, 24);
            uint32_t u = (uint32_t)v;
            ap->pack_buf[i * 3 + 0] = (uint8_t)(u & 0xFFU);
            ap->pack_buf[i * 3 + 1] = (uint8_t)((u >> 8) & 0xFFU);
            ap->pack_buf[i * 3 + 2] = (uint8_t)((u >> 16) & 0xFFU);
        }
    } else { /* SND_PCM_FORMAT_S32_LE (24-bit left-shifted by 8 or native 32-bit) */
        int32_t *dst = (int32_t *)ap->pack_buf;
        for (size_t i = 0; i < total_samples; i++) {
            int32_t v = pcm_i32 ? scale_int_to_alsa(pcm_i32[i], src_bit_depth, 32)
                                : om_f64_to_i32(pcm_f64 ? pcm_f64[i] : 0.0, 32);
            dst[i] = v;
        }
    }

    size_t written = 0;
    size_t frame_bytes = (size_t)h->actual_channels * ap->bytes_per_sample;
    while (written < frames) {
        snd_pcm_sframes_t r = snd_pcm_writei(ap->pcm, ap->pack_buf + written * frame_bytes, frames - written);
        if (r < 0) {
            r = snd_pcm_recover(ap->pcm, (int)r, 1);
            if (r < 0) return -1;
            continue;
        }
        written += (size_t)r;
    }
    return (int)written;
}

void om_hal_drain(om_hal_handle_t *h) {
    if (!h || !h->priv) return;
    if (strcmp(h->device_id, "null") == 0 ||
        strcmp(h->backend_name, "WAV Bit-Exact Sink") == 0 ||
        strcmp(h->backend_name, "Null Timed Sink") == 0) return;
    alsa_priv_t *ap = (alsa_priv_t *)h->priv;
    if (ap->pcm) snd_pcm_drain(ap->pcm);
}

void om_hal_drop(om_hal_handle_t *h) {
    if (!h || !h->priv) return;
    if (strcmp(h->device_id, "null") == 0 ||
        strcmp(h->backend_name, "WAV Bit-Exact Sink") == 0 ||
        strcmp(h->backend_name, "Null Timed Sink") == 0) return;
    alsa_priv_t *ap = (alsa_priv_t *)h->priv;
    if (ap->pcm) {
        snd_pcm_drop(ap->pcm);
        snd_pcm_prepare(ap->pcm);
    }
}

void om_hal_close(om_hal_handle_t *h) {
    if (!h || !h->priv) return;
    if (strcmp(h->device_id, "null") == 0 ||
        strcmp(h->backend_name, "WAV Bit-Exact Sink") == 0 ||
        strcmp(h->backend_name, "Null Timed Sink") == 0) {
        om_wavsink_close(h);
        return;
    }
    alsa_priv_t *ap = (alsa_priv_t *)h->priv;
    if (ap->pcm) snd_pcm_close(ap->pcm);
    free(ap->pack_buf);
    free(ap);
    h->priv = NULL;
}

#endif /* !_WIN32 */
