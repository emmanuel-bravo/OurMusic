#ifndef OURMUSIC_ENGINE_CORE_H
#define OURMUSIC_ENGINE_CORE_H

#include "audio_formats.h"
#include "dsp_eq.h"
#include "dsp_resampler.h"
#include "hal.h"
#include "os_compat.h"

#define OM_CHUNK_FRAMES 1024
#define OM_RING_SLOTS   64

typedef enum {
    OM_STATE_STOPPED = 0,
    OM_STATE_PLAYING = 1,
    OM_STATE_PAUSED  = 2
} om_play_state_t;

typedef struct {
    uint64_t         track_seq;
    char             path[1024];
    om_stream_info_t info;
    uint64_t         start_frame_idx;
    size_t           frames;
    bool             is_track_start;
    bool             is_eof_marker;
    int32_t          pcm_i32[OM_CHUNK_FRAMES * OM_MAX_CHANNELS];
    double           pcm_f64[OM_CHUNK_FRAMES * OM_MAX_CHANNELS];
} om_ring_slot_t;

typedef void (*om_engine_event_cb)(const char *event_type, const char *json_payload, void *userdata);

typedef struct {
    om_mutex_t lock;
    om_cond_t  cond_can_push;
    om_cond_t  cond_can_pop;

    bool        running;
    om_thread_t dec_thread;
    om_thread_t out_thread;

    /* Zero-copy SPSC-style ring buffer in RAM for lock-light gapless streaming */
    om_ring_slot_t *ring;
    size_t          ring_head;
    size_t          ring_tail;
    size_t          ring_count;
    bool            dec_busy;         /* True while decoder_worker is inside read_frames() unlocked */
    bool            out_slot_in_use;  /* True while output_worker holds &ring[ring_head] zero-copy */

    /* Playback control & decoder state */
    om_play_state_t state;
    uint64_t        cmd_generation;
    uint64_t        track_seq_counter;

    char            req_device_id[1024];
    bool            prefer_bitperfect_hw;
    bool            prefer_dsd_dop;
    om_dsd_mode_t   dsd_mode;
    double          volume_lin;       /* Software volume when bit-perfect is off (1.0 = unity) */
    bool            volume_unity;

    /* Active & pre-opened next decoder (gapless) */
    om_decoder_t    active_dec;
    bool            has_active_dec;
    char            active_path[1024];
    uint64_t        active_seq;
    uint64_t        dec_frame_cursor;

    om_decoder_t    next_dec;
    bool            has_next_dec;
    char            next_path[1024];

    bool            pending_seek;
    uint64_t        seek_target_frame;

    /* Output hardware state & live telemetry */
    om_hal_handle_t hal;
    bool            hal_open;
    uint32_t        last_requested_hal_rate;

    char             playing_path[1024];
    om_stream_info_t playing_info;
    uint64_t         played_frame_idx;
    bool             signal_bitperfect;
    uint64_t         gapless_transitions;

    /* High-precision 64-bit Polyphase Kaiser-Sinc Resampler (engages only when needed) */
    om_resampler_t   resampler;
    uint32_t         resampler_target_rate; /* 0 = Auto Bit-Perfect native rate, >0 = forced Hz */
    om_src_quality_t resampler_quality;
    bool             resampler_active;
    double          *src_out_buf;
    size_t           src_out_cap_frames;

    /* DSP + Parametric Equalizer + Convolver + Crossfeed + ReplayGain pipeline */
    om_dsp_chain_t   dsp;

    /* Async event callback */
    om_engine_event_cb event_cb;
    void              *event_ud;
} om_engine_t;

int  om_engine_init(om_engine_t *eng, om_engine_event_cb cb, void *ud);
void om_engine_shutdown(om_engine_t *eng);

int  om_engine_set_output_device(om_engine_t *eng, const char *device_id, bool prefer_bitperfect, bool prefer_dop);
void om_engine_set_dsd_mode(om_engine_t *eng, om_dsd_mode_t mode);
void om_engine_set_resampler_config(om_engine_t *eng, uint32_t target_rate, om_src_quality_t quality);

int  om_engine_load_and_play(om_engine_t *eng, const char *path, const char *next_path, char *err, size_t err_cap);
int  om_engine_queue_next_gapless(om_engine_t *eng, const char *next_path, char *err, size_t err_cap);
void om_engine_clear_next_gapless(om_engine_t *eng);
void om_engine_pause(om_engine_t *eng, bool pause);
void om_engine_stop(om_engine_t *eng);
int  om_engine_seek_seconds(om_engine_t *eng, double seconds);
void om_engine_set_volume(om_engine_t *eng, double volume_0_to_1);

#endif /* OURMUSIC_ENGINE_CORE_H */
