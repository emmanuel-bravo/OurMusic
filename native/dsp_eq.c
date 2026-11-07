#include "dsp_eq.h"
#include <string.h>
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static const double g_freqs_5band[5] = {
    60.0, 230.0, 910.0, 3600.0, 14000.0
};

static const double g_freqs_10band[10] = {
    31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0
};

static inline double clamp_db(double db, double lo, double hi) {
    if (db < lo) return lo;
    if (db > hi) return hi;
    return db;
}

static inline double db_to_lin(double db) {
    return pow(10.0, db / 20.0);
}

/* Robert Bristow-Johnson Peaking EQ Biquad design in 64-bit precision */
static void biquad_calc_peaking(om_biquad_t *bq, double fc, double gain_db, double q, uint32_t sr) {
    if (sr == 0 || fc <= 5.0 || fc >= 0.485 * (double)sr || fabs(gain_db) < 1e-6) {
        bq->b0 = 1.0;
        bq->b1 = 0.0;
        bq->b2 = 0.0;
        bq->a1 = 0.0;
        bq->a2 = 0.0;
        return;
    }

    double A     = pow(10.0, gain_db / 40.0);
    double w0    = 2.0 * M_PI * fc / (double)sr;
    double cosw0 = cos(w0);
    double sinw0 = sin(w0);
    double alpha = sinw0 / (2.0 * q);

    double b0 =  1.0 + alpha * A;
    double b1 = -2.0 * cosw0;
    double b2 =  1.0 - alpha * A;
    double a0 =  1.0 + alpha / A;
    double a1 = -2.0 * cosw0;
    double a2 =  1.0 - alpha / A;

    double inv_a0 = 1.0 / a0;
    bq->b0 = b0 * inv_a0;
    bq->b1 = b1 * inv_a0;
    bq->b2 = b2 * inv_a0;
    bq->a1 = a1 * inv_a0;
    bq->a2 = a2 * inv_a0;
}

static void dsp_recalc_all_biquads_unlocked(om_dsp_chain_t *dsp) {
    double q = (dsp->num_bands <= 5) ? 1.0 : 1.41421356237;
    for (int b = 0; b < dsp->num_bands; b++) {
        biquad_calc_peaking(&dsp->biquads[b], dsp->band_freqs[b], dsp->cur_band_db[b], q, dsp->sample_rate);
    }
}

/* Built-in pipeline hook: Mid-Side Stereo Stage / Headphone Crossfeed */
static void builtin_stereo_stage_hook(
    double *pcm,
    size_t frames,
    uint16_t channels,
    uint32_t sample_rate,
    void *userdata
) {
    (void)sample_rate;
    om_dsp_chain_t *dsp = (om_dsp_chain_t *)userdata;
    dsp->custom_hook_calls++;
    if (channels < 2) return;

    double w = dsp->stereo_width;
    if (fabs(w - 1.0) < 1e-6) return;

    for (size_t i = 0; i < frames; i++) {
        size_t base = i * channels;
        double l = pcm[base + 0];
        double r = pcm[base + 1];
        double mid  = 0.5 * (l + r);
        double side = 0.5 * (l - r) * w;
        pcm[base + 0] = mid + side;
        pcm[base + 1] = mid - side;
    }
}

void om_dsp_init(om_dsp_chain_t *dsp) {
    memset(dsp, 0, sizeof(*dsp));
    om_mutex_init(&dsp->lock);

    dsp->sample_rate = 44100;
    dsp->channels = 2;
    dsp->eq_enabled = false;
    dsp->smoothing_enabled = true;
    dsp->limiter_enabled = true;
    dsp->num_bands = 5;
    memcpy(dsp->band_freqs, g_freqs_5band, sizeof(g_freqs_5band));

    dsp->target_preamp_db = 0.0;
    dsp->cur_preamp_lin = 1.0;
    dsp->target_preamp_lin = 1.0;
    dsp->stereo_width = 1.0;

    dsp_recalc_all_biquads_unlocked(dsp);

    /* Slot 0 in the hook chain is the built-in controllable stereo stage hook */
    om_dsp_register_hook(dsp, "stereo_stage_hook", builtin_stereo_stage_hook, dsp, false);
}

void om_dsp_destroy(om_dsp_chain_t *dsp) {
    om_mutex_destroy(&dsp->lock);
}

void om_dsp_reset_state(om_dsp_chain_t *dsp) {
    om_mutex_lock(&dsp->lock);
    for (int b = 0; b < OM_EQ_MAX_BANDS; b++) {
        memset(dsp->biquads[b].z1, 0, sizeof(dsp->biquads[b].z1));
        memset(dsp->biquads[b].z2, 0, sizeof(dsp->biquads[b].z2));
        dsp->cur_band_db[b] = dsp->target_band_db[b];
    }
    dsp->cur_preamp_lin = dsp->target_preamp_lin;
    dsp_recalc_all_biquads_unlocked(dsp);
    om_mutex_unlock(&dsp->lock);
}

void om_dsp_configure_stream(om_dsp_chain_t *dsp, uint32_t sample_rate, uint16_t channels) {
    om_mutex_lock(&dsp->lock);
    if (sample_rate > 0) dsp->sample_rate = sample_rate;
    if (channels > 0 && channels <= OM_MAX_CHANNELS) dsp->channels = channels;
    for (int b = 0; b < OM_EQ_MAX_BANDS; b++) {
        memset(dsp->biquads[b].z1, 0, sizeof(dsp->biquads[b].z1));
        memset(dsp->biquads[b].z2, 0, sizeof(dsp->biquads[b].z2));
        dsp->cur_band_db[b] = dsp->target_band_db[b];
    }
    dsp->cur_preamp_lin = dsp->target_preamp_lin;
    dsp_recalc_all_biquads_unlocked(dsp);
    om_mutex_unlock(&dsp->lock);
}

int om_dsp_register_hook(om_dsp_chain_t *dsp, const char *name, om_dsp_hook_fn fn, void *userdata, bool enabled) {
    om_mutex_lock(&dsp->lock);
    if (dsp->num_hooks >= OM_DSP_MAX_HOOKS || !fn) {
        om_mutex_unlock(&dsp->lock);
        return -1;
    }
    size_t idx = dsp->num_hooks++;
    dsp->hooks[idx].name = name;
    dsp->hooks[idx].fn = fn;
    dsp->hooks[idx].userdata = userdata;
    dsp->hooks[idx].enabled = enabled;
    om_mutex_unlock(&dsp->lock);
    return (int)idx;
}

void om_dsp_set_custom_hook(om_dsp_chain_t *dsp, bool enabled, double stereo_width) {
    om_mutex_lock(&dsp->lock);
    dsp->custom_hook_enabled = enabled;
    if (stereo_width < 0.0) stereo_width = 0.0;
    if (stereo_width > 2.0) stereo_width = 2.0;
    dsp->stereo_width = stereo_width;
    if (dsp->num_hooks > 0) {
        dsp->hooks[0].enabled = enabled;
    }
    om_mutex_unlock(&dsp->lock);
}

void om_dsp_set_eq_enabled(om_dsp_chain_t *dsp, bool enabled) {
    om_mutex_lock(&dsp->lock);
    if (enabled && !dsp->eq_enabled) {
        for (int b = 0; b < OM_EQ_MAX_BANDS; b++) {
            memset(dsp->biquads[b].z1, 0, sizeof(dsp->biquads[b].z1));
            memset(dsp->biquads[b].z2, 0, sizeof(dsp->biquads[b].z2));
        }
    }
    dsp->eq_enabled = enabled;
    om_mutex_unlock(&dsp->lock);
}

void om_dsp_set_smoothing(om_dsp_chain_t *dsp, bool smoothing_enabled) {
    om_mutex_lock(&dsp->lock);
    dsp->smoothing_enabled = smoothing_enabled;
    if (!smoothing_enabled) {
        dsp->cur_preamp_lin = dsp->target_preamp_lin;
        for (int b = 0; b < dsp->num_bands; b++) {
            dsp->cur_band_db[b] = dsp->target_band_db[b];
        }
        dsp_recalc_all_biquads_unlocked(dsp);
    }
    om_mutex_unlock(&dsp->lock);
}

void om_dsp_set_limiter(om_dsp_chain_t *dsp, bool limiter_enabled) {
    om_mutex_lock(&dsp->lock);
    dsp->limiter_enabled = limiter_enabled;
    om_mutex_unlock(&dsp->lock);
}

void om_dsp_set_band_layout(om_dsp_chain_t *dsp, int num_bands) {
    om_mutex_lock(&dsp->lock);
    int nb = (num_bands >= 10) ? 10 : 5;
    if (nb != dsp->num_bands) {
        dsp->num_bands = nb;
        memset(dsp->target_band_db, 0, sizeof(dsp->target_band_db));
        memset(dsp->cur_band_db, 0, sizeof(dsp->cur_band_db));
        if (nb == 5) {
            memcpy(dsp->band_freqs, g_freqs_5band, sizeof(g_freqs_5band));
        } else {
            memcpy(dsp->band_freqs, g_freqs_10band, sizeof(g_freqs_10band));
        }
        for (int b = 0; b < OM_EQ_MAX_BANDS; b++) {
            memset(dsp->biquads[b].z1, 0, sizeof(dsp->biquads[b].z1));
            memset(dsp->biquads[b].z2, 0, sizeof(dsp->biquads[b].z2));
        }
        dsp_recalc_all_biquads_unlocked(dsp);
    }
    om_mutex_unlock(&dsp->lock);
}

void om_dsp_set_preamp_db(om_dsp_chain_t *dsp, double preamp_db) {
    om_mutex_lock(&dsp->lock);
    dsp->target_preamp_db = clamp_db(preamp_db, -18.0, 18.0);
    dsp->target_preamp_lin = db_to_lin(dsp->target_preamp_db);
    if (!dsp->smoothing_enabled) {
        dsp->cur_preamp_lin = dsp->target_preamp_lin;
    }
    om_mutex_unlock(&dsp->lock);
}

void om_dsp_set_band_gain_db(om_dsp_chain_t *dsp, int band_idx, double gain_db) {
    om_mutex_lock(&dsp->lock);
    if (band_idx >= 0 && band_idx < dsp->num_bands) {
        dsp->target_band_db[band_idx] = clamp_db(gain_db, -15.0, 15.0);
        if (!dsp->smoothing_enabled) {
            dsp->cur_band_db[band_idx] = dsp->target_band_db[band_idx];
            double q = (dsp->num_bands <= 5) ? 1.0 : 1.41421356237;
            biquad_calc_peaking(&dsp->biquads[band_idx], dsp->band_freqs[band_idx], dsp->cur_band_db[band_idx], q, dsp->sample_rate);
        }
    }
    om_mutex_unlock(&dsp->lock);
}

void om_dsp_set_all_bands_db(om_dsp_chain_t *dsp, int num_bands, const double *gains_db, double preamp_db) {
    om_dsp_set_band_layout(dsp, num_bands);
    om_mutex_lock(&dsp->lock);
    dsp->target_preamp_db = clamp_db(preamp_db, -18.0, 18.0);
    dsp->target_preamp_lin = db_to_lin(dsp->target_preamp_db);
    if (!dsp->smoothing_enabled) {
        dsp->cur_preamp_lin = dsp->target_preamp_lin;
    }
    for (int b = 0; b < dsp->num_bands; b++) {
        dsp->target_band_db[b] = clamp_db(gains_db[b], -15.0, 15.0);
        if (!dsp->smoothing_enabled) {
            dsp->cur_band_db[b] = dsp->target_band_db[b];
        }
    }
    if (!dsp->smoothing_enabled) {
        dsp_recalc_all_biquads_unlocked(dsp);
    }
    om_mutex_unlock(&dsp->lock);
}

bool om_dsp_can_bypass_bitperfect(om_dsp_chain_t *dsp, bool is_dop) {
    if (is_dop) return true; /* DoP 24-bit markers must never be altered by PCM DSP */
    om_mutex_lock(&dsp->lock);
    bool any_hook = false;
    for (size_t i = 0; i < dsp->num_hooks; i++) {
        if (dsp->hooks[i].enabled) {
            any_hook = true;
            break;
        }
    }
    bool bypass = (!dsp->eq_enabled && !any_hook);
    om_mutex_unlock(&dsp->lock);
    return bypass;
}

void om_dsp_process(om_dsp_chain_t *dsp, double *pcm, size_t frames, uint16_t channels, uint32_t sample_rate) {
    if (!dsp || !pcm || frames == 0 || channels == 0) return;

    om_mutex_lock(&dsp->lock);
    if (sample_rate > 0 && sample_rate != dsp->sample_rate) {
        dsp->sample_rate = sample_rate;
        dsp_recalc_all_biquads_unlocked(dsp);
    }

    if (dsp->eq_enabled) {
        const double tau_sec = 0.015; /* 15 ms exponential smoothing time constant */
        const double alpha_1 = dsp->smoothing_enabled
            ? (1.0 - exp(-1.0 / (tau_sec * (double)dsp->sample_rate)))
            : 1.0;
        const double alpha_8 = dsp->smoothing_enabled
            ? (1.0 - exp(-8.0 / (tau_sec * (double)dsp->sample_rate)))
            : 1.0;
        const double q = (dsp->num_bands <= 5) ? 1.0 : 1.41421356237;
        const int nb = dsp->num_bands;

        if (!dsp->smoothing_enabled) {
            dsp->cur_preamp_lin = dsp->target_preamp_lin;
        }

        for (size_t f = 0; f < frames; f++) {
            /* Update biquad coefficients smoothly every 8 frames when smoothing is active */
            if (dsp->smoothing_enabled && ((f & 7U) == 0U)) {
                for (int b = 0; b < nb; b++) {
                    double diff = dsp->target_band_db[b] - dsp->cur_band_db[b];
                    if (fabs(diff) > 1e-4) {
                        dsp->cur_band_db[b] += alpha_8 * diff;
                        biquad_calc_peaking(&dsp->biquads[b], dsp->band_freqs[b], dsp->cur_band_db[b], q, dsp->sample_rate);
                    } else if (diff != 0.0) {
                        dsp->cur_band_db[b] = dsp->target_band_db[b];
                        biquad_calc_peaking(&dsp->biquads[b], dsp->band_freqs[b], dsp->cur_band_db[b], q, dsp->sample_rate);
                    }
                }
            }

            /* Per-sample one-pole exponential pre-amp smoothing */
            if (dsp->smoothing_enabled) {
                dsp->cur_preamp_lin += alpha_1 * (dsp->target_preamp_lin - dsp->cur_preamp_lin);
            }
            double pre = dsp->cur_preamp_lin;
            size_t base = f * channels;

            for (uint16_t ch = 0; ch < channels; ch++) {
                double x = pcm[base + ch] * pre;
                for (int b = 0; b < nb; b++) {
                    om_biquad_t *bq = &dsp->biquads[b];
                    double y = bq->b0 * x + bq->z1[ch];
                    bq->z1[ch] = bq->b1 * x - bq->a1 * y + bq->z2[ch];
                    bq->z2[ch] = bq->b2 * x - bq->a2 * y;
                    x = y;
                }
                pcm[base + ch] = x;
            }
        }
    }

    /* Execute registered DSP Pipeline Processing Hooks in order */
    for (size_t h = 0; h < dsp->num_hooks; h++) {
        if (dsp->hooks[h].enabled && dsp->hooks[h].fn) {
            dsp->hooks[h].fn(pcm, frames, channels, dsp->sample_rate, dsp->hooks[h].userdata);
            dsp->meters.hook_invocations++;
        }
    }

    /* Peak/RMS metering + optional anti-clipping soft limiter */
    double peak_l = 0.0, peak_r = 0.0;
    double sum_l = 0.0, sum_r = 0.0;
    uint64_t clipped = 0;

    for (size_t f = 0; f < frames; f++) {
        size_t base = f * channels;
        for (uint16_t ch = 0; ch < channels; ch++) {
            double s = pcm[base + ch];
            if (fabs(s) > 1.0) {
                clipped++;
                if (dsp->limiter_enabled) {
                    /* Smooth soft-knee saturation above 0.95 to prevent harsh digital clipping */
                    double sign = (s >= 0.0) ? 1.0 : -1.0;
                    double ax = fabs(s);
                    if (ax > 0.95) {
                        ax = 0.95 + 0.05 * tanh((ax - 0.95) / 0.05);
                    }
                    s = sign * ax;
                    pcm[base + ch] = s;
                } else {
                    if (s > 1.0) s = 1.0;
                    if (s < -1.0) s = -1.0;
                    pcm[base + ch] = s;
                }
            } else if (dsp->limiter_enabled && fabs(s) > 0.96) {
                double sign = (s >= 0.0) ? 1.0 : -1.0;
                double ax = 0.96 + 0.04 * tanh((fabs(s) - 0.96) / 0.04);
                s = sign * ax;
                pcm[base + ch] = s;
            }

            double as = fabs(s);
            if (ch == 0) {
                if (as > peak_l) peak_l = as;
                sum_l += s * s;
            } else if (ch == 1) {
                if (as > peak_r) peak_r = as;
                sum_r += s * s;
            }
        }
    }

    if (channels == 1) {
        peak_r = peak_l;
        sum_r = sum_l;
    }

    dsp->meters.peak_l = peak_l;
    dsp->meters.peak_r = peak_r;
    dsp->meters.rms_l = sqrt(sum_l / (double)frames);
    dsp->meters.rms_r = sqrt(sum_r / (double)frames);
    dsp->meters.clipped_samples += clipped;
    om_mutex_unlock(&dsp->lock);
}

om_dsp_meters_t om_dsp_get_meters(om_dsp_chain_t *dsp) {
    om_mutex_lock(&dsp->lock);
    om_dsp_meters_t m = dsp->meters;
    om_mutex_unlock(&dsp->lock);
    return m;
}
