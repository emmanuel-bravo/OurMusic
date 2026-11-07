#include "engine_core.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

static void emit_event(om_engine_t *eng, const char *type, const char *payload) {
    if (eng->event_cb) {
        eng->event_cb(type, payload ? payload : "{}", eng->event_ud);
    }
}

static void json_escape_str(const char *in, char *out, size_t cap) {
    size_t j = 0;
    for (size_t i = 0; in && in[i] && j + 3 < cap; i++) {
        unsigned char c = (unsigned char)in[i];
        if (c == '"' || c == '\\') {
            out[j++] = '\\';
            out[j++] = (char)c;
        } else if (c >= 0x20) {
            out[j++] = (char)c;
        }
    }
    out[j] = '\0';
}

/* Wait until decoder_worker is not inside unlocked active_dec.read_frames() */
static void wait_decoder_idle_unlocked(om_engine_t *eng) {
    while (eng->dec_busy) {
        om_cond_timedwait_ms(&eng->cond_can_push, &eng->lock, 2);
    }
}

/* Flush ring buffer without disturbing an in-flight zero-copy output slot */
static void ring_flush_unlocked(om_engine_t *eng) {
    if (eng->out_slot_in_use) {
        eng->ring_head = (eng->ring_head + 1U) % OM_RING_SLOTS;
    } else {
        eng->ring_head = 0;
    }
    eng->ring_tail = eng->ring_head;
    eng->ring_count = 0;
    om_cond_broadcast(&eng->cond_can_push);
    om_cond_broadcast(&eng->cond_can_pop);
}

static void update_passive_meters(om_dsp_chain_t *dsp, const double * restrict pcm, size_t frames, uint16_t channels) {
    double pl = 0.0, pr = 0.0, sl = 0.0, sr = 0.0;
    if (channels == 2) {
        for (size_t f = 0; f < frames; f++) {
            double l = pcm[f * 2U + 0];
            double r = pcm[f * 2U + 1];
            double al = fabs(l), ar = fabs(r);
            if (al > pl) pl = al;
            if (ar > pr) pr = ar;
            sl += l * l;
            sr += r * r;
        }
    } else {
        for (size_t f = 0; f < frames; f++) {
            double l = pcm[f * channels];
            double r = (channels > 1) ? pcm[f * channels + 1] : l;
            double al = fabs(l), ar = fabs(r);
            if (al > pl) pl = al;
            if (ar > pr) pr = ar;
            sl += l * l;
            sr += r * r;
        }
    }
    om_mutex_lock(&dsp->lock);
    dsp->meters.peak_l = pl;
    dsp->meters.peak_r = pr;
    dsp->meters.rms_l = frames ? sqrt(sl / (double)frames) : 0.0;
    dsp->meters.rms_r = frames ? sqrt(sr / (double)frames) : 0.0;
    om_mutex_unlock(&dsp->lock);
}

static void *decoder_worker(void *arg) {
    om_engine_t *eng = (om_engine_t *)arg;
    bool sent_track_start = true;

    while (true) {
        om_mutex_lock(&eng->lock);
        while (eng->running) {
            size_t max_slots = eng->out_slot_in_use ? (OM_RING_SLOTS - 1U) : OM_RING_SLOTS;
            if (eng->state == OM_STATE_PLAYING && eng->has_active_dec && eng->ring_count < max_slots) {
                break;
            }
            om_cond_timedwait_ms(&eng->cond_can_push, &eng->lock, 25);
        }
        if (!eng->running) {
            om_mutex_unlock(&eng->lock);
            break;
        }

        if (eng->pending_seek && eng->has_active_dec) {
            uint64_t tgt = eng->seek_target_frame;
            eng->pending_seek = false;
            if (eng->active_dec.seek_frame) {
                eng->active_dec.seek_frame(&eng->active_dec, tgt);
            }
            eng->dec_frame_cursor = tgt;
            ring_flush_unlocked(eng);
            om_dsp_reset_state(&eng->dsp);
        }

        uint64_t gen_before = eng->cmd_generation;
        om_ring_slot_t *slot = &eng->ring[eng->ring_tail];
        slot->track_seq = eng->active_seq;
        snprintf(slot->path, sizeof(slot->path), "%s", eng->active_path);
        slot->info = eng->active_dec.info;
        slot->start_frame_idx = eng->dec_frame_cursor;
        slot->is_track_start = (eng->dec_frame_cursor == 0 && !sent_track_start);
        slot->is_eof_marker = false;
        sent_track_start = true;

        /* Mark decoder busy and release eng->lock so decoding runs 100% in parallel with output & IPC! */
        eng->dec_busy = true;
        om_mutex_unlock(&eng->lock);

        int got = eng->active_dec.read_frames(&eng->active_dec, slot->pcm_i32, slot->pcm_f64, OM_CHUNK_FRAMES);

        om_mutex_lock(&eng->lock);
        eng->dec_busy = false;
        om_cond_broadcast(&eng->cond_can_push);

        if (eng->cmd_generation != gen_before || !eng->running) {
            om_mutex_unlock(&eng->lock);
            continue;
        }

        if (got > 0) {
            slot->frames = (size_t)got;
            eng->dec_frame_cursor += (uint64_t)got;
            eng->ring_tail = (eng->ring_tail + 1U) % OM_RING_SLOTS;
            eng->ring_count++;
            om_cond_signal(&eng->cond_can_pop);
            om_mutex_unlock(&eng->lock);
            continue;
        }

        /* Active decoder reached EOF: check if a gapless next decoder is already pre-opened! */
        if (eng->has_next_dec) {
            eng->active_dec.close(&eng->active_dec);
            eng->active_dec = eng->next_dec;
            memset(&eng->next_dec, 0, sizeof(eng->next_dec));
            eng->has_next_dec = false;

            snprintf(eng->active_path, sizeof(eng->active_path), "%s", eng->next_path);
            eng->next_path[0] = '\0';
            eng->active_seq = ++eng->track_seq_counter;
            eng->dec_frame_cursor = 0;
            sent_track_start = false; /* Mark very first slot of promoted track */
            om_mutex_unlock(&eng->lock);
            continue;
        }

        /* No next track queued: push terminal EOF marker slot and close active decoder */
        eng->active_dec.close(&eng->active_dec);
        eng->has_active_dec = false;
        slot->frames = 0;
        slot->is_eof_marker = true;
        eng->ring_tail = (eng->ring_tail + 1U) % OM_RING_SLOTS;
        eng->ring_count++;
        om_cond_signal(&eng->cond_can_pop);
        om_mutex_unlock(&eng->lock);
    }
    return NULL;
}

static void *output_worker(void *arg) {
    om_engine_t *eng = (om_engine_t *)arg;

    while (true) {
        om_mutex_lock(&eng->lock);
        while (eng->running && (eng->state != OM_STATE_PLAYING || eng->ring_count == 0)) {
            if (!eng->running) break;
            om_cond_timedwait_ms(&eng->cond_can_pop, &eng->lock, 25);
        }
        if (!eng->running) {
            om_mutex_unlock(&eng->lock);
            break;
        }

        /* Claim zero-copy read pointer to ring[ring_head] without 98 KB memcpy! */
        uint64_t gen_before = eng->cmd_generation;
        om_ring_slot_t *slot = &eng->ring[eng->ring_head];
        eng->out_slot_in_use = true;

        if (slot->is_eof_marker) {
            /* Advance ring immediately for EOF marker */
            eng->ring_head = (eng->ring_head + 1U) % OM_RING_SLOTS;
            eng->ring_count--;
            eng->out_slot_in_use = false;
            om_cond_signal(&eng->cond_can_push);

            /* Flush any remaining Polyphase Kaiser-Sinc lookahead samples before draining HAL */
            if (eng->hal_open && eng->resampler_active && eng->resampler.initialized) {
                om_hal_handle_t hal_copy = eng->hal;
                uint16_t last_bits = eng->playing_info.bit_depth ? eng->playing_info.bit_depth : 24;
                om_mutex_unlock(&eng->lock);

                double tail_buf[256 * OM_MAX_CHANNELS];
                size_t tail_frames = om_resampler_flush_tail(&eng->resampler, tail_buf, 256U);
                if (tail_frames > 0) {
                    om_hal_write(&hal_copy, NULL, tail_buf, last_bits, tail_frames);
                }
                om_mutex_lock(&eng->lock);
            }

            if (eng->hal_open) {
                om_hal_drain(&eng->hal);
                om_hal_close(&eng->hal);
                eng->hal_open = false;
                eng->last_requested_hal_rate = 0;
            }
            eng->resampler_active = false;
            eng->state = OM_STATE_STOPPED;
            om_mutex_unlock(&eng->lock);
            emit_event(eng, "playback_ended", "{\"reason\":\"eof\"}");
            continue;
        }

        const bool is_raw_dsd = (slot->info.is_dop || slot->info.is_dsd_native);
        const uint32_t target_rate = (!is_raw_dsd && eng->resampler_target_rate > 0)
                                   ? eng->resampler_target_rate
                                   : slot->info.sample_rate;
        const om_src_quality_t src_qual = eng->resampler_quality;

        bool dsp_stage_needed = !om_dsp_can_bypass_bitperfect(&eng->dsp, is_raw_dsd);
        double vol = eng->volume_lin;
        bool vol_unity = eng->volume_unity;

        bool force_src_requested = (!is_raw_dsd && eng->resampler_target_rate > 0 &&
                                    eng->resampler_target_rate != slot->info.sample_rate);
        bool want_bp_hw = eng->prefer_bitperfect_hw && !dsp_stage_needed && !force_src_requested &&
                          (is_raw_dsd || (vol_unity && !slot->info.is_float));

        bool need_reopen = !eng->hal_open ||
                           eng->hal.actual_channels != slot->info.channels ||
                           eng->hal.actual_is_dsd_native != slot->info.is_dsd_native ||
                           (eng->hal.actual_rate != target_rate && eng->last_requested_hal_rate != target_rate);

        char dev_id[1024];
        snprintf(dev_id, sizeof(dev_id), "%s", eng->req_device_id);
        om_mutex_unlock(&eng->lock);

        if (need_reopen) {
            om_mutex_lock(&eng->lock);
            if (eng->hal_open) {
                om_hal_drain(&eng->hal);
                om_hal_close(&eng->hal);
                eng->hal_open = false;
            }
            om_hal_request_t req;
            memset(&req, 0, sizeof(req));
            req.sample_rate = target_rate;
            req.dsd_bit_rate = slot->info.dsd_bit_rate;
            req.channels = slot->info.channels;
            req.bit_depth = slot->info.bit_depth;
            req.prefer_bitperfect = want_bp_hw;
            req.use_float_output = !want_bp_hw;
            req.is_dsd_native = slot->info.is_dsd_native;

            char hal_err[256] = {0};
            if (om_hal_open(dev_id, &req, &eng->hal, hal_err, sizeof(hal_err)) != 0) {
                /* Fallback to null timed sink if hardware device is busy/unavailable in sandbox */
                om_hal_open("null", &req, &eng->hal, hal_err, sizeof(hal_err));
            }
            eng->hal_open = true;
            eng->last_requested_hal_rate = target_rate;
            om_dsp_configure_stream(&eng->dsp, slot->info.sample_rate, slot->info.channels);
            om_resampler_reset(&eng->resampler);
            om_mutex_unlock(&eng->lock);
        }

        /* Gapless track transition detection without closing HAL when format matches */
        om_mutex_lock(&eng->lock);
        uint32_t actual_hal_rate = eng->hal_open ? eng->hal.actual_rate : target_rate;
        if (strcmp(eng->playing_path, slot->path) != 0) {
            bool was_playing_prev = (eng->playing_path[0] != '\0' && !need_reopen);
            snprintf(eng->playing_path, sizeof(eng->playing_path), "%s", slot->path);
            eng->playing_info = slot->info;
            if (was_playing_prev) {
                eng->gapless_transitions++;
            }
            char esc_path[2048];
            json_escape_str(slot->path, esc_path, sizeof(esc_path));
            char ev_buf[2400];
            snprintf(ev_buf, sizeof(ev_buf),
                     "{\"path\":\"%s\",\"sampleRate\":%u,\"bitDepth\":%u,\"channels\":%u,\"codec\":\"%s\",\"isDop\":%s,\"isDsdNative\":%s,\"gapless\":%s}",
                     esc_path, slot->info.sample_rate, slot->info.bit_depth,
                     slot->info.channels, om_codec_name(slot->info.codec),
                     slot->info.is_dop ? "true" : "false",
                     slot->info.is_dsd_native ? "true" : "false",
                     was_playing_prev ? "true" : "false");
            om_mutex_unlock(&eng->lock);
            emit_event(eng, "track_started", ev_buf);
        } else {
            om_mutex_unlock(&eng->lock);
        }

        const bool need_src = (!is_raw_dsd && actual_hal_rate > 0 && actual_hal_rate != slot->info.sample_rate);
        const bool pure_bitperfect_passthrough = is_raw_dsd ||
            (!need_src && !dsp_stage_needed && vol_unity && !slot->info.is_float);

        /* Execute Bit-Perfect passthrough OR 64-bit DSP + Polyphase Sinc SRC pipeline */
        if (pure_bitperfect_passthrough) {
            if (!slot->info.is_dsd_native) {
                update_passive_meters(&eng->dsp, slot->pcm_f64, slot->frames, slot->info.channels);
            }
            om_mutex_lock(&eng->lock);
            if (eng->cmd_generation == gen_before && eng->hal_open) {
                eng->resampler_active = false;
                eng->signal_bitperfect = eng->hal.bit_perfect_active;
                eng->played_frame_idx = slot->start_frame_idx + slot->frames;
                om_hal_handle_t hal_copy = eng->hal;
                om_mutex_unlock(&eng->lock);

                om_hal_write(&hal_copy, slot->pcm_i32, NULL, slot->info.bit_depth, slot->frames);

                om_mutex_lock(&eng->lock);
            }
        } else {
            if (!vol_unity && !is_raw_dsd) {
                size_t tot = slot->frames * slot->info.channels;
                for (size_t i = 0; i < tot; i++) slot->pcm_f64[i] *= vol;
            }

            if (dsp_stage_needed) {
                om_dsp_process(&eng->dsp, slot->pcm_f64, slot->frames,
                               slot->info.channels, slot->info.sample_rate);
            } else {
                update_passive_meters(&eng->dsp, slot->pcm_f64, slot->frames, slot->info.channels);
            }

            const double *out_f64_ptr = slot->pcm_f64;
            size_t out_frames_cnt = slot->frames;

            if (need_src) {
                if (om_resampler_configure(&eng->resampler, slot->info.sample_rate,
                                           actual_hal_rate, slot->info.channels, src_qual) == 0) {
                    size_t need_cap = om_resampler_max_out_frames(&eng->resampler, slot->frames);
                    if (need_cap > eng->src_out_cap_frames) {
                        size_t grow = need_cap + 1024U;
                        double *nbuf = (double *)realloc(eng->src_out_buf, grow * OM_MAX_CHANNELS * sizeof(double));
                        if (nbuf) {
                            eng->src_out_buf = nbuf;
                            eng->src_out_cap_frames = grow;
                        }
                    }
                    if (eng->src_out_buf && eng->src_out_cap_frames >= need_cap) {
                        out_frames_cnt = om_resampler_process(&eng->resampler, slot->pcm_f64, slot->frames,
                                                              eng->src_out_buf, eng->src_out_cap_frames);
                        out_f64_ptr = eng->src_out_buf;
                    }
                }
            }

            om_mutex_lock(&eng->lock);
            if (eng->cmd_generation == gen_before && eng->hal_open) {
                eng->resampler_active = need_src;
                eng->signal_bitperfect = false;
                eng->played_frame_idx = slot->start_frame_idx + slot->frames;
                om_hal_handle_t hal_copy = eng->hal;
                om_mutex_unlock(&eng->lock);

                if (out_frames_cnt > 0) {
                    om_hal_write(&hal_copy, NULL, out_f64_ptr, slot->info.bit_depth, out_frames_cnt);
                }

                om_mutex_lock(&eng->lock);
            }
        }

        /* Release zero-copy slot ownership if ring wasn't flushed mid-chunk */
        if (eng->cmd_generation == gen_before && eng->ring_count > 0) {
            eng->ring_head = (eng->ring_head + 1U) % OM_RING_SLOTS;
            eng->ring_count--;
        }
        eng->out_slot_in_use = false;
        om_cond_signal(&eng->cond_can_push);
        om_mutex_unlock(&eng->lock);
    }
    return NULL;
}

int om_engine_init(om_engine_t *eng, om_engine_event_cb cb, void *ud) {
    memset(eng, 0, sizeof(*eng));
    om_mutex_init(&eng->lock);
    om_cond_init(&eng->cond_can_push);
    om_cond_init(&eng->cond_can_pop);
    om_dsp_init(&eng->dsp);
    om_resampler_init(&eng->resampler);

    eng->ring = (om_ring_slot_t *)calloc(OM_RING_SLOTS, sizeof(om_ring_slot_t));
    if (!eng->ring) return -1;

    eng->src_out_cap_frames = OM_CHUNK_FRAMES * 8U + 64U;
    eng->src_out_buf = (double *)calloc(eng->src_out_cap_frames * OM_MAX_CHANNELS, sizeof(double));
    if (!eng->src_out_buf) {
        free(eng->ring);
        eng->ring = NULL;
        return -1;
    }

    snprintf(eng->req_device_id, sizeof(eng->req_device_id), "default");
    eng->prefer_bitperfect_hw = true;
    eng->prefer_dsd_dop = false;
    eng->dsd_mode = OM_DSD_MODE_PCM;
    eng->resampler_target_rate = 0; /* Auto Bit-Perfect native rate */
    eng->resampler_quality = OM_SRC_QUALITY_HIGH;
    eng->volume_lin = 1.0;
    eng->volume_unity = true;
    eng->event_cb = cb;
    eng->event_ud = ud;
    eng->running = true;

    if (om_thread_create(&eng->dec_thread, decoder_worker, eng) != 0) return -1;
    if (om_thread_create(&eng->out_thread, output_worker, eng) != 0) return -1;
    return 0;
}

void om_engine_shutdown(om_engine_t *eng) {
    om_mutex_lock(&eng->lock);
    eng->running = false;
    eng->cmd_generation++;
    om_cond_broadcast(&eng->cond_can_push);
    om_cond_broadcast(&eng->cond_can_pop);
    om_mutex_unlock(&eng->lock);

    om_thread_join(eng->dec_thread);
    om_thread_join(eng->out_thread);

    om_mutex_lock(&eng->lock);
    if (eng->has_active_dec && eng->active_dec.close) eng->active_dec.close(&eng->active_dec);
    if (eng->has_next_dec && eng->next_dec.close) eng->next_dec.close(&eng->next_dec);
    if (eng->hal_open) om_hal_close(&eng->hal);
    free(eng->ring);
    eng->ring = NULL;
    free(eng->src_out_buf);
    eng->src_out_buf = NULL;
    om_mutex_unlock(&eng->lock);

    om_resampler_destroy(&eng->resampler);
    om_dsp_destroy(&eng->dsp);
    om_cond_destroy(&eng->cond_can_push);
    om_cond_destroy(&eng->cond_can_pop);
    om_mutex_destroy(&eng->lock);
}

int om_engine_set_output_device(om_engine_t *eng, const char *device_id, bool prefer_bitperfect, bool prefer_dop) {
    om_mutex_lock(&eng->lock);
    snprintf(eng->req_device_id, sizeof(eng->req_device_id), "%s", (device_id && device_id[0]) ? device_id : "default");
    eng->prefer_bitperfect_hw = prefer_bitperfect;
    eng->prefer_dsd_dop = prefer_dop;
    if (eng->dsd_mode != OM_DSD_MODE_NATIVE) {
        eng->dsd_mode = prefer_dop ? OM_DSD_MODE_DOP : OM_DSD_MODE_PCM;
    }
    if (eng->hal_open) {
        om_hal_drop(&eng->hal);
        om_hal_close(&eng->hal);
        eng->hal_open = false;
        eng->last_requested_hal_rate = 0;
    }
    om_mutex_unlock(&eng->lock);
    return 0;
}

void om_engine_set_dsd_mode(om_engine_t *eng, om_dsd_mode_t mode) {
    om_mutex_lock(&eng->lock);
    eng->dsd_mode = mode;
    eng->prefer_dsd_dop = (mode == OM_DSD_MODE_DOP);
    om_mutex_unlock(&eng->lock);
}

void om_engine_set_resampler_config(om_engine_t *eng, uint32_t target_rate, om_src_quality_t quality) {
    om_mutex_lock(&eng->lock);
    bool rate_changed = (eng->resampler_target_rate != target_rate);
    eng->resampler_target_rate = target_rate;
    eng->resampler_quality = quality;
    if (rate_changed && eng->hal_open) {
        om_hal_drop(&eng->hal);
        om_hal_close(&eng->hal);
        eng->hal_open = false;
        eng->last_requested_hal_rate = 0;
    }
    om_mutex_unlock(&eng->lock);
}

int om_engine_load_and_play(om_engine_t *eng, const char *path, const char *next_path, char *err, size_t err_cap) {
    om_decoder_t new_dec;
    om_decoder_t new_next;
    bool has_new_next = false;
    om_dsd_mode_t dsd_mode;

    om_mutex_lock(&eng->lock);
    dsd_mode = eng->dsd_mode;
    om_mutex_unlock(&eng->lock);

    if (om_decoder_open_any_ex(path, dsd_mode, &new_dec, err, err_cap) != 0) {
        return -1;
    }

    if (next_path && next_path[0]) {
        char nerr[256] = {0};
        if (om_decoder_open_any_ex(next_path, dsd_mode, &new_next, nerr, sizeof(nerr)) == 0) {
            has_new_next = true;
        }
    }

    om_mutex_lock(&eng->lock);
    eng->cmd_generation++;
    wait_decoder_idle_unlocked(eng);

    if (eng->has_active_dec && eng->active_dec.close) eng->active_dec.close(&eng->active_dec);
    if (eng->has_next_dec && eng->next_dec.close) {
        eng->next_dec.close(&eng->next_dec);
        eng->has_next_dec = false;
        eng->next_path[0] = '\0';
    }
    if (eng->hal_open) {
        om_hal_drop(&eng->hal);
    }

    ring_flush_unlocked(eng);
    om_dsp_reset_state(&eng->dsp);
    om_resampler_reset(&eng->resampler);

    eng->active_dec = new_dec;
    eng->has_active_dec = true;
    snprintf(eng->active_path, sizeof(eng->active_path), "%s", path);

    if (has_new_next) {
        eng->next_dec = new_next;
        eng->has_next_dec = true;
        snprintf(eng->next_path, sizeof(eng->next_path), "%s", next_path);
    }

    eng->playing_path[0] = '\0';
    eng->playing_info = new_dec.info;
    eng->active_seq = ++eng->track_seq_counter;
    eng->dec_frame_cursor = 0;
    eng->played_frame_idx = 0;
    eng->pending_seek = false;
    eng->state = OM_STATE_PLAYING;

    om_cond_broadcast(&eng->cond_can_push);
    om_cond_broadcast(&eng->cond_can_pop);
    om_mutex_unlock(&eng->lock);
    return 0;
}

/* Pre-opens the next queued file in advance so the decoder thread transitions with 0 gap */
int om_engine_queue_next_gapless(om_engine_t *eng, const char *next_path, char *err, size_t err_cap) {
    if (!next_path || !next_path[0]) {
        om_engine_clear_next_gapless(eng);
        return 0;
    }
    om_decoder_t ndec;
    om_dsd_mode_t dsd_mode;
    om_mutex_lock(&eng->lock);
    dsd_mode = eng->dsd_mode;
    om_mutex_unlock(&eng->lock);

    if (om_decoder_open_any_ex(next_path, dsd_mode, &ndec, err, err_cap) != 0) {
        return -1;
    }

    om_mutex_lock(&eng->lock);
    if (eng->has_next_dec && eng->next_dec.close) {
        eng->next_dec.close(&eng->next_dec);
        eng->has_next_dec = false;
    }

    /* Retract unpopped EOF marker in the RAM ring buffer if output_worker hasn't claimed it yet */
    if (!eng->has_active_dec && eng->state == OM_STATE_PLAYING && eng->ring_count > 0) {
        size_t last_idx = (eng->ring_tail + OM_RING_SLOTS - 1U) % OM_RING_SLOTS;
        bool claimed_by_out = (eng->out_slot_in_use && last_idx == eng->ring_head);
        if (!claimed_by_out && eng->ring[last_idx].is_eof_marker) {
            eng->ring_tail = last_idx;
            eng->ring_count--;
            eng->active_dec = ndec;
            eng->has_active_dec = true;
            snprintf(eng->active_path, sizeof(eng->active_path), "%s", next_path);
            eng->active_seq = ++eng->track_seq_counter;
            eng->dec_frame_cursor = 0;
            om_cond_broadcast(&eng->cond_can_push);
            om_mutex_unlock(&eng->lock);
            return 0;
        }
    }

    eng->next_dec = ndec;
    eng->has_next_dec = true;
    snprintf(eng->next_path, sizeof(eng->next_path), "%s", next_path);
    om_cond_broadcast(&eng->cond_can_push);
    om_mutex_unlock(&eng->lock);
    return 0;
}

void om_engine_clear_next_gapless(om_engine_t *eng) {
    om_mutex_lock(&eng->lock);
    if (eng->has_next_dec && eng->next_dec.close) {
        eng->next_dec.close(&eng->next_dec);
    }
    eng->has_next_dec = false;
    eng->next_path[0] = '\0';
    om_mutex_unlock(&eng->lock);
}

void om_engine_pause(om_engine_t *eng, bool pause) {
    om_mutex_lock(&eng->lock);
    if (pause && eng->state == OM_STATE_PLAYING) {
        eng->state = OM_STATE_PAUSED;
    } else if (!pause && eng->state == OM_STATE_PAUSED) {
        eng->state = OM_STATE_PLAYING;
        om_cond_broadcast(&eng->cond_can_push);
        om_cond_broadcast(&eng->cond_can_pop);
    }
    om_mutex_unlock(&eng->lock);
}

void om_engine_stop(om_engine_t *eng) {
    om_mutex_lock(&eng->lock);
    eng->cmd_generation++;
    eng->state = OM_STATE_STOPPED;
    wait_decoder_idle_unlocked(eng);

    if (eng->has_active_dec && eng->active_dec.close) {
        eng->active_dec.close(&eng->active_dec);
        eng->has_active_dec = false;
    }
    if (eng->has_next_dec && eng->next_dec.close) {
        eng->next_dec.close(&eng->next_dec);
        eng->has_next_dec = false;
    }
    ring_flush_unlocked(eng);
    if (eng->hal_open) {
        om_hal_drop(&eng->hal);
        om_hal_close(&eng->hal);
        eng->hal_open = false;
        eng->last_requested_hal_rate = 0;
    }
    eng->resampler_active = false;
    eng->playing_path[0] = '\0';
    eng->played_frame_idx = 0;
    om_mutex_unlock(&eng->lock);
}

int om_engine_seek_seconds(om_engine_t *eng, double seconds) {
    if (seconds < 0.0) seconds = 0.0;
    om_mutex_lock(&eng->lock);
    if (!eng->has_active_dec || eng->active_dec.info.sample_rate == 0) {
        om_mutex_unlock(&eng->lock);
        return -1;
    }
    uint64_t target = (uint64_t)(seconds * (double)eng->active_dec.info.sample_rate);
    if (eng->active_dec.info.total_frames > 0 && target > eng->active_dec.info.total_frames) {
        target = eng->active_dec.info.total_frames;
    }
    eng->cmd_generation++;
    wait_decoder_idle_unlocked(eng);

    eng->seek_target_frame = target;
    eng->pending_seek = true;
    eng->played_frame_idx = target;
    ring_flush_unlocked(eng);
    om_resampler_reset(&eng->resampler);
    if (eng->hal_open) om_hal_drop(&eng->hal);
    om_cond_broadcast(&eng->cond_can_push);
    om_mutex_unlock(&eng->lock);
    return 0;
}

void om_engine_set_volume(om_engine_t *eng, double volume_0_to_1) {
    if (volume_0_to_1 < 0.0) volume_0_to_1 = 0.0;
    if (volume_0_to_1 > 1.0) volume_0_to_1 = 1.0;
    om_mutex_lock(&eng->lock);
    eng->volume_lin = volume_0_to_1;
    eng->volume_unity = (fabs(volume_0_to_1 - 1.0) < 1e-4);
    om_mutex_unlock(&eng->lock);
}
