#ifndef OURMUSIC_DSP_CONVOLVER_H
#define OURMUSIC_DSP_CONVOLVER_H

#include "audio_formats.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define OM_CONV_PART_LEN      256U
#define OM_CONV_FFT_LEN       512U
#define OM_CONV_MAX_IR_FRAMES 131072U

typedef struct {
    /* Time-domain zero-latency head (first 256 taps, reversed for forward SIMD dot-product) */
    double   head_rev[OM_CONV_PART_LEN];
    double   td_hist[OM_CONV_PART_LEN * 2U];
    uint32_t td_write_pos;

    /* Uniformly partitioned FFT tail state */
    double   in_blk[OM_CONV_PART_LEN];
    double   out_tail_cur[OM_CONV_PART_LEN];
    double   out_overlap[OM_CONV_PART_LEN];
    uint32_t in_pos;
    uint32_t fdl_head;
    double  *fdl_re; /* [num_tail_parts * OM_CONV_FFT_LEN] */
    double  *fdl_im; /* [num_tail_parts * OM_CONV_FFT_LEN] */
} om_conv_chan_t;

typedef struct {
    bool     enabled;
    bool     ir_loaded;
    char     ir_path[1024];
    double   wet_mix;         /* 0.0 = dry, 1.0 = 100% convolved (default 1.0) */
    double   ir_gain_db;      /* Optional headroom gain trim in dB (default 0.0) */
    bool     auto_normalize;  /* Clamp peak frequency-response gain <= 0 dB */

    /* Original un-resampled IR stored in memory (mono or stereo) */
    uint32_t raw_ir_rate;
    uint16_t raw_ir_channels;
    size_t   raw_ir_frames;
    double  *raw_ir_ch[2];

    /* Active stream configuration */
    uint32_t stream_rate;
    uint16_t stream_channels;
    size_t   active_ir_frames;
    uint32_t num_tail_parts;

    /* Precomputed FFT spectra of IR tail partitions for Left(0) and Right(1) IR channels */
    uint16_t ir_spec_channels;
    double  *ir_tail_re[2]; /* [num_tail_parts * OM_CONV_FFT_LEN] */
    double  *ir_tail_im[2]; /* [num_tail_parts * OM_CONV_FFT_LEN] */

    /* Per-channel runtime state */
    om_conv_chan_t chan[OM_MAX_CHANNELS];

    /* Precomputed radix-2 FFT tables for N = 512 */
    uint16_t bit_rev[OM_CONV_FFT_LEN];
    double   tw_re[OM_CONV_FFT_LEN / 2U];
    double   tw_im[OM_CONV_FFT_LEN / 2U];
} om_convolver_t;

void om_convolver_init(om_convolver_t *conv);
void om_convolver_destroy(om_convolver_t *conv);
void om_convolver_reset(om_convolver_t *conv);

/* Load WAV/FLAC Impulse Response file and prepare partitions for current stream rate */
int  om_convolver_load_ir(om_convolver_t *conv, const char *ir_path, char *err, size_t err_cap);
void om_convolver_unload_ir(om_convolver_t *conv);

/* Re-partition / resample IR if stream sample_rate or channel count changes */
int  om_convolver_configure_stream(om_convolver_t *conv, uint32_t sample_rate, uint16_t channels);

/* Process `frames` of interleaved 64-bit float audio in-place with zero latency */
void om_convolver_process(om_convolver_t * restrict conv, double * restrict pcm, size_t frames, uint16_t channels);

#endif /* OURMUSIC_DSP_CONVOLVER_H */
