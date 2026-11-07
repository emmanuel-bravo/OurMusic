#ifndef OURMUSIC_HAL_H
#define OURMUSIC_HAL_H

#include "audio_formats.h"

#define OM_HAL_MAX_DEVICES 64

typedef struct {
    char id[128];
    char name[256];
    bool is_exclusive_capable;
    bool is_default;
} om_hal_device_info_t;

typedef struct {
    uint32_t sample_rate;
    uint16_t channels;
    uint16_t bit_depth;        /* 16, 24, or 32 */
    bool     prefer_bitperfect;/* Request no OS resampling / WASAPI Exclusive */
    bool     use_float_output; /* True when DSP is active and float output is desired */
} om_hal_request_t;

typedef struct {
    char     backend_name[64];
    char     device_id[1024];
    uint32_t actual_rate;
    uint16_t actual_channels;
    uint16_t actual_bit_depth;
    bool     actual_is_float;
    bool     bit_perfect_active; /* True if rate matches & OS resampling bypassed */
    void    *priv;
} om_hal_handle_t;

/* Enumerate OS audio output devices (ALSA on Linux, WASAPI on Windows) */
size_t om_hal_enumerate_devices(om_hal_device_info_t *out_list, size_t max_items);

/* Open OS audio device or deterministic WAV/null sink (device_id = "null" or "wav:<path>") */
int  om_hal_open(const char *device_id, const om_hal_request_t *req, om_hal_handle_t *out, char *err, size_t err_cap);
int  om_hal_write(om_hal_handle_t *h, const int32_t *pcm_i32, const double *pcm_f64, uint16_t src_bit_depth, size_t frames);
void om_hal_drain(om_hal_handle_t *h);
void om_hal_drop(om_hal_handle_t *h);
void om_hal_close(om_hal_handle_t *h);

/* Deterministic WAV/null sink helpers */
int  om_wavsink_open(const char *wav_path, bool realtime_pace, const om_hal_request_t *req, om_hal_handle_t *out, char *err, size_t err_cap);
int  om_wavsink_write(om_hal_handle_t *h, const int32_t *pcm_i32, const double *pcm_f64, uint16_t src_bit_depth, size_t frames);
void om_wavsink_close(om_hal_handle_t *h);

#endif /* OURMUSIC_HAL_H */
