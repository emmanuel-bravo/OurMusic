#if defined(_WIN32) || defined(OM_WASAPI_SYNTAX_CHECK)

/*
 * Clean-room Windows Native ASIO Host Backend (C11, zero Steinberg SDK files).
 * Communicates directly with installed ASIO COM drivers via HKLM\SOFTWARE\ASIO
 * and the binary IASIO vtable ABI, supporting both non-interleaved Bit-Perfect PCM
 * (Int16/Int24/Int32/Float32/Float64) and Native 1-bit DSD Direct (IoFormat 1).
 */

#include "hal_asio.h"
#include "os_compat.h"

#ifdef OM_WASAPI_SYNTAX_CHECK
#include "../tests/wasapi_mock_headers.h"
#define ASIO_CALL
#define ASIO_THISCALL
#else
#include <windows.h>
#include <objbase.h>
#define ASIO_CALL __cdecl
#if defined(__i386__) || defined(_M_IX86)
#if defined(_MSC_VER)
#define ASIO_THISCALL __thiscall
#else
#define ASIO_THISCALL __attribute__((thiscall))
#endif
#else
#define ASIO_THISCALL __stdcall
#endif
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Documented ASIO binary ABI constants */
#define ASE_OK               0L
#define ASE_SUCCESS          0x3f4847a0L
#define ASIO_TRUE            1L
#define ASIO_FALSE           0L

/* ASIOSampleType */
#define ASIOSTInt16LSB       16L
#define ASIOSTInt24LSB       17L
#define ASIOSTInt32LSB       18L
#define ASIOSTFloat32LSB     19L
#define ASIOSTFloat64LSB     20L
#define ASIOSTDSDInt8LSB1    31L
#define ASIOSTDSDInt8MSB1    32L
#define ASIOSTDSDInt8NER8    40L

/* ASIO future() selector for Native DSD IoFormat negotiation */
#define kAsioSetIoFormat     0x23111961L
#define kAsioGetIoFormat     0x23111983L
#define kAsioCanDoIoFormat   0x23112004L
#define kASIOPCMFormat       0L
#define kASIODSDFormat       1L

/* ASIO host message selectors */
#define kAsioSelectorSupported    1L
#define kAsioEngineVersion        2L
#define kAsioResetRequest         3L
#define kAsioBufferSizeChange     4L
#define kAsioResyncRequest        5L
#define kAsioLatenciesChanged     6L
#define kAsioSupportsTimeInfo     7L
#define kAsioSupportsTimeCode     8L

typedef struct {
    long formatType;
    char future[512 - sizeof(long)];
} asio_io_format_t;

typedef struct {
    long isInput;
    long channelNum;
    void *buffers[2];
} asio_buffer_info_t;

typedef struct {
    long channel;
    long isInput;
    long isActive;
    long channelGroup;
    long type;
    char name[32];
} asio_channel_info_t;

typedef struct {
    void (ASIO_CALL *bufferSwitch)(long doubleBufferIndex, long directProcess);
    void (ASIO_CALL *sampleRateDidChange)(double sRate);
    long (ASIO_CALL *asioMessage)(long selector, long value, void *message, double *opt);
    void *(ASIO_CALL *bufferSwitchTimeInfo)(void *params, long doubleBufferIndex, long directProcess);
} asio_callbacks_t;

typedef struct om_iasio om_iasio_t;

typedef struct {
    /* IUnknown */
    HRESULT (
#ifdef _WIN32
        __stdcall
#endif
        *QueryInterface)(om_iasio_t *self, const IID *riid, void **ppv);
    unsigned long (
#ifdef _WIN32
        __stdcall
#endif
        *AddRef)(om_iasio_t *self);
    unsigned long (
#ifdef _WIN32
        __stdcall
#endif
        *Release)(om_iasio_t *self);

    /* IASIO */
    long (ASIO_THISCALL *init)(om_iasio_t *self, void *sysHandle);
    void (ASIO_THISCALL *getDriverName)(om_iasio_t *self, char *name);
    long (ASIO_THISCALL *getDriverVersion)(om_iasio_t *self);
    void (ASIO_THISCALL *getErrorMessage)(om_iasio_t *self, char *string);
    long (ASIO_THISCALL *start)(om_iasio_t *self);
    long (ASIO_THISCALL *stop)(om_iasio_t *self);
    long (ASIO_THISCALL *getChannels)(om_iasio_t *self, long *numInputChannels, long *numOutputChannels);
    long (ASIO_THISCALL *getLatencies)(om_iasio_t *self, long *inputLatency, long *outputLatency);
    long (ASIO_THISCALL *getBufferSize)(om_iasio_t *self, long *minSize, long *maxSize, long *preferredSize, long *granularity);
    long (ASIO_THISCALL *canSampleRate)(om_iasio_t *self, double sampleRate);
    long (ASIO_THISCALL *getSampleRate)(om_iasio_t *self, double *currentRate);
    long (ASIO_THISCALL *setSampleRate)(om_iasio_t *self, double sampleRate);
    long (ASIO_THISCALL *getClockSources)(om_iasio_t *self, void *clocks, long *numSources);
    long (ASIO_THISCALL *setClockSource)(om_iasio_t *self, long reference);
    long (ASIO_THISCALL *getSamplePosition)(om_iasio_t *self, void *sPos, void *tStamp);
    long (ASIO_THISCALL *getChannelInfo)(om_iasio_t *self, asio_channel_info_t *info);
    long (ASIO_THISCALL *createBuffers)(om_iasio_t *self, asio_buffer_info_t *bufferInfos, long numChannels, long bufferSize, asio_callbacks_t *callbacks);
    long (ASIO_THISCALL *disposeBuffers)(om_iasio_t *self);
    long (ASIO_THISCALL *controlPanel)(om_iasio_t *self);
    long (ASIO_THISCALL *future)(om_iasio_t *self, long selector, void *opt);
    long (ASIO_THISCALL *outputReady)(om_iasio_t *self);
} om_iasio_vtbl_t;

struct om_iasio {
    const om_iasio_vtbl_t *lpVtbl;
};

#define ASIO_FIFO_FRAMES 32768U

typedef struct {
    uint32_t           magic;
    om_iasio_t        *drv;
    asio_buffer_info_t buf_infos[OM_MAX_CHANNELS];
    long               buf_frames;
    long               sample_type;
    uint16_t           channels;
    bool               is_dsd_native;
    bool               post_output;
    bool               started;
    bool               buffers_created;

    /* Lock-protected low-latency ring buffer bridging engine output thread -> ASIO DMA callback */
    om_mutex_t         fifo_lock;
    int32_t           *fifo_i32;
    double            *fifo_f64;
    size_t             fifo_r;
    size_t             fifo_w;
    size_t             fifo_count;
    uint8_t            bit_rev[256];
} asio_priv_t;

#define OM_ASIO_PRIV_MAGIC 0x4153494FU /* 'ASIO' */

static asio_priv_t * volatile g_active_asio = NULL;

static void asio_init_bit_rev(uint8_t rev[256]) {
    for (int b = 0; b < 256; b++) {
        uint8_t r = 0;
        for (int k = 0; k < 8; k++) {
            if (b & (1 << k)) r |= (uint8_t)(1 << (7 - k));
        }
        rev[b] = r;
    }
}

static void ASIO_CALL asio_cb_buffer_switch(long db_idx, long direct_process) {
    (void)direct_process;
    asio_priv_t *ap = g_active_asio;
    if (!ap || !ap->started || db_idx < 0 || db_idx > 1) return;

    const size_t need = (size_t)ap->buf_frames;
    const uint16_t chs = ap->channels;

    om_mutex_lock(&ap->fifo_lock);
    size_t avail = ap->fifo_count;
    size_t take = (avail < need) ? avail : need;

    for (uint16_t c = 0; c < chs; c++) {
        void *dst_raw = ap->buf_infos[c].buffers[db_idx];
        if (!dst_raw) continue;

        if (ap->is_dsd_native) {
            /* Each FIFO frame carries 4 MSB-ordered DSD bytes (32 1-bit DSD samples) per channel */
            uint8_t *dst8 = (uint8_t *)dst_raw;
            size_t dsd_bytes_per_cb = need; /* In ASIO DSD mode, bufferSize is measured in DSD bytes (frames of 8 bits)! */
            size_t words_needed = dsd_bytes_per_cb / 4U;
            size_t words_take = (avail < words_needed) ? avail : words_needed;
            bool need_lsb = (ap->sample_type == ASIOSTDSDInt8LSB1);

            for (size_t w = 0; w < words_take; w++) {
                size_t rpos = (ap->fifo_r + w) % ASIO_FIFO_FRAMES;
                uint32_t u = (uint32_t)ap->fifo_i32[rpos * chs + c];
                uint8_t b0 = (uint8_t)((u >> 24) & 0xFFU);
                uint8_t b1 = (uint8_t)((u >> 16) & 0xFFU);
                uint8_t b2 = (uint8_t)((u >>  8) & 0xFFU);
                uint8_t b3 = (uint8_t)( u        & 0xFFU);
                if (need_lsb) {
                    b0 = ap->bit_rev[b0]; b1 = ap->bit_rev[b1];
                    b2 = ap->bit_rev[b2]; b3 = ap->bit_rev[b3];
                }
                dst8[w * 4U + 0] = b0;
                dst8[w * 4U + 1] = b1;
                dst8[w * 4U + 2] = b2;
                dst8[w * 4U + 3] = b3;
            }
            /* Pad underrun with 0x69 balanced DSD silence */
            if (words_take * 4U < dsd_bytes_per_cb) {
                memset(dst8 + words_take * 4U, 0x69, dsd_bytes_per_cb - words_take * 4U);
            }
            take = words_take;
        } else if (ap->sample_type == ASIOSTInt32LSB) {
            int32_t *dst32 = (int32_t *)dst_raw;
            for (size_t f = 0; f < take; f++) {
                size_t rpos = (ap->fifo_r + f) % ASIO_FIFO_FRAMES;
                dst32[f] = ap->fifo_i32[rpos * chs + c];
            }
            if (take < need) memset(dst32 + take, 0, (need - take) * sizeof(int32_t));
        } else if (ap->sample_type == ASIOSTInt24LSB) {
            uint8_t *dst24 = (uint8_t *)dst_raw;
            for (size_t f = 0; f < take; f++) {
                size_t rpos = (ap->fifo_r + f) % ASIO_FIFO_FRAMES;
                uint32_t u = (uint32_t)(ap->fifo_i32[rpos * chs + c] >> 8);
                dst24[f * 3U + 0] = (uint8_t)(u & 0xFFU);
                dst24[f * 3U + 1] = (uint8_t)((u >> 8) & 0xFFU);
                dst24[f * 3U + 2] = (uint8_t)((u >> 16) & 0xFFU);
            }
            if (take < need) memset(dst24 + take * 3U, 0, (need - take) * 3U);
        } else if (ap->sample_type == ASIOSTInt16LSB) {
            int16_t *dst16 = (int16_t *)dst_raw;
            for (size_t f = 0; f < take; f++) {
                size_t rpos = (ap->fifo_r + f) % ASIO_FIFO_FRAMES;
                dst16[f] = (int16_t)(ap->fifo_i32[rpos * chs + c] >> 16);
            }
            if (take < need) memset(dst16 + take, 0, (need - take) * sizeof(int16_t));
        } else if (ap->sample_type == ASIOSTFloat32LSB) {
            float *dstf = (float *)dst_raw;
            for (size_t f = 0; f < take; f++) {
                size_t rpos = (ap->fifo_r + f) % ASIO_FIFO_FRAMES;
                dstf[f] = (float)ap->fifo_f64[rpos * chs + c];
            }
            if (take < need) memset(dstf + take, 0, (need - take) * sizeof(float));
        } else if (ap->sample_type == ASIOSTFloat64LSB) {
            double *dstd = (double *)dst_raw;
            for (size_t f = 0; f < take; f++) {
                size_t rpos = (ap->fifo_r + f) % ASIO_FIFO_FRAMES;
                dstd[f] = ap->fifo_f64[rpos * chs + c];
            }
            if (take < need) memset(dstd + take, 0, (need - take) * sizeof(double));
        }
    }

    ap->fifo_r = (ap->fifo_r + take) % ASIO_FIFO_FRAMES;
    ap->fifo_count -= take;
    om_mutex_unlock(&ap->fifo_lock);

    if (ap->post_output && ap->drv && ap->drv->lpVtbl->outputReady) {
        ap->drv->lpVtbl->outputReady(ap->drv);
    }
}

static void *ASIO_CALL asio_cb_buffer_switch_time_info(void *params, long db_idx, long direct_process) {
    asio_cb_buffer_switch(db_idx, direct_process);
    return params;
}

static void ASIO_CALL asio_cb_sample_rate_changed(double sRate) {
    (void)sRate;
}

static long ASIO_CALL asio_cb_message(long selector, long value, void *message, double *opt) {
    (void)message;
    (void)opt;
    switch (selector) {
        case kAsioSelectorSupported:
            if (value == kAsioEngineVersion ||
                value == kAsioResetRequest ||
                value == kAsioResyncRequest ||
                value == kAsioLatenciesChanged ||
                value == kAsioSupportsTimeInfo) {
                return 1L;
            }
            return 0L;
        case kAsioEngineVersion:
            return 2L;
        case kAsioResetRequest:
        case kAsioResyncRequest:
        case kAsioLatenciesChanged:
            return 1L;
        case kAsioSupportsTimeInfo:
            return 1L;
        default:
            return 0L;
    }
}

static asio_callbacks_t g_asio_callbacks = {
    asio_cb_buffer_switch,
    asio_cb_sample_rate_changed,
    asio_cb_message,
    asio_cb_buffer_switch_time_info
};

bool om_asio_is_device_id(const char *device_id) {
    return device_id && strncmp(device_id, "asio:", 5) == 0;
}

bool om_asio_is_handle(const om_hal_handle_t *h) {
    if (!h || !h->priv) return false;
    return strncmp(h->device_id, "asio:", 5) == 0;
}

size_t om_asio_enumerate_devices(om_hal_device_info_t *out_list, size_t start_idx, size_t max_items) {
    if (!out_list || start_idx >= max_items) return start_idx;
    size_t count = start_idx;

    HKEY hAsio = NULL;
    if (RegOpenKeyExA(HKEY_LOCAL_MACHINE, "SOFTWARE\\ASIO", 0, KEY_READ, &hAsio) != ERROR_SUCCESS || !hAsio) {
        return count;
    }

    for (DWORD idx = 0; count + 1 < max_items; idx++) {
        char subkey_name[120] = {0};
        DWORD name_len = (DWORD)(sizeof(subkey_name) - 1);
        if (RegEnumKeyExA(hAsio, idx, subkey_name, &name_len, NULL, NULL, NULL, NULL) != ERROR_SUCCESS) {
            break;
        }

        HKEY hDrv = NULL;
        char clsid_str[128] = {0};
        char desc_str[200] = {0};
        if (RegOpenKeyExA(hAsio, subkey_name, 0, KEY_READ, &hDrv) == ERROR_SUCCESS && hDrv) {
            DWORD typ = 0, cb = (DWORD)(sizeof(clsid_str) - 1);
            RegQueryValueExA(hDrv, "CLSID", NULL, &typ, (BYTE *)clsid_str, &cb);
            cb = (DWORD)(sizeof(desc_str) - 1);
            RegQueryValueExA(hDrv, "Description", NULL, &typ, (BYTE *)desc_str, &cb);
            RegCloseKey(hDrv);
        }

        if (clsid_str[0] != '\0') {
            snprintf(out_list[count].id, sizeof(out_list[count].id), "asio:%s", subkey_name);
            snprintf(out_list[count].name, sizeof(out_list[count].name), "ASIO: %s",
                     desc_str[0] ? desc_str : subkey_name);
            out_list[count].is_exclusive_capable = true;
            out_list[count].is_default = false;
            count++;
        }
    }

    RegCloseKey(hAsio);
    return count;
}

static bool lookup_asio_clsid(const char *driver_key, CLSID *out_clsid) {
    char reg_path[256];
    snprintf(reg_path, sizeof(reg_path), "SOFTWARE\\ASIO\\%s", driver_key);
    HKEY hDrv = NULL;
    if (RegOpenKeyExA(HKEY_LOCAL_MACHINE, reg_path, 0, KEY_READ, &hDrv) != ERROR_SUCCESS || !hDrv) {
        return false;
    }
    char clsid_utf8[128] = {0};
    DWORD typ = 0, cb = (DWORD)(sizeof(clsid_utf8) - 1);
    LSTATUS st = RegQueryValueExA(hDrv, "CLSID", NULL, &typ, (BYTE *)clsid_utf8, &cb);
    RegCloseKey(hDrv);
    if (st != ERROR_SUCCESS || clsid_utf8[0] == '\0') return false;

    WCHAR wclsid[128] = {0};
    MultiByteToWideChar(CP_UTF8, 0, clsid_utf8, -1, wclsid, 128);
    return SUCCEEDED(CLSIDFromString(wclsid, out_clsid));
}

int om_asio_open(const char *device_id, const om_hal_request_t *req, om_hal_handle_t *out, char *err, size_t err_cap) {
    if (!om_asio_is_device_id(device_id) || !req || !out) {
        snprintf(err, err_cap, "Invalid ASIO device identifier");
        return -1;
    }
    if (g_active_asio != NULL) {
        om_hal_handle_t dummy = {0};
        dummy.priv = g_active_asio;
        snprintf(dummy.device_id, sizeof(dummy.device_id), "asio:prev");
        om_asio_close(&dummy);
    }

    const char *drv_key = device_id + 5;
    CLSID clsid;
    if (!lookup_asio_clsid(drv_key, &clsid)) {
        snprintf(err, err_cap, "ASIO driver '%s' not found in HKLM\\SOFTWARE\\ASIO", drv_key);
        return -1;
    }

    /* ASIO COM drivers are STA in-proc servers where IID == CLSID */
    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    om_iasio_t *drv = NULL;
    HRESULT hr = CoCreateInstance(&clsid, NULL, CLSCTX_INPROC_SERVER, &clsid, (void **)&drv);
    if (FAILED(hr) || !drv || !drv->lpVtbl) {
        snprintf(err, err_cap, "ASIO CoCreateInstance('%s') failed (0x%08lx)", drv_key, (unsigned long)hr);
        return -1;
    }

    HWND sys_hwnd = GetDesktopWindow();
    if (drv->lpVtbl->init(drv, (void *)sys_hwnd) != ASIO_TRUE) {
        char drv_err[128] = {0};
        drv->lpVtbl->getErrorMessage(drv, drv_err);
        drv->lpVtbl->Release(drv);
        snprintf(err, err_cap, "ASIO driver init failed: %s", drv_err[0] ? drv_err : "hardware not present");
        return -1;
    }

    long in_chs = 0, out_chs = 0;
    if (drv->lpVtbl->getChannels(drv, &in_chs, &out_chs) != ASE_OK || out_chs <= 0) {
        drv->lpVtbl->Release(drv);
        snprintf(err, err_cap, "ASIO driver reported 0 output channels");
        return -1;
    }

    uint16_t use_chs = req->channels;
    if (use_chs > (uint16_t)out_chs) use_chs = (uint16_t)out_chs;
    if (use_chs > OM_MAX_CHANNELS) use_chs = OM_MAX_CHANNELS;

    /* Negotiate Native DSD Direct IoFormat if requested */
    bool dsd_native_ok = false;
    if (req->is_dsd_native && req->dsd_bit_rate >= 2822400U) {
        asio_io_format_t dsd_fmt;
        memset(&dsd_fmt, 0, sizeof(dsd_fmt));
        dsd_fmt.formatType = kASIODSDFormat;
        if (drv->lpVtbl->future(drv, kAsioSetIoFormat, &dsd_fmt) == ASE_SUCCESS) {
            double target_dsd_hz = (double)req->dsd_bit_rate;
            if (drv->lpVtbl->canSampleRate(drv, target_dsd_hz) == ASE_OK &&
                drv->lpVtbl->setSampleRate(drv, target_dsd_hz) == ASE_OK) {
                dsd_native_ok = true;
            }
        }
        if (!dsd_native_ok) {
            asio_io_format_t pcm_fmt;
            memset(&pcm_fmt, 0, sizeof(pcm_fmt));
            pcm_fmt.formatType = kASIOPCMFormat;
            drv->lpVtbl->future(drv, kAsioSetIoFormat, &pcm_fmt);
        }
    }

    uint32_t actual_rate = req->sample_rate;
    if (!dsd_native_ok) {
        double req_hz = (double)req->sample_rate;
        if (drv->lpVtbl->canSampleRate(drv, req_hz) == ASE_OK &&
            drv->lpVtbl->setSampleRate(drv, req_hz) == ASE_OK) {
            actual_rate = req->sample_rate;
        } else {
            /* Query driver's current locked clock or probe standard Hi-Res rates so OurMusic's Kaiser-Sinc SRC bridges cleanly */
            static const uint32_t fallback_rates[6] = { 192000, 176400, 96000, 88200, 48000, 44100 };
            bool rate_set = false;
            for (int i = 0; i < 6; i++) {
                double try_hz = (double)fallback_rates[i];
                if (drv->lpVtbl->canSampleRate(drv, try_hz) == ASE_OK &&
                    drv->lpVtbl->setSampleRate(drv, try_hz) == ASE_OK) {
                    actual_rate = fallback_rates[i];
                    rate_set = true;
                    break;
                }
            }
            if (!rate_set) {
                double cur_hz = 0.0;
                if (drv->lpVtbl->getSampleRate(drv, &cur_hz) == ASE_OK && cur_hz >= 8000.0) {
                    actual_rate = (uint32_t)(cur_hz + 0.5);
                } else {
                    drv->lpVtbl->Release(drv);
                    snprintf(err, err_cap, "ASIO driver rejected sample rate %u Hz", req->sample_rate);
                    return -1;
                }
            }
        }
    }

    long min_sz = 0, max_sz = 0, pref_sz = 0, gran = 0;
    if (drv->lpVtbl->getBufferSize(drv, &min_sz, &max_sz, &pref_sz, &gran) != ASE_OK || pref_sz <= 0) {
        pref_sz = 1024;
    }

    asio_priv_t *ap = (asio_priv_t *)calloc(1, sizeof(*ap));
    ap->magic = OM_ASIO_PRIV_MAGIC;
    ap->drv = drv;
    ap->buf_frames = pref_sz;
    ap->channels = use_chs;
    ap->is_dsd_native = dsd_native_ok;
    om_mutex_init(&ap->fifo_lock);
    asio_init_bit_rev(ap->bit_rev);

    ap->fifo_i32 = (int32_t *)calloc((size_t)ASIO_FIFO_FRAMES * use_chs, sizeof(int32_t));
    ap->fifo_f64 = (double *)calloc((size_t)ASIO_FIFO_FRAMES * use_chs, sizeof(double));

    for (uint16_t c = 0; c < use_chs; c++) {
        ap->buf_infos[c].isInput = ASIO_FALSE;
        ap->buf_infos[c].channelNum = (long)c;
        ap->buf_infos[c].buffers[0] = NULL;
        ap->buf_infos[c].buffers[1] = NULL;
    }

    asio_channel_info_t ch_info;
    memset(&ch_info, 0, sizeof(ch_info));
    ch_info.channel = 0;
    ch_info.isInput = ASIO_FALSE;
    if (drv->lpVtbl->getChannelInfo(drv, &ch_info) == ASE_OK) {
        ap->sample_type = ch_info.type;
    } else {
        ap->sample_type = ASIOSTInt32LSB;
    }

    if (drv->lpVtbl->createBuffers(drv, ap->buf_infos, (long)use_chs, pref_sz, &g_asio_callbacks) != ASE_OK) {
        om_mutex_destroy(&ap->fifo_lock);
        free(ap->fifo_i32); free(ap->fifo_f64); free(ap);
        drv->lpVtbl->Release(drv);
        snprintf(err, err_cap, "ASIO createBuffers(%ld frames) failed", pref_sz);
        return -1;
    }
    ap->buffers_created = true;
    ap->post_output = (drv->lpVtbl->outputReady(drv) == ASE_OK);
    g_active_asio = ap;

    uint16_t bits = 32;
    bool is_flt = false;
    if (ap->sample_type == ASIOSTInt16LSB) bits = 16;
    else if (ap->sample_type == ASIOSTInt24LSB) bits = 24;
    else if (ap->sample_type == ASIOSTFloat32LSB) { bits = 32; is_flt = true; }
    else if (ap->sample_type == ASIOSTFloat64LSB) { bits = 32; is_flt = true; }

    snprintf(out->backend_name, sizeof(out->backend_name), "%s",
             dsd_native_ok ? "ASIO Native DSD Direct" : "ASIO Direct (Bit-Perfect)");
    snprintf(out->device_id, sizeof(out->device_id), "%s", device_id);
    out->actual_rate = actual_rate;
    out->actual_channels = use_chs;
    out->actual_bit_depth = bits;
    out->actual_is_float = is_flt;
    out->actual_is_dsd_native = dsd_native_ok;
    out->bit_perfect_active = dsd_native_ok || (actual_rate == req->sample_rate && !is_flt && bits >= req->bit_depth);
    out->priv = ap;
    return 0;
}

static inline int32_t align_int32_msb(int32_t v, uint16_t src_bits) {
    if (src_bits >= 32) return v;
    return (int32_t)((uint32_t)v << (32U - src_bits));
}

int om_asio_write(om_hal_handle_t *h, const int32_t *pcm_i32, const double *pcm_f64, uint16_t src_bit_depth, size_t frames) {
    if (!h || !h->priv || frames == 0) return 0;
    asio_priv_t *ap = (asio_priv_t *)h->priv;
    const uint16_t chs = ap->channels;
    size_t written = 0;

    while (written < frames) {
        om_mutex_lock(&ap->fifo_lock);
        size_t space = ASIO_FIFO_FRAMES - ap->fifo_count;
        if (space == 0) {
            om_mutex_unlock(&ap->fifo_lock);
            if (!ap->started) {
                ap->started = true;
                ap->drv->lpVtbl->start(ap->drv);
            }
            om_sleep_ms(2);
            continue;
        }

        size_t chunk = frames - written;
        if (chunk > space) chunk = space;

        for (size_t f = 0; f < chunk; f++) {
            size_t wpos = (ap->fifo_w + f) % ASIO_FIFO_FRAMES;
            size_t src_base = (written + f) * chs;
            size_t dst_base = wpos * chs;

            if (ap->is_dsd_native) {
                for (uint16_t c = 0; c < chs; c++) {
                    ap->fifo_i32[dst_base + c] = pcm_i32 ? pcm_i32[src_base + c] : (int32_t)0x69696969;
                }
            } else if (ap->sample_type == ASIOSTFloat32LSB || ap->sample_type == ASIOSTFloat64LSB) {
                for (uint16_t c = 0; c < chs; c++) {
                    double dv = pcm_f64 ? pcm_f64[src_base + c]
                                        : om_i32_to_f64(pcm_i32 ? pcm_i32[src_base + c] : 0, src_bit_depth);
                    if (dv > 1.0) dv = 1.0;
                    if (dv < -1.0) dv = -1.0;
                    ap->fifo_f64[dst_base + c] = dv;
                }
            } else {
                for (uint16_t c = 0; c < chs; c++) {
                    int32_t v32 = pcm_i32 ? align_int32_msb(pcm_i32[src_base + c], src_bit_depth)
                                          : om_f64_to_i32(pcm_f64 ? pcm_f64[src_base + c] : 0.0, 32);
                    ap->fifo_i32[dst_base + c] = v32;
                }
            }
        }

        ap->fifo_w = (ap->fifo_w + chunk) % ASIO_FIFO_FRAMES;
        ap->fifo_count += chunk;
        size_t cur_fill = ap->fifo_count;
        om_mutex_unlock(&ap->fifo_lock);

        if (!ap->started && cur_fill >= (size_t)ap->buf_frames * 2U) {
            ap->started = true;
            ap->drv->lpVtbl->start(ap->drv);
        }
        written += chunk;
    }

    if (!ap->started) {
        ap->started = true;
        ap->drv->lpVtbl->start(ap->drv);
    }
    return (int)written;
}

void om_asio_drain(om_hal_handle_t *h) {
    if (!h || !h->priv) return;
    asio_priv_t *ap = (asio_priv_t *)h->priv;
    if (!ap->started) return;
    for (int i = 0; i < 150; i++) {
        om_mutex_lock(&ap->fifo_lock);
        size_t rem = ap->fifo_count;
        om_mutex_unlock(&ap->fifo_lock);
        if (rem == 0) break;
        om_sleep_ms(4);
    }
    if (ap->drv) ap->drv->lpVtbl->stop(ap->drv);
    ap->started = false;
}

void om_asio_drop(om_hal_handle_t *h) {
    if (!h || !h->priv) return;
    asio_priv_t *ap = (asio_priv_t *)h->priv;
    if (ap->started && ap->drv) {
        ap->drv->lpVtbl->stop(ap->drv);
        ap->started = false;
    }
    om_mutex_lock(&ap->fifo_lock);
    ap->fifo_r = 0;
    ap->fifo_w = 0;
    ap->fifo_count = 0;
    om_mutex_unlock(&ap->fifo_lock);
}

void om_asio_close(om_hal_handle_t *h) {
    if (!h || !h->priv) return;
    asio_priv_t *ap = (asio_priv_t *)h->priv;
    if (g_active_asio == ap) g_active_asio = NULL;
    if (ap->drv) {
        if (ap->started) ap->drv->lpVtbl->stop(ap->drv);
        if (ap->buffers_created) ap->drv->lpVtbl->disposeBuffers(ap->drv);
        ap->drv->lpVtbl->Release(ap->drv);
    }
    om_mutex_destroy(&ap->fifo_lock);
    free(ap->fifo_i32);
    free(ap->fifo_f64);
    free(ap);
    h->priv = NULL;
}

#endif /* _WIN32 || OM_WASAPI_SYNTAX_CHECK */
