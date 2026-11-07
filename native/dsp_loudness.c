#include "dsp_loudness.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/*
 * Clean-room ITU-R BS.1770-4 / EBU R128 Loudness & True-Peak Scanner.
 * Analytical bilinear K-weighting cascade (exact across 44.1 kHz .. 384 kHz)
 * with 400 ms 75%-overlapping blocks, -70 LUFS absolute gate, -10 LU relative gate,
 * and 4x inter-sample Catmull-Rom true-peak estimation.
 */

typedef struct {
    double b0, b1, b2, a1, a2;
    double z1[OM_MAX_CHANNELS];
    double z2[OM_MAX_CHANNELS];
} kw_biquad_t;

static void kw_init_stage1_shelf(kw_biquad_t *bq, uint32_t fs) {
    memset(bq, 0, sizeof(*bq));
    const double f0 = 1681.974450955533;
    const double G  = 3.999843853973347;
    const double Q  = 0.7071752369554196;
    const double K  = tan(M_PI * f0 / (double)fs);
    const double Vh = pow(10.0, G / 20.0);
    const double Vb = pow(Vh, 0.4996667741545416);
    const double K2 = K * K;
    const double a0 = 1.0 + K / Q + K2;

    bq->b0 = (Vh + Vb * K / Q + K2) / a0;
    bq->b1 = 2.0 * (K2 - Vh) / a0;
    bq->b2 = (Vh - Vb * K / Q + K2) / a0;
    bq->a1 = 2.0 * (K2 - 1.0) / a0;
    bq->a2 = (1.0 - K / Q + K2) / a0;
}

static void kw_init_stage2_rlb(kw_biquad_t *bq, uint32_t fs) {
    memset(bq, 0, sizeof(*bq));
    const double f0 = 38.13547087602444;
    const double Q  = 0.5003270373238773;
    const double K  = tan(M_PI * f0 / (double)fs);
    const double K2 = K * K;
    const double a0 = 1.0 + K / Q + K2;

    bq->b0 =  1.0 / a0;
    bq->b1 = -2.0 / a0;
    bq->b2 =  1.0 / a0;
    bq->a1 =  2.0 * (K2 - 1.0) / a0;
    bq->a2 =  (1.0 - K / Q + K2) / a0;
}

static inline double hermite4_interp(double xm1, double x0, double x1, double x2, double t) {
    double c0 = x0;
    double c1 = 0.5 * (x1 - xm1);
    double c2 = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
    double c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * t + c2) * t + c1) * t + c0;
}

static int cmp_double_asc(const void *a, const void *b) {
    double da = *(const double *)a;
    double db = *(const double *)b;
    return (da > db) - (da < db);
}

int om_loudness_scan_file(const char *path, om_loudness_result_t *out, char *err, size_t err_cap) {
    if (!path || !out) {
        if (err && err_cap) snprintf(err, err_cap, "Invalid arguments to loudness scanner");
        return -1;
    }
    memset(out, 0, sizeof(*out));

    om_decoder_t dec;
    if (om_decoder_open_any(path, false, &dec, err, err_cap) != 0) {
        return -1;
    }

    const uint32_t sr = dec.info.sample_rate;
    const uint16_t ch = dec.info.channels;
    if (sr == 0 || ch == 0 || ch > OM_MAX_CHANNELS) {
        dec.close(&dec);
        if (err && err_cap) snprintf(err, err_cap, "Unsupported audio layout for loudness scan");
        return -1;
    }

    kw_biquad_t stg1, stg2;
    kw_init_stage1_shelf(&stg1, sr);
    kw_init_stage2_rlb(&stg2, sr);

    /* ITU-R BS.1770-4 channel weights: L/R/C = 1.0, LFE(ch 3 in 5.1) = 0.0, Surrounds = 1.41 */
    double ch_weight[OM_MAX_CHANNELS];
    for (uint16_t c = 0; c < ch; c++) {
        if (ch >= 6 && c == 3) ch_weight[c] = 0.0;
        else if (ch >= 5 && c >= 3) ch_weight[c] = 1.4125375446227544; /* +1.5 dB */
        else ch_weight[c] = 1.0;
    }

    /* 100 ms sub-blocks; 4 consecutive sub-blocks form each 400 ms 75%-overlapping gating window */
    size_t sub_frames = (sr / 10U);
    if (sub_frames < 64U) sub_frames = 64U;

    size_t energies_cap = 2048U;
    size_t num_subs = 0;
    double *sub_energy = (double *)malloc(energies_cap * sizeof(double));
    double *pcm_buf = (double *)malloc(2048U * ch * sizeof(double));
    if (!sub_energy || !pcm_buf) {
        free(sub_energy); free(pcm_buf);
        dec.close(&dec);
        if (err && err_cap) snprintf(err, err_cap, "Out of memory in loudness scanner");
        return -1;
    }

    double cur_sub_sum = 0.0;
    size_t cur_sub_cnt = 0;
    double total_weighted_sum = 0.0;
    uint64_t total_frames = 0;

    double sample_peak = 0.0;
    double true_peak = 0.0;
    double tp_hist[OM_MAX_CHANNELS][4];
    memset(tp_hist, 0, sizeof(tp_hist));

    while (true) {
        int got = dec.read_frames(&dec, NULL, pcm_buf, 2048U);
        if (got <= 0) break;

        for (int f = 0; f < got; f++) {
            double frame_weighted_sq = 0.0;
            const double *frame_ptr = pcm_buf + (size_t)f * ch;

            for (uint16_t c = 0; c < ch; c++) {
                double x = frame_ptr[c];
                double ax = fabs(x);
                if (ax > sample_peak) sample_peak = ax;

                /* 4x inter-sample Catmull-Rom true-peak check when near top octave */
                double h0 = tp_hist[c][0], h1 = tp_hist[c][1], h2 = tp_hist[c][2];
                tp_hist[c][0] = h1;
                tp_hist[c][1] = h2;
                tp_hist[c][2] = x;
                if (ax > true_peak) true_peak = ax;
                if (fabs(h1) > 0.25 * true_peak || fabs(h2) > 0.25 * true_peak) {
                    double p25 = fabs(hermite4_interp(h0, h1, h2, x, 0.25));
                    double p50 = fabs(hermite4_interp(h0, h1, h2, x, 0.50));
                    double p75 = fabs(hermite4_interp(h0, h1, h2, x, 0.75));
                    if (p25 > true_peak) true_peak = p25;
                    if (p50 > true_peak) true_peak = p50;
                    if (p75 > true_peak) true_peak = p75;
                }

                /* Stage 1 K-weighting shelf */
                double y1 = stg1.b0 * x + stg1.z1[c];
                stg1.z1[c] = stg1.b1 * x - stg1.a1 * y1 + stg1.z2[c];
                stg1.z2[c] = stg1.b2 * x - stg1.a2 * y1;

                /* Stage 2 RLB high-pass */
                double y2 = stg2.b0 * y1 + stg2.z1[c];
                stg2.z1[c] = stg2.b1 * y1 - stg2.a1 * y2 + stg2.z2[c];
                stg2.z2[c] = stg2.b2 * y1 - stg2.a2 * y2;

                frame_weighted_sq += ch_weight[c] * (y2 * y2);
            }

            cur_sub_sum += frame_weighted_sq;
            total_weighted_sum += frame_weighted_sq;
            cur_sub_cnt++;
            total_frames++;

            if (cur_sub_cnt == sub_frames) {
                if (num_subs == energies_cap) {
                    energies_cap *= 2U;
                    double * grown = (double *)realloc(sub_energy, energies_cap * sizeof(double));
                    if (!grown) break;
                    sub_energy = grown;
                }
                sub_energy[num_subs++] = cur_sub_sum / (double)sub_frames;
                cur_sub_sum = 0.0;
                cur_sub_cnt = 0;
            }
        }
    }

    dec.close(&dec);
    free(pcm_buf);

    double integrated_lufs = -70.0;
    double lra_lu = 0.0;

    if (num_subs >= 4U) {
        size_t num_blocks = num_subs - 3U;
        double *blk_z = (double *)malloc(num_blocks * sizeof(double));
        if (blk_z) {
            /* Pass 1: Absolute gate at -70.0 LUFS */
            const double abs_gate_z = pow(10.0, (-70.0 + 0.691) / 10.0);
            double sum_abs = 0.0;
            size_t cnt_abs = 0;

            for (size_t j = 0; j < num_blocks; j++) {
                double z = 0.25 * (sub_energy[j] + sub_energy[j + 1U] + sub_energy[j + 2U] + sub_energy[j + 3U]);
                blk_z[j] = z;
                if (z > abs_gate_z) {
                    sum_abs += z;
                    cnt_abs++;
                }
            }

            if (cnt_abs > 0) {
                double mean_abs = sum_abs / (double)cnt_abs;
                double gamma_abs_lufs = -0.691 + 10.0 * log10(mean_abs);
                /* Pass 2: Relative gate at (L_abs - 10.0 LU) */
                double rel_gate_z = pow(10.0, (gamma_abs_lufs - 10.0 + 0.691) / 10.0);
                double sum_rel = 0.0;
                size_t cnt_rel = 0;

                for (size_t j = 0; j < num_blocks; j++) {
                    if (blk_z[j] > abs_gate_z && blk_z[j] > rel_gate_z) {
                        sum_rel += blk_z[j];
                        cnt_rel++;
                    }
                }

                if (cnt_rel > 0) {
                    integrated_lufs = -0.691 + 10.0 * log10(sum_rel / (double)cnt_rel);
                } else {
                    integrated_lufs = gamma_abs_lufs;
                }

                /* Estimate dynamic Loudness Range (10th to 95th percentile of gated blocks) */
                if (cnt_abs >= 4U) {
                    double *valid_lufs = (double *)malloc(cnt_abs * sizeof(double));
                    if (valid_lufs) {
                        size_t k = 0;
                        double lra_rel_z = pow(10.0, (gamma_abs_lufs - 20.0 + 0.691) / 10.0);
                        for (size_t j = 0; j < num_blocks; j++) {
                            if (blk_z[j] > abs_gate_z && blk_z[j] >= lra_rel_z) {
                                valid_lufs[k++] = -0.691 + 10.0 * log10(blk_z[j]);
                            }
                        }
                        if (k >= 2U) {
                            qsort(valid_lufs, k, sizeof(double), cmp_double_asc);
                            double p10 = valid_lufs[(k * 10U) / 100U];
                            double p95 = valid_lufs[(k * 95U) / 100U];
                            lra_lu = (p95 > p10) ? (p95 - p10) : 0.0;
                        }
                        free(valid_lufs);
                    }
                }
            }
            free(blk_z);
        }
    } else if (total_frames > 0) {
        /* Short clip fallback (< 400 ms) */
        double mean_z = total_weighted_sum / (double)total_frames;
        if (mean_z > 1e-14) {
            integrated_lufs = -0.691 + 10.0 * log10(mean_z);
        }
    }

    free(sub_energy);

    if (true_peak < sample_peak) true_peak = sample_peak;
    out->integrated_lufs = integrated_lufs;
    out->loudness_range_lu = lra_lu;
    out->sample_peak = sample_peak;
    out->true_peak = true_peak;
    out->peak_db = (true_peak > 1e-12) ? (20.0 * log10(true_peak)) : -120.0;
    out->replaygain_db = -18.0 - integrated_lufs;
    out->r128_gain_db = -23.0 - integrated_lufs;
    return 0;
}
