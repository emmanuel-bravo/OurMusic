#ifndef OURMUSIC_DSP_RESAMPLER_H
#define OURMUSIC_DSP_RESAMPLER_H

#include "audio_formats.h"

#define OM_SRC_PHASES 1024

typedef enum {
    OM_SRC_QUALITY_FAST  = 0, /* 24 taps/phase, Kaiser beta=8.5  (~96 dB stopband) */
    OM_SRC_QUALITY_HIGH  = 1, /* 48 taps/phase, Kaiser beta=10.6 (~118 dB stopband, default) */
    OM_SRC_QUALITY_ULTRA = 2  /* 96 taps/phase, Kaiser beta=12.4 (>132 dB stopband) */
} om_src_quality_t;

typedef struct {
    uint32_t         in_rate;
    uint32_t         out_rate;
    uint16_t         channels;
    om_src_quality_t quality;
    uint32_t         taps;        /* 24, 48, or 96 */
    double           ratio;       /* (double)in_rate / (double)out_rate */
    double           pos;         /* Fractional input frame cursor */

    /* Polyphase filterbank: (OM_SRC_PHASES + 1) * taps + delta table for 1-FMA interpolation */
    double          *poly_h;
    double          *poly_dh;

    /* Persistent overlap history ((taps - 1) frames) + reusable contiguous work buffer */
    double          *hist;
    double          *work_buf;
    size_t           work_cap_frames;
    bool             initialized;
} om_resampler_t;

void   om_resampler_init(om_resampler_t *rs);
void   om_resampler_destroy(om_resampler_t *rs);
int    om_resampler_configure(om_resampler_t *rs, uint32_t in_rate, uint32_t out_rate, uint16_t channels, om_src_quality_t quality);
void   om_resampler_reset(om_resampler_t *rs);

/* Compute upper bound on output frames for `in_frames` input frames */
size_t om_resampler_max_out_frames(const om_resampler_t *rs, size_t in_frames);

/* Resample `in_frames` interleaved 64-bit float frames into `out_pcm` (capacity `out_cap_frames`).
 * Returns exact number of output frames produced. */
size_t om_resampler_process(
    om_resampler_t * restrict rs,
    const double   * restrict in_pcm,
    size_t                    in_frames,
    double         * restrict out_pcm,
    size_t                    out_cap_frames
);

/* Flush remaining filter group-delay tail at track EOF (optional) */
size_t om_resampler_flush_tail(om_resampler_t * restrict rs, double * restrict out_pcm, size_t out_cap_frames);

#endif /* OURMUSIC_DSP_RESAMPLER_H */
