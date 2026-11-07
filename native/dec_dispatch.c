#include "audio_formats.h"
#include "os_compat.h"
#include <stdio.h>
#include <string.h>

const char *om_codec_name(om_codec_id_t id) {
    switch (id) {
        case OM_CODEC_WAV:  return "WAV";
        case OM_CODEC_FLAC: return "FLAC";
        case OM_CODEC_ALAC: return "ALAC";
        case OM_CODEC_MP3:  return "MP3";
        case OM_CODEC_DSD:  return "DSD";
        default:            return "UNKNOWN";
    }
}

int om_decoder_open_any_ex(const char *path, om_dsd_mode_t dsd_mode, om_decoder_t *out_dec, char *err, size_t err_cap) {
    if (!path || !out_dec) {
        if (err && err_cap) snprintf(err, err_cap, "Invalid decoder arguments");
        return -1;
    }

    FILE *fp = fopen(path, "rb");
    if (!fp) {
        if (err && err_cap) snprintf(err, err_cap, "Cannot open file: %s", path);
        return -1;
    }
    uint8_t magic[12] = {0};
    size_t got = fread(magic, 1, sizeof(magic), fp);
    fclose(fp);
    if (got < 4) {
        if (err && err_cap) snprintf(err, err_cap, "File too small: %s", path);
        return -1;
    }

    if (memcmp(magic, "RIFF", 4) == 0 && got >= 12 && memcmp(magic + 8, "WAVE", 4) == 0) {
        return om_decoder_open_wav(path, out_dec, err, err_cap);
    }
    if (memcmp(magic, "fLaC", 4) == 0) {
        return om_decoder_open_flac(path, out_dec, err, err_cap);
    }
    if (memcmp(magic, "DSD ", 4) == 0 || memcmp(magic, "FRM8", 4) == 0) {
        return om_decoder_open_dsd_ex(path, dsd_mode, out_dec, err, err_cap);
    }
    if (got >= 8 && memcmp(magic + 4, "ftyp", 4) == 0) {
        return om_decoder_open_alac(path, out_dec, err, err_cap);
    }

    const char *ext = strrchr(path, '.');
    if (ext) {
        if (om_strcasecmp(ext, ".flac") == 0) return om_decoder_open_flac(path, out_dec, err, err_cap);
        if (om_strcasecmp(ext, ".wav") == 0)  return om_decoder_open_wav(path, out_dec, err, err_cap);
        if (om_strcasecmp(ext, ".m4a") == 0 || om_strcasecmp(ext, ".alac") == 0 || om_strcasecmp(ext, ".mp4") == 0) {
            return om_decoder_open_alac(path, out_dec, err, err_cap);
        }
        if (om_strcasecmp(ext, ".dsf") == 0 || om_strcasecmp(ext, ".dff") == 0) {
            return om_decoder_open_dsd_ex(path, dsd_mode, out_dec, err, err_cap);
        }
        if (om_strcasecmp(ext, ".mp3") == 0)  return om_decoder_open_mp3(path, out_dec, err, err_cap);
    }

    return om_decoder_open_mp3(path, out_dec, err, err_cap);
}

int om_decoder_open_any(const char *path, bool prefer_dop, om_decoder_t *out_dec, char *err, size_t err_cap) {
    return om_decoder_open_any_ex(path, prefer_dop ? OM_DSD_MODE_DOP : OM_DSD_MODE_PCM, out_dec, err, err_cap);
}
