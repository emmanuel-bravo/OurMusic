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

static inline double clamp_val(double v, double lo, double hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

static inline double db_to_lin(double db) {
    return pow(10.0, db / 20.0);
}

/* Fast smooth C^2 Padé [3/2] rational tanh approximation (zero libm calls in hot loop) */
static inline double fast_tanh_pade(double x) {
    if (x >= 3.0) return 1.0;
    if (x <= -3.0) return -1.0;
    double x2 = x * x;
    return x * (27.0 + x2) / (27.0 + 9.0 * x2);
}

om_filter_type_t om_filter_type_from_str(const char *s) {
    if (!s || !s[0]) return OM_FILTER_PEAKING;
    if (om_strcasecmp(s, "low_shelf") == 0 || om_strcasecmp(s, "lowshelf") == 0 || om_strcasecmp(s, "ls") == 0) {
        return OM_FILTER_LOW_SHELF;
    }
    if (om_strcasecmp(s, "high_shelf") == 0 || om_strcasecmp(s, "highshelf") == 0 || om_strcasecmp(s, "hs") == 0) {
        return OM_FILTER_HIGH_SHELF;
    }
    if (om_strcasecmp(s, "low_pass") == 0 || om_strcasecmp(s, "lowpass") == 0 || om_strcasecmp(s, "lpf") == 0) {
        return OM_FILTER_LOW_PASS;
    }
    if (om_strcasecmp(s, "high_pass") == 0 || om_strcasecmp(s, "highpass") == 0 || om_strcasecmp(s, "hpf") == 0) {
        return OM_FILTER_HIGH_PASS;
    }
    if (om_strcasecmp(s, "notch") == 0 || om_strcasecmp(s, "band_stop") == 0) {
        return OM_FILTER_NOTCH;
    }
    if (om_strcasecmp(s, "all_pass") == 0 || om_strcasecmp(s, "allpass") == 0 || om_strcasecmp(s, "apf") == 0) {
        return OM_FILTER_ALL_PASS;
    }
    return OM_FILTER_PEAKING;
}

const char *om_filter_type_to_str(om_filter_type_t t) {
    switch (t) {
        case OM_FILTER_LOW_SHELF:  return "low_shelf";
        case OM_FILTER_HIGH_SHELF: return "high_shelf";
        case OM_FILTER_LOW_PASS:   return "low_pass";
        case OM_FILTER_HIGH_PASS:  return "high_pass";
        case OM_FILTER_NOTCH:      return "notch";
        case OM_FILTER_ALL_PASS:   return "all_pass";
        default:                   return "peaking";
    }
}

/*
 * Robert Bristow-Johnson 64-bit Parametric Biquad Designer
 * Supports Peaking, Low-Shelf, High-Shelf, Low-Pass, High-Pass, Notch, and All-Pass.
 */
static void biquad_calc_parametric(
    om_biquad_t     *bq,
    om_filter_type_t type,
    double           fc,
    double           gain_db,
    double           q,
    bool             band_enabled,
    uint32_t         sr
) {
    bool gain_based = (type == OM_FILTER_PEAKING || type == OM_FILTER_LOW_SHELF || type == OM_FILTER_HIGH_SHELF);
    if (!band_enabled || sr == 0 || fc <= 5.0 || fc >= 0.488 * (double)sr || (gain_based && fabs(gain_db) < 1e-6)) {
        bq->b0 = 1.0;
        bq->b1 = 0.0;
        bq->b2 = 0.0;
        bq->a1 = 0.0;
        bq->a2 = 0.0;
        bq->is_unity = true;
        return;
    }

    if (q < 0.1) q = 0.1;
    if (q > 24.0) q = 24.0;

    const double w0    = 2.0 * M_PI * fc / (double)sr;
    const double cosw0 = cos(w0);
    const double sinw0 = sin(w0);
    const double alpha = sinw0 / (2.0 * q);

    double b0 = 1.0, b1 = 0.0, b2 = 0.0, a0 = 1.0, a1 = 0.0, a2 = 0.0;

    switch (type) {
        case OM_FILTER_PEAKING: {
            double A = pow(10.0, gain_db / 40.0);
            b0 =  1.0 + alpha * A;
            b1 = -2.0 * cosw0;
            b2 =  1.0 - alpha * A;
            a0 =  1.0 + alpha / A;
            a1 = -2.0 * cosw0;
            a2 =  1.0 - alpha / A;
            break;
        }
        case OM_FILTER_LOW_SHELF: {
            double A = pow(10.0, gain_db / 40.0);
            double sq = 2.0 * sqrt(A) * alpha;
            b0 =    A * ((A + 1.0) - (A - 1.0) * cosw0 + sq);
            b1 =  2.0 * A * ((A - 1.0) - (A + 1.0) * cosw0);
            b2 =    A * ((A + 1.0) - (A - 1.0) * cosw0 - sq);
            a0 =        (A + 1.0) + (A - 1.0) * cosw0 + sq;
            a1 = -2.0 * ((A - 1.0) + (A + 1.0) * cosw0);
            a2 =        (A + 1.0) + (A - 1.0) * cosw0 - sq;
            break;
        }
        case OM_FILTER_HIGH_SHELF: {
            double A = pow(10.0, gain_db / 40.0);
            double sq = 2.0 * sqrt(A) * alpha;
            b0 =    A * ((A + 1.0) + (A - 1.0) * cosw0 + sq);
            b1 = -2.0 * A * ((A - 1.0) + (A + 1.0) * cosw0);
            b2 =    A * ((A + 1.0) + (A - 1.0) * cosw0 - sq);
            a0 =        (A + 1.0) - (A - 1.0) * cosw0 + sq;
            a1 =  2.0 * ((A - 1.0) - (A + 1.0) * cosw0);
            a2 =        (A + 1.0) - (A - 1.0) * cosw0 - sq;
            break;
        }
        case OM_FILTER_LOW_PASS:
            b0 = (1.0 - cosw0) * 0.5;
            b1 =  1.0 - cosw0;
            b2 = (1.0 - cosw0) * 0.5;
            a0 =  1.0 + alpha;
            a1 = -2.0 * cosw0;
            a2 =  1.0 - alpha;
            break;
        case OM_FILTER_HIGH_PASS:
            b0 =  (1.0 + cosw0) * 0.5;
            b1 = -(1.0 + cosw0);
            b2 =  (1.0 + cosw0) * 0.5;
            a0 =   1.0 + alpha;
            a1 =  -2.0 * cosw0;
            a2 =   1.0 - alpha;
            break;
        case OM_FILTER_NOTCH:
            b0 =  1.0;
            b1 = -2.0 * cosw0;
            b2 =  1.0;
            a0 =  1.0 + alpha;
            a1 = -2.0 * cosw0;
            a2 =  1.0 - alpha;
            break;
        case OM_FILTER_ALL_PASS:
            b0 =  1.0 - alpha;
            b1 = -2.0 * cosw0;
            b2 =  1.0 + alpha;
            a0 =  1.0 + alpha;
            a1 = -2.0 * cosw0;
            a2 =  1.0 - alpha;
            break;
    }

    double inv_a0 = 1.0 / a0;
    bq->b0 = b0 * inv_a0;
    bq->b1 = b1 * inv_a0;
    bq->b2 = b2 * inv_a0;
    bq->a1 = a1 * inv_a0;
    bq->a2 = a2 * inv_a0;
    bq->is_unity = false;
}

static void dsp_recalc_all_biquads_unlocked(om_dsp_chain_t *dsp) {
    for (int b = 0; b < dsp->num_bands && b < OM_EQ_MAX_BANDS; b++) {
        biquad_calc_parametric(
            &dsp->biquads[b],
            dsp->band_types[b],
            dsp->band_freqs[b],
            dsp->cur_band_db[b],
            dsp->band_q[b],
            dsp->band_enabled[b],
            dsp->sample_rate
        );
    }
}

static void dsp_update_rg_linear_unlocked(om_dsp_chain_t *dsp) {
    if (dsp->rg_mode == OM_RG_OFF) {
        dsp->rg_effective_lin = 1.0;
        return;
    }
    double gdb  = (dsp->rg_mode == OM_RG_ALBUM) ? dsp->rg_album_gain_db : dsp->rg_track_gain_db;
    double peak = (dsp->rg_mode == OM_RG_ALBUM && dsp->rg_album_peak > 0.0)
                ? dsp->rg_album_peak : dsp->rg_track_peak;
    double lin = db_to_lin(gdb + dsp->rg_preamp_db);
    if (dsp->rg_prevent_clipping && peak > 1e-6 && (lin * peak) > 0.995) {
        lin = 0.995 / peak;
    }
    dsp->rg_effective_lin = lin;
}

/* Built-in pipeline hook: Mid-Side Stereo Stage */
static void builtin_stereo_stage_hook(
    double  *pcm,
    size_t   frames,
    uint16_t channels,
    uint32_t sample_rate,
    void    *userdata
) {
    (void)sample_rate;
    om_dsp_chain_t *dsp = (om_dsp_chain_t *)userdata;
    dsp->custom_hook_calls++;
    if (channels < 2) return;

    const double w = dsp->stereo_width;
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
    om_convolver_init(&dsp->convolver);

    dsp->sample_rate = 44100;
    dsp->channels = 2;
    dsp->eq_enabled = false;
    dsp->peq_mode = false;
    dsp->smoothing_enabled = true;
    dsp->limiter_enabled = true;
    dsp->num_bands = 5;
    memcpy(dsp->band_freqs, g_freqs_5band, sizeof(g_freqs_5band));
    for (int b = 0; b < OM_EQ_MAX_BANDS; b++) {
        dsp->band_types[b] = OM_FILTER_PEAKING;
        dsp->band_q[b] = 1.0;
        dsp->band_enabled[b] = true;
        dsp->biquads[b].b0 = 1.0;
        dsp->biquads[b].is_unity = true;
    }

    dsp->target_preamp_db = 0.0;
    dsp->cur_preamp_lin = 1.0;
    dsp->target_preamp_lin = 1.0;
    dsp->stereo_width = 1.0;

    dsp->rg_mode = OM_RG_OFF;
    dsp->rg_prevent_clipping = true;
    dsp->rg_effective_lin = 1.0;

    dsp->crossfeed_enabled = false;
    dsp->crossfeed_cutoff_hz = 700.0;
    dsp->crossfeed_feed_db = -6.0;
    dsp->crossfeed_itd_us = 260.0;

    dsp_recalc_all_biquads_unlocked(dsp);

    /* Slot 0 in the hook chain is the built-in controllable stereo stage hook */
    om_dsp_register_hook(dsp, "stereo_stage_hook", builtin_stereo_stage_hook, dsp, false);
}

void om_dsp_destroy(om_dsp_chain_t *dsp) {
    om_convolver_destroy(&dsp->convolver);
    om_mutex_destroy(&dsp->lock);
}

void om_dsp_reset_state(om_dsp_chain_t *dsp) {
    om_mutex_lock(&dsp->lock);
    for (int b = 0; b < OM_EQ_MAX_BANDS; b++) {
        memset(dsp->biquads[b].z1, 0, sizeof(dsp->biquads[b].z1));
        memset(dsp->biquads[b].z2, 0, sizeof(dsp->biquads[b].z2));
        dsp->cur_band_db[b] = dsp->target_band_db[b];
    }
    memset(dsp->xf_lp_state, 0, sizeof(dsp->xf_lp_state));
    memset(dsp->xf_delay, 0, sizeof(dsp->xf_delay));
    dsp->xf_write_pos = 0;
    dsp->cur_preamp_lin = dsp->target_preamp_lin;
    dsp_recalc_all_biquads_unlocked(dsp);
    om_convolver_reset(&dsp->convolver);
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
    memset(dsp->xf_lp_state, 0, sizeof(dsp->xf_lp_state));
    memset(dsp->xf_delay, 0, sizeof(dsp->xf_delay));
    dsp->xf_write_pos = 0;
    dsp->cur_preamp_lin = dsp->target_preamp_lin;
    dsp_recalc_all_biquads_unlocked(dsp);
    om_convolver_configure_stream(&dsp->convolver, dsp->sample_rate, dsp->channels);
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
    dsp->stereo_width = clamp_val(stereo_width, 0.0, 2.0);
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
    double default_q = (nb <= 5) ? 1.0 : 1.41421356237;
    if (nb != dsp->num_bands || dsp->peq_mode) {
        dsp->peq_mode = false;
        dsp->num_bands = nb;
        memset(dsp->target_band_db, 0, sizeof(dsp->target_band_db));
        memset(dsp->cur_band_db, 0, sizeof(dsp->cur_band_db));
        if (nb == 5) {
            memcpy(dsp->band_freqs, g_freqs_5band, sizeof(g_freqs_5band));
        } else {
            memcpy(dsp->band_freqs, g_freqs_10band, sizeof(g_freqs_10band));
        }
        for (int b = 0; b < OM_EQ_MAX_BANDS; b++) {
            dsp->band_types[b] = OM_FILTER_PEAKING;
            dsp->band_q[b] = default_q;
            dsp->band_enabled[b] = true;
            memset(dsp->biquads[b].z1, 0, sizeof(dsp->biquads[b].z1));
            memset(dsp->biquads[b].z2, 0, sizeof(dsp->biquads[b].z2));
        }
        dsp_recalc_all_biquads_unlocked(dsp);
    }
    om_mutex_unlock(&dsp->lock);
}

void om_dsp_set_preamp_db(om_dsp_chain_t *dsp, double preamp_db) {
    om_mutex_lock(&dsp->lock);
    dsp->target_preamp_db = clamp_val(preamp_db, -24.0, 18.0);
    dsp->target_preamp_lin = db_to_lin(dsp->target_preamp_db);
    if (!dsp->smoothing_enabled) {
        dsp->cur_preamp_lin = dsp->target_preamp_lin;
    }
    om_mutex_unlock(&dsp->lock);
}

void om_dsp_set_band_gain_db(om_dsp_chain_t *dsp, int band_idx, double gain_db) {
    om_mutex_lock(&dsp->lock);
    if (band_idx >= 0 && band_idx < dsp->num_bands) {
        dsp->target_band_db[band_idx] = clamp_val(gain_db, -18.0, 18.0);
        if (!dsp->smoothing_enabled) {
            dsp->cur_band_db[band_idx] = dsp->target_band_db[band_idx];
            biquad_calc_parametric(
                &dsp->biquads[band_idx],
                dsp->band_types[band_idx],
                dsp->band_freqs[band_idx],
                dsp->cur_band_db[band_idx],
                dsp->band_q[band_idx],
                dsp->band_enabled[band_idx],
                dsp->sample_rate
            );
        }
    }
    om_mutex_unlock(&dsp->lock);
}

void om_dsp_set_all_bands_db(om_dsp_chain_t *dsp, int num_bands, const double *gains_db, double preamp_db) {
    om_dsp_set_band_layout(dsp, num_bands);
    om_mutex_lock(&dsp->lock);
    dsp->target_preamp_db = clamp_val(preamp_db, -24.0, 18.0);
    dsp->target_preamp_lin = db_to_lin(dsp->target_preamp_db);
    if (!dsp->smoothing_enabled) {
        dsp->cur_preamp_lin = dsp->target_preamp_lin;
    }
    for (int b = 0; b < dsp->num_bands; b++) {
        dsp->target_band_db[b] = clamp_val(gains_db[b], -18.0, 18.0);
        if (!dsp->smoothing_enabled) {
            dsp->cur_band_db[b] = dsp->target_band_db[b];
        }
    }
    if (!dsp->smoothing_enabled) {
        dsp_recalc_all_biquads_unlocked(dsp);
    }
    om_mutex_unlock(&dsp->lock);
}

void om_dsp_set_peq_bands(om_dsp_chain_t *dsp, int num_bands, const om_peq_band_spec_t *bands, double preamp_db) {
    if (!dsp || !bands) return;
    int nb = num_bands;
    if (nb < 1) nb = 1;
    if (nb > OM_EQ_MAX_BANDS) nb = OM_EQ_MAX_BANDS;

    om_mutex_lock(&dsp->lock);
    dsp->peq_mode = true;
    dsp->num_bands = nb;
    dsp->target_preamp_db = clamp_val(preamp_db, -24.0, 18.0);
    dsp->target_preamp_lin = db_to_lin(dsp->target_preamp_db);
    if (!dsp->smoothing_enabled) {
        dsp->cur_preamp_lin = dsp->target_preamp_lin;
    }

    for (int b = 0; b < nb; b++) {
        dsp->band_types[b] = bands[b].type;
        dsp->band_freqs[b] = clamp_val(bands[b].freq_hz, 10.0, 24000.0);
        dsp->band_q[b] = clamp_val(bands[b].q, 0.1, 24.0);
        dsp->band_enabled[b] = bands[b].enabled;
        dsp->target_band_db[b] = clamp_val(bands[b].gain_db, -24.0, 24.0);
        dsp->cur_band_db[b] = dsp->target_band_db[b];
        memset(dsp->biquads[b].z1, 0, sizeof(dsp->biquads[b].z1));
        memset(dsp->biquads[b].z2, 0, sizeof(dsp->biquads[b].z2));
    }
    dsp_recalc_all_biquads_unlocked(dsp);
    om_mutex_unlock(&dsp->lock);
}

void om_dsp_set_peq_single_band(
    om_dsp_chain_t  *dsp,
    int              band_idx,
    om_filter_type_t type,
    double           freq_hz,
    double           q,
    double           gain_db,
    bool             enabled
) {
    if (!dsp || band_idx < 0 || band_idx >= OM_EQ_MAX_BANDS) return;
    om_mutex_lock(&dsp->lock);
    dsp->peq_mode = true;
    if (band_idx >= dsp->num_bands) {
        dsp->num_bands = band_idx + 1;
    }
    dsp->band_types[band_idx] = type;
    dsp->band_freqs[band_idx] = clamp_val(freq_hz, 10.0, 24000.0);
    dsp->band_q[band_idx] = clamp_val(q, 0.1, 24.0);
    dsp->band_enabled[band_idx] = enabled;
    dsp->target_band_db[band_idx] = clamp_val(gain_db, -24.0, 24.0);
    if (!dsp->smoothing_enabled || type != OM_FILTER_PEAKING) {
        dsp->cur_band_db[band_idx] = dsp->target_band_db[band_idx];
    }
    biquad_calc_parametric(
        &dsp->biquads[band_idx],
        dsp->band_types[band_idx],
        dsp->band_freqs[band_idx],
        dsp->cur_band_db[band_idx],
        dsp->band_q[band_idx],
        dsp->band_enabled[band_idx],
        dsp->sample_rate
    );
    om_mutex_unlock(&dsp->lock);
}

void om_dsp_set_replaygain(
    om_dsp_chain_t *dsp,
    om_rg_mode_t    mode,
    double          track_gain_db,
    double          track_peak,
    double          album_gain_db,
    double          album_peak,
    double          preamp_db,
    bool            prevent_clipping
) {
    if (!dsp) return;
    om_mutex_lock(&dsp->lock);
    dsp->rg_mode = mode;
    dsp->rg_track_gain_db = clamp_val(track_gain_db, -36.0, 36.0);
    dsp->rg_track_peak = (track_peak > 0.0) ? track_peak : 0.0;
    dsp->rg_album_gain_db = clamp_val(album_gain_db, -36.0, 36.0);
    dsp->rg_album_peak = (album_peak > 0.0) ? album_peak : 0.0;
    dsp->rg_preamp_db = clamp_val(preamp_db, -18.0, 18.0);
    dsp->rg_prevent_clipping = prevent_clipping;
    dsp_update_rg_linear_unlocked(dsp);
    om_mutex_unlock(&dsp->lock);
}

void om_dsp_set_crossfeed(om_dsp_chain_t *dsp, bool enabled, double cutoff_hz, double feed_db, double itd_us) {
    if (!dsp) return;
    om_mutex_lock(&dsp->lock);
    if (enabled && !dsp->crossfeed_enabled) {
        memset(dsp->xf_lp_state, 0, sizeof(dsp->xf_lp_state));
        memset(dsp->xf_delay, 0, sizeof(dsp->xf_delay));
        dsp->xf_write_pos = 0;
    }
    dsp->crossfeed_enabled = enabled;
    if (cutoff_hz > 0.0) dsp->crossfeed_cutoff_hz = clamp_val(cutoff_hz, 300.0, 2000.0);
    dsp->crossfeed_feed_db = clamp_val(feed_db, -24.0, -1.5);
    if (itd_us >= 0.0) dsp->crossfeed_itd_us = clamp_val(itd_us, 0.0, 600.0);
    om_mutex_unlock(&dsp->lock);
}

int om_dsp_set_convolver(
    om_dsp_chain_t *dsp,
    bool            enabled,
    const char     *ir_path,
    double          wet_mix,
    double          gain_db,
    bool            auto_norm,
    char           *err,
    size_t          err_cap
) {
    if (!dsp) return -1;
    om_mutex_lock(&dsp->lock);
    dsp->convolver.wet_mix = clamp_val(wet_mix, 0.0, 1.0);
    dsp->convolver.ir_gain_db = clamp_val(gain_db, -24.0, 18.0);
    dsp->convolver.auto_normalize = auto_norm;

    if (ir_path && ir_path[0] != '\0') {
        if (strcmp(dsp->convolver.ir_path, ir_path) != 0 || !dsp->convolver.ir_loaded) {
            if (om_convolver_load_ir(&dsp->convolver, ir_path, err, err_cap) != 0) {
                dsp->convolver.enabled = false;
                om_mutex_unlock(&dsp->lock);
                return -1;
            }
        } else {
            /* Rebuild partitions if gain_db or auto_normalize changed */
            om_convolver_configure_stream(&dsp->convolver, dsp->sample_rate, dsp->channels);
        }
    } else if (!enabled) {
        /* Keep loaded IR cached or allow disabling cleanly */
    }

    dsp->convolver.enabled = enabled && dsp->convolver.ir_loaded;
    om_mutex_unlock(&dsp->lock);
    return 0;
}

bool om_dsp_can_bypass_bitperfect(om_dsp_chain_t *dsp, bool is_raw_dsd_or_dop) {
    if (is_raw_dsd_or_dop) return true; /* DoP / Native DSD bitstreams must never be altered by PCM DSP */
    om_mutex_lock(&dsp->lock);
    bool any_hook = false;
    for (size_t i = 0; i < dsp->num_hooks; i++) {
        if (dsp->hooks[i].enabled) {
            any_hook = true;
            break;
        }
    }
    bool conv_active = (dsp->convolver.enabled && dsp->convolver.ir_loaded);
    bool rg_active   = (dsp->rg_mode != OM_RG_OFF && fabs(dsp->rg_effective_lin - 1.0) > 1e-5);
    bool bypass      = (!dsp->eq_enabled && !dsp->crossfeed_enabled && !conv_active && !rg_active && !any_hook);
    om_mutex_unlock(&dsp->lock);
    return bypass;
}

void om_dsp_process(om_dsp_chain_t *dsp, double * restrict pcm, size_t frames, uint16_t channels, uint32_t sample_rate) {
    if (!dsp || !pcm || frames == 0 || channels == 0) return;

    om_mutex_lock(&dsp->lock);
    if (sample_rate > 0 && sample_rate != dsp->sample_rate) {
        dsp->sample_rate = sample_rate;
        dsp_recalc_all_biquads_unlocked(dsp);
        om_convolver_configure_stream(&dsp->convolver, dsp->sample_rate, channels);
    }

    /* 1. ReplayGain / EBU R128 Normalization Gain Stage */
    if (dsp->rg_mode != OM_RG_OFF && fabs(dsp->rg_effective_lin - 1.0) > 1e-6) {
        const double rg_g = dsp->rg_effective_lin;
        const size_t total_s = frames * channels;
        for (size_t i = 0; i < total_s; i++) {
            pcm[i] *= rg_g;
        }
    }

    /* 2. 64-Bit Graphic / Parametric Biquad Equalizer (Unrolled Stereo Fast-Path) */
    if (dsp->eq_enabled) {
        const double tau_sec = 0.015; /* 15 ms exponential smoothing time constant */
        const double alpha_1 = dsp->smoothing_enabled
            ? (1.0 - exp(-1.0 / (tau_sec * (double)dsp->sample_rate)))
            : 1.0;
        const double alpha_8 = dsp->smoothing_enabled
            ? (1.0 - exp(-8.0 / (tau_sec * (double)dsp->sample_rate)))
            : 1.0;
        const int nb = dsp->num_bands;

        if (!dsp->smoothing_enabled) {
            dsp->cur_preamp_lin = dsp->target_preamp_lin;
        }

        if (channels == 2) {
            for (size_t f = 0; f < frames; f++) {
                if (dsp->smoothing_enabled && ((f & 7U) == 0U)) {
                    for (int b = 0; b < nb; b++) {
                        double diff = dsp->target_band_db[b] - dsp->cur_band_db[b];
                        if (fabs(diff) > 1e-4) {
                            dsp->cur_band_db[b] += alpha_8 * diff;
                            biquad_calc_parametric(&dsp->biquads[b], dsp->band_types[b], dsp->band_freqs[b],
                                                   dsp->cur_band_db[b], dsp->band_q[b], dsp->band_enabled[b], dsp->sample_rate);
                        } else if (diff != 0.0) {
                            dsp->cur_band_db[b] = dsp->target_band_db[b];
                            biquad_calc_parametric(&dsp->biquads[b], dsp->band_types[b], dsp->band_freqs[b],
                                                   dsp->cur_band_db[b], dsp->band_q[b], dsp->band_enabled[b], dsp->sample_rate);
                        }
                    }
                }

                if (dsp->smoothing_enabled) {
                    dsp->cur_preamp_lin += alpha_1 * (dsp->target_preamp_lin - dsp->cur_preamp_lin);
                }
                const double pre = dsp->cur_preamp_lin;
                double xL = pcm[f * 2U + 0] * pre;
                double xR = pcm[f * 2U + 1] * pre;

                for (int b = 0; b < nb; b++) {
                    om_biquad_t * restrict bq = &dsp->biquads[b];
                    if (bq->is_unity) continue;

                    double b0 = bq->b0, b1 = bq->b1, b2 = bq->b2, a1 = bq->a1, a2 = bq->a2;
                    double yL = b0 * xL + bq->z1[0];
                    double yR = b0 * xR + bq->z1[1];
                    bq->z1[0] = b1 * xL - a1 * yL + bq->z2[0];
                    bq->z1[1] = b1 * xR - a1 * yR + bq->z2[1];
                    bq->z2[0] = b2 * xL - a2 * yL;
                    bq->z2[1] = b2 * xR - a2 * yR;
                    xL = yL;
                    xR = yR;
                }

                pcm[f * 2U + 0] = xL;
                pcm[f * 2U + 1] = xR;
            }
        } else {
            for (size_t f = 0; f < frames; f++) {
                if (dsp->smoothing_enabled && ((f & 7U) == 0U)) {
                    for (int b = 0; b < nb; b++) {
                        double diff = dsp->target_band_db[b] - dsp->cur_band_db[b];
                        if (fabs(diff) > 1e-4) {
                            dsp->cur_band_db[b] += alpha_8 * diff;
                            biquad_calc_parametric(&dsp->biquads[b], dsp->band_types[b], dsp->band_freqs[b],
                                                   dsp->cur_band_db[b], dsp->band_q[b], dsp->band_enabled[b], dsp->sample_rate);
                        } else if (diff != 0.0) {
                            dsp->cur_band_db[b] = dsp->target_band_db[b];
                            biquad_calc_parametric(&dsp->biquads[b], dsp->band_types[b], dsp->band_freqs[b],
                                                   dsp->cur_band_db[b], dsp->band_q[b], dsp->band_enabled[b], dsp->sample_rate);
                        }
                    }
                }
                if (dsp->smoothing_enabled) {
                    dsp->cur_preamp_lin += alpha_1 * (dsp->target_preamp_lin - dsp->cur_preamp_lin);
                }
                const double pre = dsp->cur_preamp_lin;
                size_t base = f * channels;

                for (uint16_t ch = 0; ch < channels; ch++) {
                    double x = pcm[base + ch] * pre;
                    for (int b = 0; b < nb; b++) {
                        om_biquad_t * restrict bq = &dsp->biquads[b];
                        if (bq->is_unity) continue;
                        double y = bq->b0 * x + bq->z1[ch];
                        bq->z1[ch] = bq->b1 * x - bq->a1 * y + bq->z2[ch];
                        bq->z2[ch] = bq->b2 * x - bq->a2 * y;
                        x = y;
                    }
                    pcm[base + ch] = x;
                }
            }
        }
    }

    /* 3. Zero-Latency Uniformly Partitioned FFT Impulse Response Convolver */
    if (dsp->convolver.enabled && dsp->convolver.ir_loaded) {
        om_convolver_process(&dsp->convolver, pcm, frames, channels);
    }

    /* 4. Audiophile Headphone Crossfeed (Bauer / Meier ILD Low-Pass + ITD Micro-Delay) */
    if (dsp->crossfeed_enabled && channels >= 2) {
        const double alpha_lp = 1.0 - exp(-2.0 * M_PI * dsp->crossfeed_cutoff_hz / (double)dsp->sample_rate);
        const double feed_lin = db_to_lin(dsp->crossfeed_feed_db);
        /* Compensate center bass buildup so mono bass remains balanced */
        const double direct_gain = 1.0 / (1.0 + 0.70 * feed_lin);
        const double cross_gain  = feed_lin * direct_gain;
        uint32_t delay_samp = (uint32_t)floor((dsp->crossfeed_itd_us * 1e-6 * (double)dsp->sample_rate) + 0.5);
        if (delay_samp >= OM_XFEED_DELAY_CAP) delay_samp = OM_XFEED_DELAY_CAP - 1U;

        double lpL = dsp->xf_lp_state[0];
        double lpR = dsp->xf_lp_state[1];
        uint32_t w = dsp->xf_write_pos;
        const uint32_t mask = OM_XFEED_DELAY_CAP - 1U;

        for (size_t f = 0; f < frames; f++) {
            size_t base = f * channels;
            double inL = pcm[base + 0];
            double inR = pcm[base + 1];

            lpL += alpha_lp * (inL - lpL);
            lpR += alpha_lp * (inR - lpR);

            dsp->xf_delay[0][w] = lpL;
            dsp->xf_delay[1][w] = lpR;

            uint32_t r_idx = (w - delay_samp) & mask;
            double delayed_lpL = dsp->xf_delay[0][r_idx];
            double delayed_lpR = dsp->xf_delay[1][r_idx];

            pcm[base + 0] = direct_gain * inL + cross_gain * delayed_lpR;
            pcm[base + 1] = direct_gain * inR + cross_gain * delayed_lpL;

            w = (w + 1U) & mask;
        }

        dsp->xf_lp_state[0] = lpL;
        dsp->xf_lp_state[1] = lpR;
        dsp->xf_write_pos = w;
    }

    /* 5. Execute registered DSP Pipeline Processing Hooks in order */
    for (size_t h = 0; h < dsp->num_hooks; h++) {
        if (dsp->hooks[h].enabled && dsp->hooks[h].fn) {
            dsp->hooks[h].fn(pcm, frames, channels, dsp->sample_rate, dsp->hooks[h].userdata);
            dsp->meters.hook_invocations++;
        }
    }

    /* 6. Peak/RMS metering + branch-light Padé soft-knee ceiling limiter */
    double peak_l = 0.0, peak_r = 0.0;
    double sum_l = 0.0, sum_r = 0.0;
    uint64_t clipped = 0;
    const bool lim = dsp->limiter_enabled;

    for (size_t f = 0; f < frames; f++) {
        size_t base = f * channels;
        for (uint16_t ch = 0; ch < channels; ch++) {
            double s = pcm[base + ch];
            double as = fabs(s);

            if (as > 0.96) {
                if (as > 1.0) clipped++;
                if (lim) {
                    double sign = (s >= 0.0) ? 1.0 : -1.0;
                    as = 0.96 + 0.04 * fast_tanh_pade((as - 0.96) * 25.0);
                    s = sign * as;
                    pcm[base + ch] = s;
                } else if (as > 1.0) {
                    s = (s >= 0.0) ? 1.0 : -1.0;
                    as = 1.0;
                    pcm[base + ch] = s;
                }
            }

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
