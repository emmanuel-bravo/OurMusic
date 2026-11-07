#include "audio_formats.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    FILE    *fp;
    uint64_t data_offset;
    uint64_t data_bytes;
    uint64_t frames_read;
    uint16_t block_align;
    uint16_t container_bits;
    bool     ieee_float;
    uint8_t *io_buf;
    size_t   io_buf_frames;
} wav_priv_t;

static uint16_t rd_u16_le(const uint8_t *p) {
    return (uint16_t)(p[0] | ((uint16_t)p[1] << 8));
}

static uint32_t rd_u32_le(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static int wav_read_frames(om_decoder_t *dec, int32_t *out_i32, double *out_f64, size_t max_frames) {
    wav_priv_t *w = (wav_priv_t *)dec->priv;
    if (!w || !w->fp || max_frames == 0) return 0;

    uint64_t rem = (dec->info.total_frames > w->frames_read)
                       ? (dec->info.total_frames - w->frames_read)
                       : 0;
    if (rem == 0) return 0;

    size_t to_read = max_frames;
    if ((uint64_t)to_read > rem) to_read = (size_t)rem;
    if (to_read > w->io_buf_frames) to_read = w->io_buf_frames;

    size_t got = fread(w->io_buf, w->block_align, to_read, w->fp);
    if (got == 0) return 0;
    w->frames_read += got;

    uint16_t ch = dec->info.channels;
    size_t total_samples = got * ch;
    const uint8_t *src = w->io_buf;

    if (w->ieee_float) {
        if (w->container_bits == 32) {
            for (size_t i = 0; i < total_samples; i++) {
                float fv;
                memcpy(&fv, src + i * 4, 4);
                double dv = (double)fv;
                if (out_f64) out_f64[i] = dv;
                if (out_i32) out_i32[i] = om_f64_to_i32(dv, 24);
            }
        } else {
            for (size_t i = 0; i < total_samples; i++) {
                double dv;
                memcpy(&dv, src + i * 8, 8);
                if (out_f64) out_f64[i] = dv;
                if (out_i32) out_i32[i] = om_f64_to_i32(dv, 32);
            }
        }
        return (int)got;
    }

    if (w->container_bits == 8) {
        for (size_t i = 0; i < total_samples; i++) {
            int32_t v = (int32_t)src[i] - 128;
            if (out_i32) out_i32[i] = v;
            if (out_f64) out_f64[i] = (double)v / 128.0;
        }
    } else if (w->container_bits == 16) {
        for (size_t i = 0; i < total_samples; i++) {
            int16_t s = (int16_t)(src[i * 2] | ((uint16_t)src[i * 2 + 1] << 8));
            int32_t v = (int32_t)s;
            if (out_i32) out_i32[i] = v;
            if (out_f64) out_f64[i] = (double)v / 32768.0;
        }
    } else if (w->container_bits == 24) {
        for (size_t i = 0; i < total_samples; i++) {
            uint32_t u = (uint32_t)src[i * 3] |
                         ((uint32_t)src[i * 3 + 1] << 8) |
                         ((uint32_t)src[i * 3 + 2] << 16);
            int32_t v = (u & 0x800000U) ? (int32_t)(u | 0xFF000000U) : (int32_t)u;
            if (out_i32) out_i32[i] = v;
            if (out_f64) out_f64[i] = (double)v / 8388608.0;
        }
    } else if (w->container_bits == 32) {
        for (size_t i = 0; i < total_samples; i++) {
            uint32_t u = rd_u32_le(src + i * 4);
            int32_t v = (int32_t)u;
            if (dec->info.bit_depth == 24) {
                v >>= 8;
                if (out_i32) out_i32[i] = v;
                if (out_f64) out_f64[i] = (double)v / 8388608.0;
            } else {
                if (out_i32) out_i32[i] = v;
                if (out_f64) out_f64[i] = (double)v / 2147483648.0;
            }
        }
    }

    return (int)got;
}

static int wav_seek_frame(om_decoder_t *dec, uint64_t target_frame) {
    wav_priv_t *w = (wav_priv_t *)dec->priv;
    if (!w || !w->fp) return -1;
    if (target_frame > dec->info.total_frames) target_frame = dec->info.total_frames;
    uint64_t byte_pos = w->data_offset + target_frame * (uint64_t)w->block_align;
#ifdef _WIN32
    if (_fseeki64(w->fp, (int64_t)byte_pos, SEEK_SET) != 0) return -1;
#else
    if (fseeko(w->fp, (off_t)byte_pos, SEEK_SET) != 0) return -1;
#endif
    w->frames_read = target_frame;
    return 0;
}

static void wav_close(om_decoder_t *dec) {
    if (!dec || !dec->priv) return;
    wav_priv_t *w = (wav_priv_t *)dec->priv;
    if (w->fp) fclose(w->fp);
    free(w->io_buf);
    free(w);
    dec->priv = NULL;
}

int om_decoder_open_wav(const char *path, om_decoder_t *out_dec, char *err, size_t err_cap) {
    memset(out_dec, 0, sizeof(*out_dec));
    FILE *fp = fopen(path, "rb");
    if (!fp) {
        snprintf(err, err_cap, "Cannot open WAV file: %s", path);
        return -1;
    }

    uint8_t hdr[12];
    if (fread(hdr, 1, 12, fp) != 12 || memcmp(hdr, "RIFF", 4) != 0 || memcmp(hdr + 8, "WAVE", 4) != 0) {
        fclose(fp);
        snprintf(err, err_cap, "Not a valid RIFF/WAVE file");
        return -1;
    }

    bool got_fmt = false, got_data = false;
    uint16_t fmt_tag = 0, channels = 0, block_align = 0, bits_per_sample = 0, valid_bits = 0;
    uint32_t sample_rate = 0;
    uint64_t data_offset = 0, data_bytes = 0;

    while (!got_data) {
        uint8_t chdr[8];
        if (fread(chdr, 1, 8, fp) != 8) break;
        uint32_t csize = rd_u32_le(chdr + 4);
#ifdef _WIN32
        int64_t cstart = _ftelli64(fp);
#else
        off_t cstart = ftello(fp);
#endif
        if (memcmp(chdr, "fmt ", 4) == 0 && csize >= 16) {
            uint8_t fbuf[40];
            size_t rlen = csize < sizeof(fbuf) ? csize : sizeof(fbuf);
            if (fread(fbuf, 1, rlen, fp) != rlen) break;
            fmt_tag = rd_u16_le(fbuf + 0);
            channels = rd_u16_le(fbuf + 2);
            sample_rate = rd_u32_le(fbuf + 4);
            block_align = rd_u16_le(fbuf + 12);
            bits_per_sample = rd_u16_le(fbuf + 14);
            valid_bits = bits_per_sample;
            if (fmt_tag == 0xFFFE && rlen >= 40) {
                uint16_t vb = rd_u16_le(fbuf + 18);
                if (vb > 0 && vb <= bits_per_sample) valid_bits = vb;
                fmt_tag = rd_u16_le(fbuf + 24);
            }
            got_fmt = true;
        } else if (memcmp(chdr, "data", 4) == 0) {
            data_offset = (uint64_t)cstart;
            data_bytes = (uint64_t)csize;
            got_data = true;
            break;
        }

        uint64_t skip = (uint64_t)csize + (csize & 1U);
#ifdef _WIN32
        if (_fseeki64(fp, cstart + (int64_t)skip, SEEK_SET) != 0) break;
#else
        if (fseeko(fp, cstart + (off_t)skip, SEEK_SET) != 0) break;
#endif
    }

    if (!got_fmt || !got_data || channels == 0 || channels > OM_MAX_CHANNELS || sample_rate == 0) {
        fclose(fp);
        snprintf(err, err_cap, "Incomplete or unsupported WAV chunks");
        return -1;
    }

    bool is_float = (fmt_tag == 3);
    if (fmt_tag != 1 && fmt_tag != 3) {
        fclose(fp);
        snprintf(err, err_cap, "Unsupported WAV format tag: 0x%04x", fmt_tag);
        return -1;
    }
    if ((!is_float && bits_per_sample != 8 && bits_per_sample != 16 && bits_per_sample != 24 && bits_per_sample != 32) ||
        (is_float && bits_per_sample != 32 && bits_per_sample != 64)) {
        fclose(fp);
        snprintf(err, err_cap, "Unsupported WAV bit depth: %u", bits_per_sample);
        return -1;
    }
    if (block_align == 0) block_align = (uint16_t)(channels * (bits_per_sample / 8));

    wav_priv_t *w = (wav_priv_t *)calloc(1, sizeof(*w));
    w->fp = fp;
    w->data_offset = data_offset;
    w->data_bytes = data_bytes;
    w->block_align = block_align;
    w->container_bits = bits_per_sample;
    w->ieee_float = is_float;
    w->io_buf_frames = 4096;
    w->io_buf = (uint8_t *)malloc(w->io_buf_frames * block_align);

#ifdef _WIN32
    _fseeki64(fp, (int64_t)data_offset, SEEK_SET);
#else
    fseeko(fp, (off_t)data_offset, SEEK_SET);
#endif

    out_dec->name = "WAV";
    out_dec->priv = w;
    out_dec->info.codec = OM_CODEC_WAV;
    out_dec->info.sample_rate = sample_rate;
    out_dec->info.channels = channels;
    out_dec->info.bit_depth = is_float ? 24 : (valid_bits ? valid_bits : bits_per_sample);
    out_dec->info.is_float = is_float;
    out_dec->info.is_dop = false;
    out_dec->info.total_frames = data_bytes / block_align;
    out_dec->info.duration_sec = (double)out_dec->info.total_frames / (double)sample_rate;
    out_dec->read_frames = wav_read_frames;
    out_dec->seek_frame = wav_seek_frame;
    out_dec->close = wav_close;
    return 0;
}
