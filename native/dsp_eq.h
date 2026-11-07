#ifndef OURMUSIC_DSP_EQ_H
#define OURMUSIC_DSP_EQ_H

#include "audio_formats.h"
#include "os_compat.h"

#define OM_EQ_MAX_BANDS 10
#define OM_DSP_MAX_HOOKS 8

/* Pipeline Processing Hook signature:
 * Inspects or modifies `frames` of interleaved 64-bit float audio in-place. */
typedef void (*om_dsp_hook_fn)(
    double  *interleaved_pcm,
    size_t   frames,
    uint16_t channels,
    uint32_t sample_rate,
    void    *userdata
);

typedef struct {
    const char    *name;
    om_dsp_hook_fn fn;
    void          *userdata;
    bool           enabled;
} om_dsp_hook_entry_t;

typedef struct {
    double b0, b1, b2, a1, a2;
    double z1[OM_MAX_CHANNELS];
    double z2[OM_MAX_CHANNELS];
} om_biquad_t;

typedef struct {
    double   peak_l;
    double   peak_r;
    double   rms_l;
    double   rms_r;
    uint64_t clipped_samples;
    uint64_t hook_invocations;
} om_dsp_meters_t;

typedef struct {
    om_mutex_t lock;

    uint32_t sample_rate;
    uint16_t channels;

    bool     eq_enabled;
    bool     smoothing_enabled;   /* User-controllable parameter smoothing toggle */
    bool     limiter_enabled;     /* Anti-clipping soft ceiling at 0 dBFS */
    int      num_bands;           /* 5 or 10 */
    double   band_freqs[OM_EQ_MAX_BANDS];

    /* Target vs smoothed runtime parameters */
    double   target_preamp_db;
    double   cur_preamp_lin;
    double   target_preamp_lin;

    double   target_band_db[OM_EQ_MAX_BANDS];
    double   cur_band_db[OM_EQ_MAX_BANDS];
    om_biquad_t biquads[OM_EQ_MAX_BANDS];

    /* Built-in custom DSP hook state (Stereo Width / Crossfeed stage) */
    bool     custom_hook_enabled;
    double   stereo_width;        /* 0.0 = mono, 1.0 = neutral, 1.5 = wide */
    uint64_t custom_hook_calls;

    /* Registered pipeline hook chain */
    om_dsp_hook_entry_t hooks[OM_DSP_MAX_HOOKS];
    size_t              num_hooks;

    /* Real-time level telemetry */
    om_dsp_meters_t meters;
} om_dsp_chain_t;

void om_dsp_init(om_dsp_chain_t *dsp);
void om_dsp_destroy(om_dsp_chain_t *dsp);
void om_dsp_configure_stream(om_dsp_chain_t *dsp, uint32_t sample_rate, uint16_t channels);
void om_dsp_reset_state(om_dsp_chain_t *dsp);

/* Register an external or built-in processing hook into the audio pipeline */
int  om_dsp_register_hook(om_dsp_chain_t *dsp, const char *name, om_dsp_hook_fn fn, void *userdata, bool enabled);
void om_dsp_set_custom_hook(om_dsp_chain_t *dsp, bool enabled, double stereo_width);

/* Equalizer configuration (thread-safe, lock-protected for live UI fader updates) */
void om_dsp_set_eq_enabled(om_dsp_chain_t *dsp, bool enabled);
void om_dsp_set_smoothing(om_dsp_chain_t *dsp, bool smoothing_enabled);
void om_dsp_set_limiter(om_dsp_chain_t *dsp, bool limiter_enabled);
void om_dsp_set_band_layout(om_dsp_chain_t *dsp, int num_bands); /* 5 or 10 */
void om_dsp_set_preamp_db(om_dsp_chain_t *dsp, double preamp_db);
void om_dsp_set_band_gain_db(om_dsp_chain_t *dsp, int band_idx, double gain_db);
void om_dsp_set_all_bands_db(om_dsp_chain_t *dsp, int num_bands, const double *gains_db, double preamp_db);

/* Returns true when the pipeline can pass raw integer/DoP frames bit-for-bit */
bool om_dsp_can_bypass_bitperfect(om_dsp_chain_t *dsp, bool is_dop);

/* Process `frames` of interleaved 64-bit float audio in-place */
void om_dsp_process(om_dsp_chain_t *dsp, double *pcm, size_t frames, uint16_t channels, uint32_t sample_rate);

om_dsp_meters_t om_dsp_get_meters(om_dsp_chain_t *dsp);

#endif /* OURMUSIC_DSP_EQ_H */
