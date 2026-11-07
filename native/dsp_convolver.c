#include "dsp_convolver.h"
#include "dsp_resampler.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/*
 * Clean-room Zero-Latency Hybrid Uniformly Partitioned FFT Convolver (Gardner architecture).
 * - First 256 taps execute directly in time domain via doubled-ring forward AVX2/SSE2 dot-product (0 latency).
 * - Remaining taps execute in 256-sample blocks via N=512 radix-2 FFT Frequency-Domain Delay Line (FDL)
 *   with Overlap-Add, achieving O(N log N) throughput for multi-second room & AutoEq headphone IRs.
 */

static void fft512_init_tables(om_convolver_t *conv) {
    for (uint16_t i = 0; i < OM_CONV_FFT_LEN; i++) {
        uint16_t r = 0;
        for (int b = 0; b < 9; b++) { /* log2(512) = 9 */
            if (i & (1U << b)) r |= (uint16_t)(1U << (8 - b));
        }
        conv->bit_rev[i] = r;
    }
    for (uint32_t k = 0; k < OM_CONV_FFT_LEN / 2U; k++) {
        double ang = -2.0 * M_PI * (double)k / (double)OM_CONV_FFT_LEN;
        conv->tw_re[k] = cos(ang);
        conv->tw_im[k] = sin(ang);
    }
}

static void fft512_forward(const om_convolver_t * restrict conv, double * restrict re, double * restrict im) {
    for (uint32_t i = 0; i < OM_CONV_FFT_LEN; i++) {
        uint32_t j = conv->bit_rev[i];
        if (i < j) {
            double tr = re[i]; re[i] = re[j]; re[j] = tr;
            double ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
    }

    for (uint32_t len = 2U; len <= OM_CONV_FFT_LEN; len <<= 1U) {
        uint32_t half = len >> 1U;
        uint32_t step = OM_CONV_FFT_LEN / len;
        for (uint32_t i = 0; i < OM_CONV_FFT_LEN; i += len) {
            for (uint32_t k = 0; k < half; k++) {
                uint32_t tw_idx = k * step;
                double wr = conv->tw_re[tw_idx];
                double wi = conv->tw_im[tw_idx];
                uint32_t u = i + k;
                uint32_t v = u + half;
                double vr = re[v] * wr - im[v] * wi;
                double vi = re[v] * wi + im[v] * wr;
                re[v] = re[u] - vr;
                im[v] = im[u] - vi;
                re[u] += vr;
                im[u] += vi;
            }
        }
    }
}

static void fft512_inverse(const om_convolver_t * restrict conv, double * restrict re, double * restrict im) {
    for (uint32_t i = 0; i < OM_CONV_FFT_LEN; i++) im[i] = -im[i];
    fft512_forward(conv, re, im);
    const double inv_n = 1.0 / (double)OM_CONV_FFT_LEN;
    for (uint32_t i = 0; i < OM_CONV_FFT_LEN; i++) {
        re[i] *= inv_n;
        im[i] = -im[i] * inv_n;
    }
}

static void conv_free_partitions(om_convolver_t *conv) {
    for (int c = 0; c < 2; c++) {
        free(conv->ir_tail_re[c]);
        free(conv->ir_tail_im[c]);
        conv->ir_tail_re[c] = NULL;
        conv->ir_tail_im[c] = NULL;
    }
    for (int ch = 0; ch < OM_MAX_CHANNELS; ch++) {
        free(conv->chan[ch].fdl_re);
        free(conv->chan[ch].fdl_im);
        conv->chan[ch].fdl_re = NULL;
        conv->chan[ch].fdl_im = NULL;
    }
    conv->num_tail_parts = 0;
    conv->active_ir_frames = 0;
}

void om_convolver_init(om_convolver_t *conv) {
    memset(conv, 0, sizeof(*conv));
    conv->wet_mix = 1.0;
    conv->ir_gain_db = 0.0;
    conv->auto_normalize = false;
    conv->stream_rate = 48000;
    conv->stream_channels = 2;
    fft512_init_tables(conv);
}

void om_convolver_unload_ir(om_convolver_t *conv) {
    if (!conv) return;
    conv_free_partitions(conv);
    free(conv->raw_ir_ch[0]);
    free(conv->raw_ir_ch[1]);
    conv->raw_ir_ch[0] = NULL;
    conv->raw_ir_ch[1] = NULL;
    conv->raw_ir_frames = 0;
    conv->ir_loaded = false;
    conv->ir_path[0] = '\0';
}

void om_convolver_destroy(om_convolver_t *conv) {
    if (!conv) return;
    om_convolver_unload_ir(conv);
}

void om_convolver_reset(om_convolver_t *conv) {
    if (!conv) return;
    size_t fdl_elems = (size_t)conv->num_tail_parts * OM_CONV_FFT_LEN;
    for (int ch = 0; ch < OM_MAX_CHANNELS; ch++) {
        om_conv_chan_t *st = &conv->chan[ch];
        memset(st->td_hist, 0, sizeof(st->td_hist));
        memset(st->in_blk, 0, sizeof(st->in_blk));
        memset(st->out_tail_cur, 0, sizeof(st->out_tail_cur));
        memset(st->out_overlap, 0, sizeof(st->out_overlap));
        st->td_write_pos = 0;
        st->in_pos = 0;
        st->fdl_head = 0;
        if (st->fdl_re && fdl_elems > 0) memset(st->fdl_re, 0, fdl_elems * sizeof(double));
        if (st->fdl_im && fdl_elems > 0) memset(st->fdl_im, 0, fdl_elems * sizeof(double));
    }
}

static int conv_build_partitions(om_convolver_t *conv) {
    if (!conv->ir_loaded || conv->raw_ir_frames == 0 || conv->stream_rate == 0) return -1;

    conv_free_partitions(conv);

    uint16_t ir_ch = (conv->raw_ir_channels >= 2 && conv->raw_ir_ch[1]) ? 2 : 1;
    conv->ir_spec_channels = ir_ch;

    double *prepared_ir[2] = { NULL, NULL };
    size_t ir_len = conv->raw_ir_frames;

    if (conv->raw_ir_rate == conv->stream_rate) {
        for (uint16_t c = 0; c < ir_ch; c++) {
            prepared_ir[c] = (double *)malloc(ir_len * sizeof(double));
            if (!prepared_ir[c]) { free(prepared_ir[0]); return -1; }
            memcpy(prepared_ir[c], conv->raw_ir_ch[c], ir_len * sizeof(double));
        }
    } else {
        /* Resample IR to match stream sample rate and apply discrete time-step scaling */
        om_resampler_t rs;
        om_resampler_init(&rs);
        if (om_resampler_configure(&rs, conv->raw_ir_rate, conv->stream_rate, 1, OM_SRC_QUALITY_HIGH) != 0) {
            om_resampler_destroy(&rs);
            return -1;
        }
        size_t max_out = om_resampler_max_out_frames(&rs, conv->raw_ir_frames) + 64U;
        if (max_out > OM_CONV_MAX_IR_FRAMES) max_out = OM_CONV_MAX_IR_FRAMES;
        double rate_gain = (double)conv->raw_ir_rate / (double)conv->stream_rate;
        size_t actual_len = 0;

        for (uint16_t c = 0; c < ir_ch; c++) {
            om_resampler_reset(&rs);
            /* Preserve full causal two-sided Sinc kernel for impulse responses starting at n=0 */
            rs.pos = 0.0;
            prepared_ir[c] = (double *)calloc(max_out, sizeof(double));
            if (!prepared_ir[c]) {
                free(prepared_ir[0]);
                om_resampler_destroy(&rs);
                return -1;
            }
            size_t got1 = om_resampler_process(&rs, conv->raw_ir_ch[c], conv->raw_ir_frames, prepared_ir[c], max_out);
            size_t got2 = 0;
            if (got1 < max_out) {
                got2 = om_resampler_flush_tail(&rs, prepared_ir[c] + got1, max_out - got1);
            }
            actual_len = got1 + got2;
            for (size_t i = 0; i < actual_len; i++) {
                prepared_ir[c][i] *= rate_gain;
            }
        }
        om_resampler_destroy(&rs);
        ir_len = actual_len;
    }

    if (ir_len == 0) {
        free(prepared_ir[0]); free(prepared_ir[1]);
        return -1;
    }
    if (ir_len > OM_CONV_MAX_IR_FRAMES) ir_len = OM_CONV_MAX_IR_FRAMES;

    /* Apply optional gain trim & peak frequency-response auto-normalization */
    double gain_lin = pow(10.0, conv->ir_gain_db / 20.0);
    if (conv->auto_normalize) {
        double energy = 0.0;
        for (size_t i = 0; i < ir_len; i++) {
            energy += prepared_ir[0][i] * prepared_ir[0][i];
        }
        if (energy > 1.25) {
            gain_lin /= sqrt(energy);
        }
    }
    if (fabs(gain_lin - 1.0) > 1e-6) {
        for (uint16_t c = 0; c < ir_ch; c++) {
            for (size_t i = 0; i < ir_len; i++) prepared_ir[c][i] *= gain_lin;
        }
    }

    conv->active_ir_frames = ir_len;
    uint32_t tail_parts = 0;
    if (ir_len > OM_CONV_PART_LEN) {
        tail_parts = (uint32_t)((ir_len - OM_CONV_PART_LEN + OM_CONV_PART_LEN - 1U) / OM_CONV_PART_LEN);
    }
    conv->num_tail_parts = tail_parts;

    /* Populate reversed 256-tap time-domain head for every output channel */
    for (uint16_t ch = 0; ch < OM_MAX_CHANNELS; ch++) {
        uint16_t src_c = (ir_ch == 2) ? (ch & 1U) : 0U;
        memset(conv->chan[ch].head_rev, 0, sizeof(conv->chan[ch].head_rev));
        size_t head_count = (ir_len < OM_CONV_PART_LEN) ? ir_len : OM_CONV_PART_LEN;
        for (size_t k = 0; k < head_count; k++) {
            conv->chan[ch].head_rev[OM_CONV_PART_LEN - 1U - k] = prepared_ir[src_c][k];
        }
    }

    /* Precompute 512-point FFTs for all tail partitions */
    if (tail_parts > 0) {
        size_t spec_elems = (size_t)tail_parts * OM_CONV_FFT_LEN;
        for (uint16_t c = 0; c < ir_ch; c++) {
            conv->ir_tail_re[c] = (double *)calloc(spec_elems, sizeof(double));
            conv->ir_tail_im[c] = (double *)calloc(spec_elems, sizeof(double));
            if (!conv->ir_tail_re[c] || !conv->ir_tail_im[c]) {
                free(prepared_ir[0]); free(prepared_ir[1]);
                conv_free_partitions(conv);
                return -1;
            }
            for (uint32_t p = 0; p < tail_parts; p++) {
                double *re = conv->ir_tail_re[c] + (size_t)p * OM_CONV_FFT_LEN;
                double *im = conv->ir_tail_im[c] + (size_t)p * OM_CONV_FFT_LEN;
                size_t start = (size_t)(p + 1U) * OM_CONV_PART_LEN;
                size_t copy_n = (start + OM_CONV_PART_LEN <= ir_len) ? OM_CONV_PART_LEN : (ir_len - start);
                memcpy(re, prepared_ir[c] + start, copy_n * sizeof(double));
                fft512_forward(conv, re, im);
            }
        }

        uint16_t alloc_ch = (conv->stream_channels > 0 && conv->stream_channels <= OM_MAX_CHANNELS)
                          ? conv->stream_channels : 2U;
        for (uint16_t ch = 0; ch < alloc_ch; ch++) {
            conv->chan[ch].fdl_re = (double *)calloc(spec_elems, sizeof(double));
            conv->chan[ch].fdl_im = (double *)calloc(spec_elems, sizeof(double));
        }
    }

    free(prepared_ir[0]);
    free(prepared_ir[1]);
    om_convolver_reset(conv);
    return 0;
}

int om_convolver_load_ir(om_convolver_t *conv, const char *ir_path, char *err, size_t err_cap) {
    if (!conv || !ir_path || !ir_path[0]) {
        if (err && err_cap) snprintf(err, err_cap, "Empty IR file path");
        return -1;
    }

    om_decoder_t dec;
    char derr[256] = {0};
    if (om_decoder_open_any(ir_path, false, &dec, derr, sizeof(derr)) != 0) {
        if (err && err_cap) snprintf(err, err_cap, "Cannot load IR '%s': %s", ir_path, derr);
        return -1;
    }
    if (dec.info.is_dop || dec.info.channels == 0 || dec.info.sample_rate == 0) {
        dec.close(&dec);
        if (err && err_cap) snprintf(err, err_cap, "Invalid IR format (must be PCM WAV/FLAC)");
        return -1;
    }

    size_t max_frames = (dec.info.total_frames > 0 && dec.info.total_frames < OM_CONV_MAX_IR_FRAMES)
                      ? (size_t)dec.info.total_frames : OM_CONV_MAX_IR_FRAMES;
    if (max_frames == 0) max_frames = OM_CONV_MAX_IR_FRAMES;

    uint16_t ir_ch = (dec.info.channels >= 2) ? 2 : 1;
    double *ch0 = (double *)calloc(max_frames, sizeof(double));
    double *ch1 = (ir_ch == 2) ? (double *)calloc(max_frames, sizeof(double)) : NULL;
    double *chunk = (double *)malloc(1024U * dec.info.channels * sizeof(double));

    if (!ch0 || (ir_ch == 2 && !ch1) || !chunk) {
        free(ch0); free(ch1); free(chunk);
        dec.close(&dec);
        if (err && err_cap) snprintf(err, err_cap, "Out of memory loading IR");
        return -1;
    }

    size_t total_read = 0;
    while (total_read < max_frames) {
        size_t ask = max_frames - total_read;
        if (ask > 1024U) ask = 1024U;
        int got = dec.read_frames(&dec, NULL, chunk, ask);
        if (got <= 0) break;
        for (int f = 0; f < got; f++) {
            ch0[total_read + (size_t)f] = chunk[(size_t)f * dec.info.channels + 0];
            if (ir_ch == 2) {
                ch1[total_read + (size_t)f] = chunk[(size_t)f * dec.info.channels + 1];
            }
        }
        total_read += (size_t)got;
    }

    uint32_t ir_sr = dec.info.sample_rate;
    dec.close(&dec);
    free(chunk);

    if (total_read == 0) {
        free(ch0); free(ch1);
        if (err && err_cap) snprintf(err, err_cap, "Impulse Response file contains 0 audio frames");
        return -1;
    }

    om_convolver_unload_ir(conv);
    conv->raw_ir_rate = ir_sr;
    conv->raw_ir_channels = ir_ch;
    conv->raw_ir_frames = total_read;
    conv->raw_ir_ch[0] = ch0;
    conv->raw_ir_ch[1] = ch1;
    conv->ir_loaded = true;
    snprintf(conv->ir_path, sizeof(conv->ir_path), "%s", ir_path);

    if (conv_build_partitions(conv) != 0) {
        om_convolver_unload_ir(conv);
        if (err && err_cap) snprintf(err, err_cap, "Failed to partition Impulse Response");
        return -1;
    }
    return 0;
}

int om_convolver_configure_stream(om_convolver_t *conv, uint32_t sample_rate, uint16_t channels) {
    if (!conv || sample_rate == 0 || channels == 0 || channels > OM_MAX_CHANNELS) return -1;
    bool changed = (conv->stream_rate != sample_rate || conv->stream_channels != channels);
    conv->stream_rate = sample_rate;
    conv->stream_channels = channels;

    if (!conv->ir_loaded) return 0;
    if (changed || conv->active_ir_frames == 0) {
        return conv_build_partitions(conv);
    }
    om_convolver_reset(conv);
    return 0;
}

static void conv_step_fft_tail(om_convolver_t * restrict conv, uint16_t ch) {
    om_conv_chan_t * restrict st = &conv->chan[ch];
    const uint32_t tail_parts = conv->num_tail_parts;
    if (tail_parts == 0 || !st->fdl_re || !st->fdl_im) return;

    uint16_t ir_c = (conv->ir_spec_channels == 2) ? (ch & 1U) : 0U;
    const double * restrict H_all_re = conv->ir_tail_re[ir_c];
    const double * restrict H_all_im = conv->ir_tail_im[ir_c];

    /* Advance circular Frequency-Domain Delay Line (FDL) and transform completed 256-sample block */
    st->fdl_head = (st->fdl_head == 0U) ? (tail_parts - 1U) : (st->fdl_head - 1U);
    double * restrict cur_fdl_re = st->fdl_re + (size_t)st->fdl_head * OM_CONV_FFT_LEN;
    double * restrict cur_fdl_im = st->fdl_im + (size_t)st->fdl_head * OM_CONV_FFT_LEN;

    memcpy(cur_fdl_re, st->in_blk, OM_CONV_PART_LEN * sizeof(double));
    memset(cur_fdl_re + OM_CONV_PART_LEN, 0, OM_CONV_PART_LEN * sizeof(double));
    memset(cur_fdl_im, 0, OM_CONV_FFT_LEN * sizeof(double));
    fft512_forward(conv, cur_fdl_re, cur_fdl_im);

    /* Frequency-domain complex multiply-accumulate across all IR partitions */
    double acc_re[OM_CONV_FFT_LEN];
    double acc_im[OM_CONV_FFT_LEN];
    memset(acc_re, 0, sizeof(acc_re));
    memset(acc_im, 0, sizeof(acc_im));

    for (uint32_t p = 0; p < tail_parts; p++) {
        uint32_t slot = st->fdl_head + p;
        if (slot >= tail_parts) slot -= tail_parts;

        const double * restrict Xr = st->fdl_re + (size_t)slot * OM_CONV_FFT_LEN;
        const double * restrict Xi = st->fdl_im + (size_t)slot * OM_CONV_FFT_LEN;
        const double * restrict Hr = H_all_re   + (size_t)p    * OM_CONV_FFT_LEN;
        const double * restrict Hi = H_all_im   + (size_t)p    * OM_CONV_FFT_LEN;

        for (uint32_t k = 0; k < OM_CONV_FFT_LEN; k++) {
            acc_re[k] += Xr[k] * Hr[k] - Xi[k] * Hi[k];
            acc_im[k] += Xr[k] * Hi[k] + Xi[k] * Hr[k];
        }
    }

    fft512_inverse(conv, acc_re, acc_im);

    /* Overlap-Add into current 256-sample tail output buffer and save upper 256-sample overlap */
    for (uint32_t i = 0; i < OM_CONV_PART_LEN; i++) {
        st->out_tail_cur[i] = st->out_overlap[i] + acc_re[i];
        st->out_overlap[i]  = acc_re[OM_CONV_PART_LEN + i];
    }
}

void om_convolver_process(om_convolver_t * restrict conv, double * restrict pcm, size_t frames, uint16_t channels) {
    if (!conv || !conv->enabled || !conv->ir_loaded || conv->active_ir_frames == 0 || frames == 0) {
        return;
    }

    const double wet = conv->wet_mix;
    const double dry = 1.0 - wet;
    const bool has_tail = (conv->num_tail_parts > 0);

    for (uint16_t ch = 0; ch < channels && ch < OM_MAX_CHANNELS; ch++) {
        om_conv_chan_t * restrict st = &conv->chan[ch];
        const double * restrict h_rev = st->head_rev;
        uint32_t w = st->td_write_pos;
        uint32_t in_pos = st->in_pos;

        for (size_t f = 0; f < frames; f++) {
            double x = pcm[f * channels + ch];

            /* Write into doubled circular history buffer for contiguous forward SIMD dot-product */
            st->td_hist[w] = x;
            st->td_hist[w + OM_CONV_PART_LEN] = x;
            const double * restrict hist_slice = &st->td_hist[w + 1U];

            double acc0 = 0.0, acc1 = 0.0, acc2 = 0.0, acc3 = 0.0;
            for (uint32_t k = 0; k < OM_CONV_PART_LEN; k += 4U) {
                acc0 += hist_slice[k + 0U] * h_rev[k + 0U];
                acc1 += hist_slice[k + 1U] * h_rev[k + 1U];
                acc2 += hist_slice[k + 2U] * h_rev[k + 2U];
                acc3 += hist_slice[k + 3U] * h_rev[k + 3U];
            }
            double y = (acc0 + acc1) + (acc2 + acc3);
            w = (w + 1U) & (OM_CONV_PART_LEN - 1U);

            if (has_tail) {
                y += st->out_tail_cur[in_pos];
                st->in_blk[in_pos] = x;
                in_pos++;
                if (in_pos == OM_CONV_PART_LEN) {
                    st->in_pos = OM_CONV_PART_LEN;
                    conv_step_fft_tail(conv, ch);
                    in_pos = 0U;
                }
            }

            pcm[f * channels + ch] = (dry * x) + (wet * y);
        }

        st->td_write_pos = w;
        st->in_pos = in_pos;
    }
}
