#ifndef OURMUSIC_DSP_EQ_H
#define OURMUSIC_DSP_EQ_H

#include "audio_formats.h"
#include "dsp_convolver.h"
#include "os_compat.h"

#define OM_EQ_MAX_BANDS    16
#define OM_DSP_MAX_HOOKS   8
#define OM_XFEED_DELAY_CAP 512U

typedef enum {
    OM_FILTER_PEAKING    = 0,
    OM_FILTER_LOW_SHELF  = 1,
    OM_FILTER_HIGH_SHELF = 2,
    OM_FILTER_LOW_PASS   = 3,
    OM_FILTER_HIGH_PASS  = 4,
    OM_FILTER_NOTCH      = 5,
    OM_FILTER_ALL_PASS   = 6
} om_filter_type_t;

typedef enum {
    OM_RG_OFF   = 0,
    OM_RG_TRACK = 1,
    OM_RG_ALBUM = 2
} om_rg_mode_t;

typedef struct {
    om_filter_type_t type;
    double           freq_hz;
    double           q;
    double           gain_db;
    bool             enabled;
} om_peq_band_spec_t;

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
    bool   is_unity;
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

    /* Graphic (5/10-band) & Full Parametric (up to 16-band) Equalizer */
    bool             eq_enabled;
    bool             peq_mode;          /* false = fixed 5/10-band graphic, true = free parametric */
    bool             smoothing_enabled; /* User-controllable parameter smoothing toggle */
    bool             limiter_enabled;   /* Anti-clipping soft ceiling at 0 dBFS */
    int              num_bands;         /* 5, 10, or 1..16 in PEQ mode */

    om_filter_type_t band_types[OM_EQ_MAX_BANDS];
    double           band_freqs[OM_EQ_MAX_BANDS];
    double           band_q[OM_EQ_MAX_BANDS];
    bool             band_enabled[OM_EQ_MAX_BANDS];

    /* Target vs smoothed runtime parameters */
    double           target_preamp_db;
    double           cur_preamp_lin;
    double           target_preamp_lin;

    double           target_band_db[OM_EQ_MAX_BANDS];
    double           cur_band_db[OM_EQ_MAX_BANDS];
    om_biquad_t      biquads[OM_EQ_MAX_BANDS];

    /* ReplayGain 2.0 / EBU R128 Loudness Normalization stage */
    om_rg_mode_t     rg_mode;
    double           rg_track_gain_db;
    double           rg_track_peak;
    double           rg_album_gain_db;
    double           rg_album_peak;
    double           rg_preamp_db;
    bool             rg_prevent_clipping;
    double           rg_effective_lin;

    /* Audiophile Headphone Crossfeed (ILD Low-Pass + ITD Micro-Delay) */
    bool             crossfeed_enabled;
    double           crossfeed_cutoff_hz; /* Default 700 Hz */
    double           crossfeed_feed_db;   /* Cross-channel feed level in dB (-18 .. -1.5, default -6.0) */
    double           crossfeed_itd_us;    /* Interaural Time Difference in us (0 .. 600, default 260) */
    double           xf_lp_state[2];
    double           xf_delay[2][OM_XFEED_DELAY_CAP];
    uint32_t         xf_write_pos;

    /* Zero-Latency Uniformly Partitioned FFT Impulse Response Convolver */
    om_convolver_t   convolver;

    /* Built-in custom DSP hook state (Mid/Side Stereo Width stage) */
    bool             custom_hook_enabled;
    double           stereo_width;        /* 0.0 = mono, 1.0 = neutral, 1.5 = wide */
    uint64_t         custom_hook_calls;

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

/* Graphic Equalizer configuration (thread-safe, 100% backward compatible) */
void om_dsp_set_eq_enabled(om_dsp_chain_t *dsp, bool enabled);
void om_dsp_set_smoothing(om_dsp_chain_t *dsp, bool smoothing_enabled);
void om_dsp_set_limiter(om_dsp_chain_t *dsp, bool limiter_enabled);
void om_dsp_set_band_layout(om_dsp_chain_t *dsp, int num_bands); /* 5 or 10 */
void om_dsp_set_preamp_db(om_dsp_chain_t *dsp, double preamp_db);
void om_dsp_set_band_gain_db(om_dsp_chain_t *dsp, int band_idx, double gain_db);
void om_dsp_set_all_bands_db(om_dsp_chain_t *dsp, int num_bands, const double *gains_db, double preamp_db);

/* Full Parametric Equalizer (PEQ) configuration */
void om_dsp_set_peq_bands(om_dsp_chain_t *dsp, int num_bands, const om_peq_band_spec_t *bands, double preamp_db);
void om_dsp_set_peq_single_band(om_dsp_chain_t *dsp, int band_idx, om_filter_type_t type, double freq_hz, double q, double gain_db, bool enabled);
om_filter_type_t om_filter_type_from_str(const char *s);
const char      *om_filter_type_to_str(om_filter_type_t t);

/* ReplayGain / EBU R128 Normalization configuration */
void om_dsp_set_replaygain(
    om_dsp_chain_t *dsp,
    om_rg_mode_t    mode,
    double          track_gain_db,
    double          track_peak,
    double          album_gain_db,
    double          album_peak,
    double          preamp_db,
    bool            prevent_clipping
);

/* Headphone Crossfeed (ILD + ITD) configuration */
void om_dsp_set_crossfeed(om_dsp_chain_t *dsp, bool enabled, double cutoff_hz, double feed_db, double itd_us);

/* Partitioned FFT Impulse Response Convolver configuration */
int  om_dsp_set_convolver(om_dsp_chain_t *dsp, bool enabled, const char *ir_path, double wet_mix, double gain_db, bool auto_norm, char *err, size_t err_cap);

/* Returns true when the pipeline can pass raw integer/DoP/DSD frames bit-for-bit */
bool om_dsp_can_bypass_bitperfect(om_dsp_chain_t *dsp, bool is_raw_dsd_or_dop);

/* Process `frames` of interleaved 64-bit float audio in-place */
void om_dsp_process(om_dsp_chain_t *dsp, double * restrict pcm, size_t frames, uint16_t channels, uint32_t sample_rate);

om_dsp_meters_t om_dsp_get_meters(om_dsp_chain_t *dsp);

#endif /* OURMUSIC_DSP_EQ_H */
