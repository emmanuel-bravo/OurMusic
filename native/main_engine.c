#include "engine_core.h"
#include "dsp_loudness.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

static om_mutex_t g_stdout_lock;

static void write_json_esc(FILE *out, const char *s) {
    fputc('"', out);
    for (size_t i = 0; s && s[i]; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c == '"') fputs("\\\"", out);
        else if (c == '\\') fputs("\\\\", out);
        else if (c == '\n') fputs("\\n", out);
        else if (c == '\r') fputs("\\r", out);
        else if (c == '\t') fputs("\\t", out);
        else if (c >= 0x20) fputc(c, out);
    }
    fputc('"', out);
}

static void on_engine_event(const char *event_type, const char *json_payload, void *ud) {
    (void)ud;
    om_mutex_lock(&g_stdout_lock);
    fprintf(stdout, "{\"type\":\"event\",\"event\":\"%s\",\"data\":%s}\n", event_type, json_payload);
    fflush(stdout);
    om_mutex_unlock(&g_stdout_lock);
}

/* Minimal, safe JSON field extractors for command objects */
static const char *find_json_key_range(const char *start, const char *end, const char *key) {
    char pat[128];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    size_t plen = strlen(pat);
    const char *p = start;
    while (p < end && (p = strstr(p, pat)) != NULL && p < end) {
        const char *after = p + plen;
        while (after < end && isspace((unsigned char)*after)) after++;
        if (after < end && *after == ':') {
            after++;
            while (after < end && isspace((unsigned char)*after)) after++;
            return after;
        }
        p += plen;
    }
    return NULL;
}

static const char *find_json_key(const char *json, const char *key) {
    return find_json_key_range(json, json + strlen(json), key);
}

static bool json_get_str_range(const char *start, const char *end, const char *key, char *out, size_t cap) {
    const char *v = find_json_key_range(start, end, key);
    if (!v || v >= end || *v != '"') return false;
    v++;
    size_t j = 0;
    while (v < end && *v && *v != '"' && j + 1 < cap) {
        if (*v == '\\' && (v + 1) < end && v[1]) {
            v++;
            if (*v == 'n') out[j++] = '\n';
            else if (*v == 'r') out[j++] = '\r';
            else if (*v == 't') out[j++] = '\t';
            else out[j++] = *v;
            v++;
        } else {
            out[j++] = *v++;
        }
    }
    out[j] = '\0';
    return true;
}

static bool json_get_str(const char *json, const char *key, char *out, size_t cap) {
    return json_get_str_range(json, json + strlen(json), key, out, cap);
}

static bool json_get_num_range(const char *start, const char *end, const char *key, double *out) {
    const char *v = find_json_key_range(start, end, key);
    if (!v || v >= end || (*v != '-' && *v != '+' && !isdigit((unsigned char)*v))) return false;
    char *endp = NULL;
    *out = strtod(v, &endp);
    return endp != v && endp <= end;
}

static bool json_get_num(const char *json, const char *key, double *out) {
    return json_get_num_range(json, json + strlen(json), key, out);
}

static bool json_get_bool_range(const char *start, const char *end, const char *key, bool *out) {
    const char *v = find_json_key_range(start, end, key);
    if (!v || v >= end) return false;
    if ((end - v) >= 4 && strncmp(v, "true", 4) == 0) { *out = true; return true; }
    if ((end - v) >= 5 && strncmp(v, "false", 5) == 0) { *out = false; return true; }
    return false;
}

static bool json_get_bool(const char *json, const char *key, bool *out) {
    return json_get_bool_range(json, json + strlen(json), key, out);
}

static int json_get_num_array(const char *json, const char *key, double *out, int max_len) {
    const char *v = find_json_key(json, key);
    if (!v || *v != '[') return 0;
    v++;
    int n = 0;
    while (*v && *v != ']' && n < max_len) {
        while (*v && (isspace((unsigned char)*v) || *v == ',')) v++;
        if (!*v || *v == ']') break;
        char *endp = NULL;
        double d = strtod(v, &endp);
        if (endp == v) break;
        out[n++] = d;
        v = endp;
    }
    return n;
}

/* Parse "bands":[{"type":"peaking","freq":1000,"q":2.0,"gainDb":-3.5,"enabled":true}, ...] */
static int json_parse_peq_bands(const char *json, om_peq_band_spec_t *out_bands, int max_bands) {
    const char *v = find_json_key(json, "bands");
    if (!v || *v != '[') return 0;
    v++;
    int count = 0;
    while (*v && *v != ']' && count < max_bands) {
        while (*v && *v != '{' && *v != ']') v++;
        if (!*v || *v == ']') break;
        const char *obj_start = v;
        int depth = 0;
        bool in_str = false;
        while (*v) {
            if (*v == '"' && (v == obj_start || v[-1] != '\\')) in_str = !in_str;
            else if (!in_str) {
                if (*v == '{') depth++;
                else if (*v == '}') {
                    depth--;
                    if (depth == 0) { v++; break; }
                }
            }
            v++;
        }
        const char *obj_end = v;

        char type_s[32] = "peaking";
        double freq = 1000.0, q = 1.0, gain = 0.0;
        bool en = true;

        json_get_str_range(obj_start, obj_end, "type", type_s, sizeof(type_s));
        if (!json_get_num_range(obj_start, obj_end, "freq", &freq)) {
            json_get_num_range(obj_start, obj_end, "freqHz", &freq);
        }
        json_get_num_range(obj_start, obj_end, "q", &q);
        if (!json_get_num_range(obj_start, obj_end, "gainDb", &gain)) {
            json_get_num_range(obj_start, obj_end, "gain", &gain);
        }
        json_get_bool_range(obj_start, obj_end, "enabled", &en);

        out_bands[count].type = om_filter_type_from_str(type_s);
        out_bands[count].freq_hz = freq;
        out_bands[count].q = q;
        out_bands[count].gain_db = gain;
        out_bands[count].enabled = en;
        count++;
    }
    return count;
}

static om_src_quality_t parse_src_quality(const char *s) {
    if (!s) return OM_SRC_QUALITY_HIGH;
    if (om_strcasecmp(s, "fast") == 0) return OM_SRC_QUALITY_FAST;
    if (om_strcasecmp(s, "ultra") == 0) return OM_SRC_QUALITY_ULTRA;
    return OM_SRC_QUALITY_HIGH;
}

static om_rg_mode_t parse_rg_mode(const char *s) {
    if (!s) return OM_RG_OFF;
    if (om_strcasecmp(s, "track") == 0) return OM_RG_TRACK;
    if (om_strcasecmp(s, "album") == 0) return OM_RG_ALBUM;
    return OM_RG_OFF;
}

static const char *rg_mode_to_str(om_rg_mode_t m) {
    if (m == OM_RG_TRACK) return "track";
    if (m == OM_RG_ALBUM) return "album";
    return "off";
}

static void print_status_json(om_engine_t *eng, long req_id) {
    om_mutex_lock(&eng->lock);
    om_play_state_t st = eng->state;
    char path[1024];
    snprintf(path, sizeof(path), "%s", eng->playing_path[0] ? eng->playing_path : eng->active_path);
    om_stream_info_t info = eng->playing_info;
    uint64_t played = eng->played_frame_idx;
    bool bp = eng->signal_bitperfect;
    uint64_t gapless = eng->gapless_transitions;
    bool hal_open = eng->hal_open;
    om_hal_handle_t hal = eng->hal;
    double vol = eng->volume_lin;
    bool src_active = eng->resampler_active;
    uint32_t src_target = eng->resampler_target_rate;
    char req_dev[1024];
    snprintf(req_dev, sizeof(req_dev), "%s", eng->req_device_id);
    om_mutex_unlock(&eng->lock);

    om_dsp_meters_t m = om_dsp_get_meters(&eng->dsp);
    om_mutex_lock(&eng->dsp.lock);
    bool eq_on = eng->dsp.eq_enabled;
    bool peq_mode = eng->dsp.peq_mode;
    bool smooth_on = eng->dsp.smoothing_enabled;
    bool hook_on = eng->dsp.custom_hook_enabled;
    double swidth = eng->dsp.stereo_width;
    double preamp_db = eng->dsp.target_preamp_db;
    int nbands = eng->dsp.num_bands;
    double bfreqs[OM_EQ_MAX_BANDS];
    double bgains[OM_EQ_MAX_BANDS];
    double bq_arr[OM_EQ_MAX_BANDS];
    om_filter_type_t btypes[OM_EQ_MAX_BANDS];
    memcpy(bfreqs, eng->dsp.band_freqs, sizeof(bfreqs));
    memcpy(bgains, eng->dsp.cur_band_db, sizeof(bgains));
    memcpy(bq_arr, eng->dsp.band_q, sizeof(bq_arr));
    memcpy(btypes, eng->dsp.band_types, sizeof(btypes));

    bool xf_on = eng->dsp.crossfeed_enabled;
    double xf_fc = eng->dsp.crossfeed_cutoff_hz;
    double xf_db = eng->dsp.crossfeed_feed_db;
    double xf_itd = eng->dsp.crossfeed_itd_us;

    bool conv_on = eng->dsp.convolver.enabled && eng->dsp.convolver.ir_loaded;
    size_t conv_frames = eng->dsp.convolver.active_ir_frames;
    double conv_mix = eng->dsp.convolver.wet_mix;

    om_rg_mode_t rg_mode = eng->dsp.rg_mode;
    double rg_lin = eng->dsp.rg_effective_lin;
    om_mutex_unlock(&eng->dsp.lock);

    double pos_sec = (info.sample_rate > 0) ? ((double)played / (double)info.sample_rate) : 0.0;
    const char *st_str = (st == OM_STATE_PLAYING) ? "playing" : (st == OM_STATE_PAUSED ? "paused" : "stopped");

    om_mutex_lock(&g_stdout_lock);
    fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true,\"status\":{", req_id);
    fprintf(stdout, "\"state\":\"%s\",\"path\":", st_str);
    write_json_esc(stdout, path);
    fprintf(stdout, ",\"positionSec\":%.4f,\"durationSec\":%.4f", pos_sec, info.duration_sec);
    fprintf(stdout, ",\"codec\":\"%s\",\"sampleRate\":%u,\"bitDepth\":%u,\"channels\":%u,\"dsdBitRate\":%u,\"isDoP\":%s,\"isDsdNative\":%s",
            om_codec_name(info.codec), info.sample_rate, info.bit_depth, info.channels, info.dsd_bit_rate,
            info.is_dop ? "true" : "false", info.is_dsd_native ? "true" : "false");
    fprintf(stdout, ",\"halOpen\":%s,\"halBackend\":", hal_open ? "true" : "false");
    write_json_esc(stdout, hal_open ? hal.backend_name : "Idle");
    fprintf(stdout, ",\"halDevice\":");
    write_json_esc(stdout, hal_open ? hal.device_id : req_dev);
    fprintf(stdout, ",\"halRate\":%u,\"halBitDepth\":%u,\"bitPerfect\":%s,\"resamplerActive\":%s,\"resamplerTargetRate\":%u,\"gaplessTransitions\":%llu,\"volume\":%.3f",
            hal_open ? hal.actual_rate : 0, hal_open ? hal.actual_bit_depth : 0,
            bp ? "true" : "false", src_active ? "true" : "false", src_target,
            (unsigned long long)gapless, vol);
    fprintf(stdout, ",\"eqEnabled\":%s,\"peqMode\":%s,\"smoothingEnabled\":%s,\"customHookEnabled\":%s,\"stereoWidth\":%.2f,\"preampDb\":%.2f,\"numBands\":%d",
            eq_on ? "true" : "false", peq_mode ? "true" : "false", smooth_on ? "true" : "false",
            hook_on ? "true" : "false", swidth, preamp_db, nbands);
    fprintf(stdout, ",\"crossfeedEnabled\":%s,\"crossfeedCutoffHz\":%.1f,\"crossfeedFeedDb\":%.2f,\"crossfeedItdUs\":%.1f",
            xf_on ? "true" : "false", xf_fc, xf_db, xf_itd);
    fprintf(stdout, ",\"convolverEnabled\":%s,\"convolverIrFrames\":%llu,\"convolverMix\":%.2f",
            conv_on ? "true" : "false", (unsigned long long)conv_frames, conv_mix);
    fprintf(stdout, ",\"replayGainMode\":\"%s\",\"replayGainLinear\":%.5f", rg_mode_to_str(rg_mode), rg_lin);
    fprintf(stdout, ",\"bandFreqs\":[");
    for (int i = 0; i < nbands; i++) fprintf(stdout, "%s%.1f", i ? "," : "", bfreqs[i]);
    fprintf(stdout, "],\"bandQs\":[");
    for (int i = 0; i < nbands; i++) fprintf(stdout, "%s%.3f", i ? "," : "", bq_arr[i]);
    fprintf(stdout, "],\"bandTypes\":[");
    for (int i = 0; i < nbands; i++) fprintf(stdout, "%s\"%s\"", i ? "," : "", om_filter_type_to_str(btypes[i]));
    fprintf(stdout, "],\"smoothedGains\":[");
    for (int i = 0; i < nbands; i++) fprintf(stdout, "%s%.3f", i ? "," : "", bgains[i]);
    fprintf(stdout, "],\"meters\":{\"peakL\":%.5f,\"peakR\":%.5f,\"rmsL\":%.5f,\"rmsR\":%.5f,\"clippedSamples\":%llu,\"hookInvocations\":%llu}",
            m.peak_l, m.peak_r, m.rms_l, m.rms_r,
            (unsigned long long)m.clipped_samples, (unsigned long long)m.hook_invocations);
    fprintf(stdout, "}}\n");
    fflush(stdout);
    om_mutex_unlock(&g_stdout_lock);
}

static int run_cli_probe(const char *path) {
    om_decoder_t dec;
    char err[256] = {0};
    if (om_decoder_open_any(path, false, &dec, err, sizeof(err)) != 0) {
        fprintf(stdout, "{\"ok\":false,\"error\":");
        write_json_esc(stdout, err);
        fprintf(stdout, "}\n");
        return 1;
    }
    fprintf(stdout, "{\"ok\":true,\"codec\":\"%s\",\"sampleRate\":%u,\"bitDepth\":%u,\"channels\":%u,\"totalFrames\":%llu,\"durationSec\":%.6f,\"dsdBitRate\":%u,\"isFloat\":%s}\n",
            om_codec_name(dec.info.codec), dec.info.sample_rate, dec.info.bit_depth,
            dec.info.channels, (unsigned long long)dec.info.total_frames, dec.info.duration_sec,
            dec.info.dsd_bit_rate, dec.info.is_float ? "true" : "false");
    dec.close(&dec);
    return 0;
}

static int run_cli_loudness(const char *path) {
    om_loudness_result_t res;
    char err[256] = {0};
    if (om_loudness_scan_file(path, &res, err, sizeof(err)) != 0) {
        fprintf(stdout, "{\"ok\":false,\"error\":");
        write_json_esc(stdout, err);
        fprintf(stdout, "}\n");
        return 1;
    }
    fprintf(stdout,
            "{\"ok\":true,\"integratedLufs\":%.4f,\"loudnessRangeLu\":%.4f,\"samplePeak\":%.6f,\"truePeak\":%.6f,\"peakDb\":%.4f,\"truePeakDbtp\":%.4f,\"replayGainDb\":%.4f,\"replayGain18Db\":%.4f,\"r128GainDb\":%.4f}\n",
            res.integrated_lufs, res.loudness_range_lu, res.sample_peak,
            res.true_peak, res.peak_db, res.peak_db, res.replaygain_db, res.replaygain_db, res.r128_gain_db);
    return 0;
}

int main(int argc, char **argv) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    if (argc >= 3 && strcmp(argv[1], "--probe") == 0) {
        return run_cli_probe(argv[2]);
    }
    if (argc >= 3 && strcmp(argv[1], "--scan-loudness") == 0) {
        return run_cli_loudness(argv[2]);
    }
    if (argc >= 2 && strcmp(argv[1], "--devices") == 0) {
        om_hal_device_info_t devs[OM_HAL_MAX_DEVICES];
        size_t n = om_hal_enumerate_devices(devs, OM_HAL_MAX_DEVICES);
        fprintf(stdout, "{\"ok\":true,\"devices\":[");
        for (size_t i = 0; i < n; i++) {
            if (i) fputc(',', stdout);
            fprintf(stdout, "{\"id\":");
            write_json_esc(stdout, devs[i].id);
            fprintf(stdout, ",\"name\":");
            write_json_esc(stdout, devs[i].name);
            fprintf(stdout, ",\"exclusiveCapable\":%s,\"isDefault\":%s}",
                    devs[i].is_exclusive_capable ? "true" : "false",
                    devs[i].is_default ? "true" : "false");
        }
        fprintf(stdout, "]}\n");
        return 0;
    }

    om_mutex_init(&g_stdout_lock);
    om_engine_t eng;
    if (om_engine_init(&eng, on_engine_event, NULL) != 0) {
        fprintf(stderr, "Failed to initialize OurMusic native audio engine\n");
        return 1;
    }

    om_mutex_lock(&g_stdout_lock);
    fprintf(stdout, "{\"type\":\"ready\",\"engine\":\"OurMusic Native C11 Engine\",\"version\":\"2.0.0\"}\n");
    fflush(stdout);
    om_mutex_unlock(&g_stdout_lock);

    char line[32768];
    while (fgets(line, sizeof(line), stdin) != NULL) {
        char cmd[64] = {0};
        if (!json_get_str(line, "cmd", cmd, sizeof(cmd))) continue;

        double id_num = 0;
        long req_id = json_get_num(line, "id", &id_num) ? (long)id_num : 0;

        if (strcmp(cmd, "quit") == 0) {
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true}\n", req_id);
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
            break;
        } else if (strcmp(cmd, "status") == 0) {
            print_status_json(&eng, req_id);
        } else if (strcmp(cmd, "list_devices") == 0) {
            om_hal_device_info_t devs[OM_HAL_MAX_DEVICES];
            size_t n = om_hal_enumerate_devices(devs, OM_HAL_MAX_DEVICES);
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true,\"devices\":[", req_id);
            for (size_t i = 0; i < n; i++) {
                if (i) fputc(',', stdout);
                fprintf(stdout, "{\"id\":");
                write_json_esc(stdout, devs[i].id);
                fprintf(stdout, ",\"name\":");
                write_json_esc(stdout, devs[i].name);
                fprintf(stdout, ",\"exclusiveCapable\":%s,\"isDefault\":%s}",
                        devs[i].is_exclusive_capable ? "true" : "false",
                        devs[i].is_default ? "true" : "false");
            }
            fprintf(stdout, "]}\n");
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "probe") == 0) {
            char p[1024] = {0};
            json_get_str(line, "path", p, sizeof(p));
            om_decoder_t dec;
            char err[256] = {0};
            if (om_decoder_open_any(p, false, &dec, err, sizeof(err)) != 0) {
                om_mutex_lock(&g_stdout_lock);
                fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":false,\"error\":", req_id);
                write_json_esc(stdout, err);
                fprintf(stdout, "}\n");
                fflush(stdout);
                om_mutex_unlock(&g_stdout_lock);
            } else {
                om_mutex_lock(&g_stdout_lock);
                fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true,\"probe\":{\"codec\":\"%s\",\"sampleRate\":%u,\"bitDepth\":%u,\"channels\":%u,\"totalFrames\":%llu,\"durationSec\":%.6f,\"dsdBitRate\":%u}}\n",
                        req_id, om_codec_name(dec.info.codec), dec.info.sample_rate, dec.info.bit_depth,
                        dec.info.channels, (unsigned long long)dec.info.total_frames, dec.info.duration_sec,
                        dec.info.dsd_bit_rate);
                fflush(stdout);
                om_mutex_unlock(&g_stdout_lock);
                dec.close(&dec);
            }
        } else if (strcmp(cmd, "scan_loudness") == 0) {
            char p[1024] = {0};
            json_get_str(line, "path", p, sizeof(p));
            om_loudness_result_t lres;
            char err[256] = {0};
            if (om_loudness_scan_file(p, &lres, err, sizeof(err)) != 0) {
                om_mutex_lock(&g_stdout_lock);
                fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":false,\"error\":", req_id);
                write_json_esc(stdout, err);
                fprintf(stdout, "}\n");
                fflush(stdout);
                om_mutex_unlock(&g_stdout_lock);
            } else {
                om_mutex_lock(&g_stdout_lock);
                fprintf(stdout,
                        "{\"type\":\"reply\",\"id\":%ld,\"ok\":true,\"loudness\":{\"integratedLufs\":%.4f,\"loudnessRangeLu\":%.4f,\"samplePeak\":%.6f,\"truePeak\":%.6f,\"peakDb\":%.4f,\"truePeakDbtp\":%.4f,\"replayGainDb\":%.4f,\"replayGain18Db\":%.4f,\"r128GainDb\":%.4f}}\n",
                        req_id, lres.integrated_lufs, lres.loudness_range_lu, lres.sample_peak,
                        lres.true_peak, lres.peak_db, lres.peak_db, lres.replaygain_db, lres.replaygain_db, lres.r128_gain_db);
                fflush(stdout);
                om_mutex_unlock(&g_stdout_lock);
            }
        } else if (strcmp(cmd, "play") == 0) {
            char p[1024] = {0}, np[1024] = {0}, err[256] = {0};
            json_get_str(line, "path", p, sizeof(p));
            json_get_str(line, "nextPath", np, sizeof(np));
            bool ok = (om_engine_load_and_play(&eng, p, np, err, sizeof(err)) == 0);
            om_mutex_lock(&g_stdout_lock);
            if (ok) {
                fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true}\n", req_id);
            } else {
                fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":false,\"error\":", req_id);
                write_json_esc(stdout, err);
                fprintf(stdout, "}\n");
            }
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "queue_next") == 0) {
            char np[1024] = {0}, err[256] = {0};
            json_get_str(line, "path", np, sizeof(np));
            bool ok = (om_engine_queue_next_gapless(&eng, np, err, sizeof(err)) == 0);
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":%s}\n", req_id, ok ? "true" : "false");
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "pause") == 0) {
            bool paused = true;
            json_get_bool(line, "paused", &paused);
            om_engine_pause(&eng, paused);
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true}\n", req_id);
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "stop") == 0) {
            om_engine_stop(&eng);
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true}\n", req_id);
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "seek") == 0) {
            double sec = 0.0;
            json_get_num(line, "seconds", &sec);
            bool ok = (om_engine_seek_seconds(&eng, sec) == 0);
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":%s}\n", req_id, ok ? "true" : "false");
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "volume") == 0) {
            double vol = 1.0;
            if (json_get_num(line, "value", &vol)) om_engine_set_volume(&eng, vol);
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true}\n", req_id);
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "set_device") == 0) {
            char dev[1024] = "default";
            char dsd_mode_s[32] = {0};
            bool bp = true, dop = false;
            json_get_str(line, "device", dev, sizeof(dev));
            json_get_bool(line, "bitPerfect", &bp);
            json_get_bool(line, "dop", &dop);
            om_engine_set_output_device(&eng, dev, bp, dop);
            if (json_get_str(line, "dsdMode", dsd_mode_s, sizeof(dsd_mode_s))) {
                if (om_strcasecmp(dsd_mode_s, "native") == 0) om_engine_set_dsd_mode(&eng, OM_DSD_MODE_NATIVE);
                else if (om_strcasecmp(dsd_mode_s, "dop") == 0) om_engine_set_dsd_mode(&eng, OM_DSD_MODE_DOP);
                else om_engine_set_dsd_mode(&eng, OM_DSD_MODE_PCM);
            }
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true}\n", req_id);
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "set_resampler") == 0) {
            double tr_d = 0.0;
            char qual_s[32] = "high";
            json_get_num(line, "targetRate", &tr_d);
            json_get_str(line, "quality", qual_s, sizeof(qual_s));
            uint32_t tr = (tr_d >= 8000.0 && tr_d <= 768000.0) ? (uint32_t)tr_d : 0U;
            om_engine_set_resampler_config(&eng, tr, parse_src_quality(qual_s));
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true}\n", req_id);
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "set_eq") == 0) {
            bool en = false, sm = true, lim = true;
            double nb_d = 5.0, pre_db = 0.0;
            double gains[OM_EQ_MAX_BANDS] = {0};
            if (json_get_bool(line, "smoothing", &sm)) om_dsp_set_smoothing(&eng.dsp, sm);
            if (json_get_bool(line, "limiter", &lim)) om_dsp_set_limiter(&eng.dsp, lim);
            int got_g = json_get_num_array(line, "gains", gains, OM_EQ_MAX_BANDS);
            int nb = json_get_num(line, "numBands", &nb_d) ? (int)nb_d : (got_g >= 10 ? 10 : 5);
            json_get_num(line, "preampDb", &pre_db);
            if (got_g > 0) {
                om_dsp_set_all_bands_db(&eng.dsp, nb, gains, pre_db);
            } else {
                om_dsp_set_band_layout(&eng.dsp, nb);
                om_dsp_set_preamp_db(&eng.dsp, pre_db);
            }
            if (json_get_bool(line, "enabled", &en)) om_dsp_set_eq_enabled(&eng.dsp, en);
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true}\n", req_id);
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "set_peq") == 0) {
            bool en = true, sm = true, lim = true;
            double pre_db = 0.0;
            om_peq_band_spec_t specs[OM_EQ_MAX_BANDS];
            if (json_get_bool(line, "smoothing", &sm)) om_dsp_set_smoothing(&eng.dsp, sm);
            if (json_get_bool(line, "limiter", &lim)) om_dsp_set_limiter(&eng.dsp, lim);
            json_get_num(line, "preampDb", &pre_db);
            int nspecs = json_parse_peq_bands(line, specs, OM_EQ_MAX_BANDS);
            if (nspecs > 0) {
                om_dsp_set_peq_bands(&eng.dsp, nspecs, specs, pre_db);
            } else {
                om_dsp_set_preamp_db(&eng.dsp, pre_db);
            }
            if (json_get_bool(line, "enabled", &en)) om_dsp_set_eq_enabled(&eng.dsp, en);
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true}\n", req_id);
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "set_peq_band") == 0) {
            double idx_d = 0.0, freq = 1000.0, q = 1.0, gain = 0.0;
            char type_s[32] = "peaking";
            bool en = true;
            json_get_num(line, "band", &idx_d);
            json_get_str(line, "type", type_s, sizeof(type_s));
            json_get_num(line, "freq", &freq);
            json_get_num(line, "q", &q);
            json_get_num(line, "gainDb", &gain);
            json_get_bool(line, "enabled", &en);
            om_dsp_set_peq_single_band(&eng.dsp, (int)idx_d, om_filter_type_from_str(type_s), freq, q, gain, en);
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true}\n", req_id);
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "set_band") == 0) {
            double b_d = 0.0, g_d = 0.0;
            if (json_get_num(line, "band", &b_d) && json_get_num(line, "gainDb", &g_d)) {
                om_dsp_set_band_gain_db(&eng.dsp, (int)b_d, g_d);
            }
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true}\n", req_id);
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "set_preamp") == 0) {
            double pre = 0.0;
            if (json_get_num(line, "preampDb", &pre)) om_dsp_set_preamp_db(&eng.dsp, pre);
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true}\n", req_id);
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "set_smoothing") == 0) {
            bool sm = true;
            if (json_get_bool(line, "enabled", &sm)) om_dsp_set_smoothing(&eng.dsp, sm);
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true}\n", req_id);
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "set_crossfeed") == 0) {
            bool en = false;
            double fc = 700.0, fdb = -6.0, itd = 260.0;
            json_get_bool(line, "enabled", &en);
            json_get_num(line, "cutoffHz", &fc);
            json_get_num(line, "feedDb", &fdb);
            json_get_num(line, "itdUs", &itd);
            om_dsp_set_crossfeed(&eng.dsp, en, fc, fdb, itd);
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true}\n", req_id);
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "set_convolver") == 0) {
            bool en = false, anorm = false;
            char ir_p[1024] = {0}, err[256] = {0};
            double mix = 1.0, gdb = 0.0;
            json_get_bool(line, "enabled", &en);
            json_get_str(line, "irPath", ir_p, sizeof(ir_p));
            json_get_num(line, "mix", &mix);
            json_get_num(line, "gainDb", &gdb);
            json_get_bool(line, "autoNormalize", &anorm);
            bool ok = (om_dsp_set_convolver(&eng.dsp, en, ir_p, mix, gdb, anorm, err, sizeof(err)) == 0);
            om_mutex_lock(&g_stdout_lock);
            if (ok) {
                fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true}\n", req_id);
            } else {
                fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":false,\"error\":", req_id);
                write_json_esc(stdout, err);
                fprintf(stdout, "}\n");
            }
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "set_replaygain") == 0) {
            char mode_s[32] = "off";
            double tg = 0.0, tp = 0.0, ag = 0.0, ap = 0.0, pre = 0.0;
            bool noclip = true;
            json_get_str(line, "mode", mode_s, sizeof(mode_s));
            json_get_num(line, "trackGainDb", &tg);
            json_get_num(line, "trackPeak", &tp);
            json_get_num(line, "albumGainDb", &ag);
            json_get_num(line, "albumPeak", &ap);
            json_get_num(line, "preampDb", &pre);
            json_get_bool(line, "preventClipping", &noclip);
            om_dsp_set_replaygain(&eng.dsp, parse_rg_mode(mode_s), tg, tp, ag, ap, pre, noclip);
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true}\n", req_id);
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        } else if (strcmp(cmd, "set_hook") == 0) {
            bool en = false;
            double sw = 1.0;
            json_get_bool(line, "enabled", &en);
            json_get_num(line, "stereoWidth", &sw);
            om_dsp_set_custom_hook(&eng.dsp, en, sw);
            om_mutex_lock(&g_stdout_lock);
            fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true}\n", req_id);
            fflush(stdout);
            om_mutex_unlock(&g_stdout_lock);
        }
    }

    om_engine_shutdown(&eng);
    om_mutex_destroy(&g_stdout_lock);
    return 0;
}
