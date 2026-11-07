#ifndef OURMUSIC_AUDIO_FORMATS_H
#define OURMUSIC_AUDIO_FORMATS_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#define OM_MAX_CHANNELS 8

typedef enum {
    OM_CODEC_UNKNOWN = 0,
    OM_CODEC_WAV     = 1,
    OM_CODEC_FLAC    = 2,
    OM_CODEC_ALAC    = 3,
    OM_CODEC_MP3     = 4,
    OM_CODEC_DSD     = 5
} om_codec_id_t;

typedef struct {
    om_codec_id_t codec;
    uint32_t sample_rate;      /* Output PCM/DoP rate in Hz (e.g. 44100, 96000, 176400) */
    uint32_t dsd_bit_rate;     /* Original 1-bit DSD rate if codec == OM_CODEC_DSD (e.g. 2822400) */
    uint16_t channels;         /* 1..8 */
    uint16_t bit_depth;        /* Native integer precision: 8, 16, 24, or 32 */
    bool     is_float;         /* True if source is IEEE float or float-decoded (MP3 / DSD PCM) */
    bool     is_dop;           /* True if frames carry 24-bit DoP markers (0x05 / 0xFA) */
    uint64_t total_frames;     /* Total PCM/DoP frames if known, else 0 */
    double   duration_sec;     /* Total duration in seconds */
} om_stream_info_t;

/*
 * Dual-representation audio frame block:
 * - For bit-perfect integer/DoP passthrough, `pcm_i32` holds right-aligned exact
 *   signed integers in the range [-(1 << (bit_depth-1)), (1 << (bit_depth-1)) - 1].
 * - For float sources or DSP processing, `pcm_f64` holds interleaved 64-bit floats
 *   in [-1.0, +1.0]. Helper routines convert losslessly between representations.
 */
typedef struct om_decoder om_decoder_t;

struct om_decoder {
    const char *name;
    om_stream_info_t info;
    void *priv;

    /* Read up to `max_frames` interleaved frames.
     * Writes right-aligned integers into `out_i32` (if non-NULL) and/or
     * normalized doubles into `out_f64` (if non-NULL).
     * Returns number of frames decoded (0 = EOF, <0 = error). */
    int (*read_frames)(om_decoder_t *dec, int32_t *out_i32, double *out_f64, size_t max_frames);

    /* Seek to target PCM frame index. Returns 0 on success, <0 on error. */
    int (*seek_frame)(om_decoder_t *dec, uint64_t target_frame);

    /* Close and free private decoder resources. */
    void (*close)(om_decoder_t *dec);
};

/* Convert right-aligned int32 sample at `bit_depth` to normalized [-1.0, 1.0] double */
static inline double om_i32_to_f64(int32_t v, uint16_t bit_depth) {
    if (bit_depth <= 8)  return (double)v / 128.0;
    if (bit_depth <= 16) return (double)v / 32768.0;
    if (bit_depth <= 24) return (double)v / 8388608.0;
    return (double)v / 2147483648.0;
}

/* Convert normalized [-1.0, 1.0] double to right-aligned clamped int32 at `bit_depth` */
static inline int32_t om_f64_to_i32(double x, uint16_t bit_depth) {
    if (x > 1.0) x = 1.0;
    if (x < -1.0) x = -1.0;
    if (bit_depth <= 16) {
        double s = x * 32768.0;
        if (s >= 32767.0) return 32767;
        if (s <= -32768.0) return -32768;
        return (int32_t)(s >= 0.0 ? (s + 0.5) : (s - 0.5));
    }
    if (bit_depth <= 24) {
        double s = x * 8388608.0;
        if (s >= 8388607.0) return 8388607;
        if (s <= -8388608.0) return -8388608;
        return (int32_t)(s >= 0.0 ? (s + 0.5) : (s - 0.5));
    }
    double s = x * 2147483648.0;
    if (s >= 2147483647.0) return 2147483647;
    if (s <= -2147483648.0) return (int32_t)(-2147483647 - 1);
    return (int32_t)(s >= 0.0 ? (s + 0.5) : (s - 0.5));
}

/* Format-specific clean-room decoder constructors */
int om_decoder_open_wav(const char *path, om_decoder_t *out_dec, char *err, size_t err_cap);
int om_decoder_open_flac(const char *path, om_decoder_t *out_dec, char *err, size_t err_cap);
int om_decoder_open_alac(const char *path, om_decoder_t *out_dec, char *err, size_t err_cap);
int om_decoder_open_mp3(const char *path, om_decoder_t *out_dec, char *err, size_t err_cap);
int om_decoder_open_dsd(const char *path, bool prefer_dop, om_decoder_t *out_dec, char *err, size_t err_cap);

/* Unified format dispatcher by file header magic + extension */
int om_decoder_open_any(const char *path, bool prefer_dop, om_decoder_t *out_dec, char *err, size_t err_cap);
const char *om_codec_name(om_codec_id_t id);

#endif /* OURMUSIC_AUDIO_FORMATS_H */
