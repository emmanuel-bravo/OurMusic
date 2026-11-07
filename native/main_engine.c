#include "engine_core.h"
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

/* Minimal, safe JSON field extractors for flat command objects */
static const char *find_json_key(const char *json, const char *key) {
    char pat[128];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    size_t plen = strlen(pat);
    const char *p = json;
    while ((p = strstr(p, pat)) != NULL) {
        const char *after = p + plen;
        while (*after && isspace((unsigned char)*after)) after++;
        if (*after == ':') {
            after++;
            while (*after && isspace((unsigned char)*after)) after++;
            return after;
        }
        p += plen;
    }
    return NULL;
}

static bool json_get_str(const char *json, const char *key, char *out, size_t cap) {
    const char *v = find_json_key(json, key);
    if (!v || *v != '"') return false;
    v++;
    size_t j = 0;
    while (*v && *v != '"' && j + 1 < cap) {
        if (*v == '\\' && v[1]) {
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

static bool json_get_num(const char *json, const char *key, double *out) {
    const char *v = find_json_key(json, key);
    if (!v || (*v != '-' && *v != '+' && !isdigit((unsigned char)*v))) return false;
    char *endp = NULL;
    *out = strtod(v, &endp);
    return endp != v;
}

static bool json_get_bool(const char *json, const char *key, bool *out) {
    const char *v = find_json_key(json, key);
    if (!v) return false;
    if (strncmp(v, "true", 4) == 0) { *out = true; return true; }
    if (strncmp(v, "false", 5) == 0) { *out = false; return true; }
    return false;
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
    om_mutex_unlock(&eng->lock);

    om_dsp_meters_t m = om_dsp_get_meters(&eng->dsp);
    om_mutex_lock(&eng->dsp.lock);
    bool eq_on = eng->dsp.eq_enabled;
    bool smooth_on = eng->dsp.smoothing_enabled;
    bool hook_on = eng->dsp.custom_hook_enabled;
    double swidth = eng->dsp.stereo_width;
    double preamp_db = eng->dsp.target_preamp_db;
    int nbands = eng->dsp.num_bands;
    double bfreqs[OM_EQ_MAX_BANDS];
    double bgains[OM_EQ_MAX_BANDS];
    memcpy(bfreqs, eng->dsp.band_freqs, sizeof(bfreqs));
    memcpy(bgains, eng->dsp.cur_band_db, sizeof(bgains));
    om_mutex_unlock(&eng->dsp.lock);

    double pos_sec = (info.sample_rate > 0) ? ((double)played / (double)info.sample_rate) : 0.0;
    const char *st_str = (st == OM_STATE_PLAYING) ? "playing" : (st == OM_STATE_PAUSED ? "paused" : "stopped");

    om_mutex_lock(&g_stdout_lock);
    fprintf(stdout, "{\"type\":\"reply\",\"id\":%ld,\"ok\":true,\"status\":{", req_id);
    fprintf(stdout, "\"state\":\"%s\",\"path\":", st_str);
    write_json_esc(stdout, path);
    fprintf(stdout, ",\"positionSec\":%.4f,\"durationSec\":%.4f", pos_sec, info.duration_sec);
    fprintf(stdout, ",\"codec\":\"%s\",\"sampleRate\":%u,\"bitDepth\":%u,\"channels\":%u,\"dsdBitRate\":%u,\"isDoP\":%s",
            om_codec_name(info.codec), info.sample_rate, info.bit_depth, info.channels, info.dsd_bit_rate,
            info.is_dop ? "true" : "false");
    fprintf(stdout, ",\"halOpen\":%s,\"halBackend\":", hal_open ? "true" : "false");
    write_json_esc(stdout, hal_open ? hal.backend_name : "Idle");
    fprintf(stdout, ",\"halDevice\":");
    write_json_esc(stdout, hal_open ? hal.device_id : eng->req_device_id);
    fprintf(stdout, ",\"halRate\":%u,\"halBitDepth\":%u,\"bitPerfect\":%s,\"gaplessTransitions\":%llu,\"volume\":%.3f",
            hal_open ? hal.actual_rate : 0, hal_open ? hal.actual_bit_depth : 0,
            bp ? "true" : "false", (unsigned long long)gapless, vol);
    fprintf(stdout, ",\"eqEnabled\":%s,\"smoothingEnabled\":%s,\"customHookEnabled\":%s,\"stereoWidth\":%.2f,\"preampDb\":%.2f,\"numBands\":%d",
            eq_on ? "true" : "false", smooth_on ? "true" : "false", hook_on ? "true" : "false", swidth, preamp_db, nbands);
    fprintf(stdout, ",\"bandFreqs\":[");
    for (int i = 0; i < nbands; i++) fprintf(stdout, "%s%.0f", i ? "," : "", bfreqs[i]);
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

int main(int argc, char **argv) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    if (argc >= 3 && strcmp(argv[1], "--probe") == 0) {
        return run_cli_probe(argv[2]);
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
    fprintf(stdout, "{\"type\":\"ready\",\"engine\":\"OurMusic Native C11 Engine\",\"version\":\"1.0.0\"}\n");
    fflush(stdout);
    om_mutex_unlock(&g_stdout_lock);

    char line[16384];
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
            bool bp = true, dop = false;
            json_get_str(line, "device", dev, sizeof(dev));
            json_get_bool(line, "bitPerfect", &bp);
            json_get_bool(line, "dop", &dop);
            om_engine_set_output_device(&eng, dev, bp, dop);
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
