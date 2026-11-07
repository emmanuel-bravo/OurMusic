#if defined(_WIN32) || defined(OM_WASAPI_SYNTAX_CHECK)

#ifndef COBJMACROS
#define COBJMACROS
#endif
#ifndef INITGUID
#define INITGUID
#endif

#include "hal.h"
#include "hal_asio.h"
#include "os_compat.h"

#ifdef OM_WASAPI_SYNTAX_CHECK
#include "../tests/wasapi_mock_headers.h"
#else
#include <windows.h>
#include <mmreg.h>
#include <ks.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    IMMDevice          *device;
    IAudioClient       *client;
    IAudioRenderClient *render;
    HANDLE              mmcss_handle;
    UINT32              buffer_frames;
    uint16_t            container_bits;
    bool                is_float;
    bool                started;
} wasapi_priv_t;

static void wide_to_utf8(const WCHAR *wstr, char *out, size_t cap) {
    if (!wstr || cap == 0) {
        if (cap) out[0] = '\0';
        return;
    }
    int n = WideCharToMultiByte(CP_UTF8, 0, wstr, -1, out, (int)cap, NULL, NULL);
    if (n <= 0) out[0] = '\0';
}

static void utf8_to_wide(const char *str, WCHAR *wout, size_t wcap) {
    if (!str || wcap == 0) {
        if (wcap) wout[0] = 0;
        return;
    }
    MultiByteToWideChar(CP_UTF8, 0, str, -1, wout, (int)wcap);
}

static void build_wfext(WAVEFORMATEXTENSIBLE *wfx, uint32_t rate, uint16_t ch, uint16_t valid_bits, uint16_t container_bits, bool is_float) {
    memset(wfx, 0, sizeof(*wfx));
    wfx->Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    wfx->Format.nChannels = ch;
    wfx->Format.nSamplesPerSec = rate;
    wfx->Format.wBitsPerSample = container_bits;
    wfx->Format.nBlockAlign = (WORD)(ch * (container_bits / 8U));
    wfx->Format.nAvgBytesPerSec = rate * wfx->Format.nBlockAlign;
    wfx->Format.cbSize = 22;
    wfx->Samples.wValidBitsPerSample = valid_bits;
    wfx->dwChannelMask = (ch == 1) ? SPEAKER_FRONT_CENTER : (SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT);
    wfx->SubFormat = is_float ? KSDATAFORMAT_SUBTYPE_IEEE_FLOAT : KSDATAFORMAT_SUBTYPE_PCM;
}

size_t om_hal_enumerate_devices(om_hal_device_info_t *out_list, size_t max_items) {
    if (!out_list || max_items == 0) return 0;
    size_t count = 0;

    CoInitializeEx(NULL, COINIT_MULTITHREADED);

    snprintf(out_list[count].id, sizeof(out_list[count].id), "default");
    snprintf(out_list[count].name, sizeof(out_list[count].name), "Windows WASAPI Default Output");
    out_list[count].is_exclusive_capable = true;
    out_list[count].is_default = true;
    count++;

    IMMDeviceEnumerator *enumerator = NULL;
    HRESULT hr = CoCreateInstance(
        &CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL,
        &IID_IMMDeviceEnumerator, (void **)&enumerator
    );
    if (SUCCEEDED(hr) && enumerator) {
        IMMDeviceCollection *col = NULL;
        if (SUCCEEDED(IMMDeviceEnumerator_EnumAudioEndpoints(enumerator, eRender, DEVICE_STATE_ACTIVE, &col)) && col) {
            UINT n = 0;
            IMMDeviceCollection_GetCount(col, &n);
            for (UINT i = 0; i < n && count + 1 < max_items; i++) {
                IMMDevice *dev = NULL;
                if (SUCCEEDED(IMMDeviceCollection_Item(col, i, &dev)) && dev) {
                    LPWSTR wid = NULL;
                    if (SUCCEEDED(IMMDevice_GetId(dev, &wid)) && wid) {
                        wide_to_utf8(wid, out_list[count].id, sizeof(out_list[count].id));
                        CoTaskMemFree(wid);
                    }
                    IPropertyStore *props = NULL;
                    if (SUCCEEDED(IMMDevice_OpenPropertyStore(dev, STGM_READ, &props)) && props) {
                        PROPVARIANT pv;
                        PropVariantInit(&pv);
                        if (SUCCEEDED(IPropertyStore_GetValue(props, &PKEY_Device_FriendlyName, &pv)) && pv.vt == VT_LPWSTR) {
                            wide_to_utf8(pv.pwszVal, out_list[count].name, sizeof(out_list[count].name));
                        }
                        PropVariantClear(&pv);
                        IPropertyStore_Release(props);
                    }
                    if (out_list[count].name[0] == '\0') {
                        snprintf(out_list[count].name, sizeof(out_list[count].name), "WASAPI Endpoint #%u", i);
                    }
                    out_list[count].is_exclusive_capable = true;
                    out_list[count].is_default = false;
                    count++;
                    IMMDevice_Release(dev);
                }
            }
            IMMDeviceCollection_Release(col);
        }
        IMMDeviceEnumerator_Release(enumerator);
    }

    /* Enumerate installed native ASIO drivers from HKLM\SOFTWARE\ASIO */
    count = om_asio_enumerate_devices(out_list, count, max_items > 1 ? max_items - 1 : max_items);

    if (count < max_items) {
        snprintf(out_list[count].id, sizeof(out_list[count].id), "null");
        snprintf(out_list[count].name, sizeof(out_list[count].name), "Null Timed Sink (Headless / Test)");
        out_list[count].is_exclusive_capable = true;
        out_list[count].is_default = false;
        count++;
    }
    return count;
}

int om_hal_open(const char *device_id, const om_hal_request_t *req, om_hal_handle_t *out, char *err, size_t err_cap) {
    memset(out, 0, sizeof(*out));
    const char *dev_id = (device_id && device_id[0]) ? device_id : "default";

    if (strcmp(dev_id, "null") == 0) {
        return om_wavsink_open(NULL, true, req, out, err, err_cap);
    }
    if (strncmp(dev_id, "wav:", 4) == 0) {
        return om_wavsink_open(dev_id + 4, false, req, out, err, err_cap);
    }
    if (strncmp(dev_id, "wavrt:", 6) == 0) {
        return om_wavsink_open(dev_id + 6, true, req, out, err, err_cap);
    }
    if (om_asio_is_device_id(dev_id)) {
        return om_asio_open(dev_id, req, out, err, err_cap);
    }

    CoInitializeEx(NULL, COINIT_MULTITHREADED);

    IMMDeviceEnumerator *enumerator = NULL;
    HRESULT hr = CoCreateInstance(
        &CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL,
        &IID_IMMDeviceEnumerator, (void **)&enumerator
    );
    if (FAILED(hr) || !enumerator) {
        snprintf(err, err_cap, "WASAPI CoCreateInstance(MMDeviceEnumerator) failed (0x%08lx)", (unsigned long)hr);
        return -1;
    }

    IMMDevice *device = NULL;
    if (strcmp(dev_id, "default") == 0) {
        hr = IMMDeviceEnumerator_GetDefaultAudioEndpoint(enumerator, eRender, eConsole, &device);
    } else {
        WCHAR wid[256];
        utf8_to_wide(dev_id, wid, 256);
        hr = IMMDeviceEnumerator_GetDevice(enumerator, wid, &device);
    }
    IMMDeviceEnumerator_Release(enumerator);
    if (FAILED(hr) || !device) {
        snprintf(err, err_cap, "WASAPI failed to open audio endpoint '%s' (0x%08lx)", dev_id, (unsigned long)hr);
        return -1;
    }

    IAudioClient *client = NULL;
    hr = IMMDevice_Activate(device, &IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&client);
    if (FAILED(hr) || !client) {
        IMMDevice_Release(device);
        snprintf(err, err_cap, "WASAPI IMMDevice::Activate(IAudioClient) failed (0x%08lx)", (unsigned long)hr);
        return -1;
    }

    bool exclusive_ok = false;
    uint16_t chosen_valid = req->bit_depth;
    uint16_t chosen_container = (req->bit_depth == 24) ? 24 : req->bit_depth;
    bool chosen_float = false;
    uint32_t chosen_rate = req->sample_rate;
    uint16_t chosen_ch = req->channels;

    /* 1. Try Bit-Perfect WASAPI Exclusive mode bypassing Windows Audio Engine / resampler */
    if (req->prefer_bitperfect) {
        static const struct { uint16_t valid; uint16_t cont; } tries[4] = {
            { 24, 24 }, { 24, 32 }, { 32, 32 }, { 16, 16 }
        };
        for (int t = 0; t < 4; t++) {
            uint16_t vbits = (t == 0 && req->bit_depth == 16) ? 16 : tries[t].valid;
            uint16_t cbits = (t == 0 && req->bit_depth == 16) ? 16 : tries[t].cont;
            WAVEFORMATEXTENSIBLE wfx;
            build_wfext(&wfx, req->sample_rate, req->channels, vbits, cbits, false);
            if (IAudioClient_IsFormatSupported(client, AUDCLNT_SHAREMODE_EXCLUSIVE, &wfx.Format, NULL) == S_OK) {
                REFERENCE_TIME hns_dur = 500000; /* 50 ms exclusive buffer */
                hr = IAudioClient_Initialize(
                    client, AUDCLNT_SHAREMODE_EXCLUSIVE, 0,
                    hns_dur, hns_dur, &wfx.Format, NULL
                );
                if (SUCCEEDED(hr)) {
                    exclusive_ok = true;
                    chosen_valid = vbits;
                    chosen_container = cbits;
                    chosen_float = false;
                    break;
                }
            }
        }
    }

    /* 2. Graceful fallback to WASAPI Shared mode if driver denies Exclusive lock */
    if (!exclusive_ok) {
        WAVEFORMATEX *mix_fmt = NULL;
        hr = IAudioClient_GetMixFormat(client, &mix_fmt);
        if (FAILED(hr) || !mix_fmt) {
            IAudioClient_Release(client);
            IMMDevice_Release(device);
            snprintf(err, err_cap, "WASAPI GetMixFormat failed (0x%08lx)", (unsigned long)hr);
            return -1;
        }
        REFERENCE_TIME hns_dur = 1000000; /* 100 ms shared buffer */
        hr = IAudioClient_Initialize(
            client, AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            hns_dur, 0, mix_fmt, NULL
        );
        chosen_rate = req->sample_rate;
        chosen_ch = req->channels;
        chosen_container = 32;
        chosen_valid = 32;
        chosen_float = true;

        WAVEFORMATEXTENSIBLE req_float;
        build_wfext(&req_float, req->sample_rate, req->channels, 32, 32, true);
        if (FAILED(hr)) {
            /* Re-create client and try native float at requested rate with AUTOCONVERTPCM */
            IAudioClient_Release(client);
            IMMDevice_Activate(device, &IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&client);
            hr = IAudioClient_Initialize(
                client, AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                hns_dur, 0, &req_float.Format, NULL
            );
        } else {
            chosen_rate = mix_fmt->nSamplesPerSec;
            chosen_ch = mix_fmt->nChannels;
            chosen_container = mix_fmt->wBitsPerSample;
            chosen_valid = mix_fmt->wBitsPerSample;
            chosen_float = (mix_fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT ||
                           (mix_fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
                            memcmp(&((WAVEFORMATEXTENSIBLE *)mix_fmt)->SubFormat, &KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, sizeof(GUID)) == 0));
        }
        CoTaskMemFree(mix_fmt);

        if (FAILED(hr)) {
            IAudioClient_Release(client);
            IMMDevice_Release(device);
            snprintf(err, err_cap, "WASAPI Initialize failed (0x%08lx)", (unsigned long)hr);
            return -1;
        }
    }

    UINT32 buf_frames = 0;
    IAudioClient_GetBufferSize(client, &buf_frames);

    IAudioRenderClient *render = NULL;
    hr = IAudioClient_GetService(client, &IID_IAudioRenderClient, (void **)&render);
    if (FAILED(hr) || !render) {
        IAudioClient_Release(client);
        IMMDevice_Release(device);
        snprintf(err, err_cap, "WASAPI GetService(IAudioRenderClient) failed (0x%08lx)", (unsigned long)hr);
        return -1;
    }

    DWORD task_idx = 0;
    HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_idx);

    wasapi_priv_t *wp = (wasapi_priv_t *)calloc(1, sizeof(*wp));
    wp->device = device;
    wp->client = client;
    wp->render = render;
    wp->mmcss_handle = mmcss;
    wp->buffer_frames = buf_frames;
    wp->container_bits = chosen_container;
    wp->is_float = chosen_float;
    wp->started = false;

    snprintf(out->backend_name, sizeof(out->backend_name), "%s",
             exclusive_ok ? "WASAPI Exclusive (Bit-Perfect)" : "WASAPI Shared");
    snprintf(out->device_id, sizeof(out->device_id), "%s", dev_id);
    out->actual_rate = chosen_rate;
    out->actual_channels = chosen_ch;
    out->actual_bit_depth = chosen_valid;
    out->actual_is_float = chosen_float;
    out->bit_perfect_active = exclusive_ok && (chosen_rate == req->sample_rate);
    out->priv = wp;
    return 0;
}

int om_hal_write(om_hal_handle_t *h, const int32_t *pcm_i32, const double *pcm_f64, uint16_t src_bit_depth, size_t frames) {
    if (!h || !h->priv || frames == 0) return 0;
    if (om_asio_is_handle(h)) {
        return om_asio_write(h, pcm_i32, pcm_f64, src_bit_depth, frames);
    }
    if (strcmp(h->device_id, "null") == 0 ||
        strcmp(h->backend_name, "WAV Bit-Exact Sink") == 0 ||
        strcmp(h->backend_name, "Null Timed Sink") == 0) {
        return om_wavsink_write(h, pcm_i32, pcm_f64, src_bit_depth, frames);
    }

    wasapi_priv_t *wp = (wasapi_priv_t *)h->priv;
    size_t written = 0;

    while (written < frames) {
        UINT32 padding = 0;
        if (FAILED(IAudioClient_GetCurrentPadding(wp->client, &padding))) return -1;
        UINT32 avail = (wp->buffer_frames > padding) ? (wp->buffer_frames - padding) : 0;
        if (avail == 0) {
            om_sleep_ms(3);
            continue;
        }

        UINT32 chunk = (UINT32)(frames - written);
        if (chunk > avail) chunk = avail;

        BYTE *dst_bytes = NULL;
        if (FAILED(IAudioRenderClient_GetBuffer(wp->render, chunk, &dst_bytes)) || !dst_bytes) {
            return -1;
        }

        size_t nsamp = (size_t)chunk * h->actual_channels;
        size_t src_off = written * h->actual_channels;

        if (wp->is_float) {
            float *fdst = (float *)dst_bytes;
            for (size_t i = 0; i < nsamp; i++) {
                double dv = pcm_f64 ? pcm_f64[src_off + i]
                                    : om_i32_to_f64(pcm_i32 ? pcm_i32[src_off + i] : 0, src_bit_depth);
                if (dv > 1.0) dv = 1.0;
                if (dv < -1.0) dv = -1.0;
                fdst[i] = (float)dv;
            }
        } else if (wp->container_bits == 16) {
            int16_t *idst = (int16_t *)dst_bytes;
            for (size_t i = 0; i < nsamp; i++) {
                int32_t v = pcm_i32 ? pcm_i32[src_off + i]
                                    : om_f64_to_i32(pcm_f64 ? pcm_f64[src_off + i] : 0.0, 16);
                if (pcm_i32 && src_bit_depth > 16) v >>= (src_bit_depth - 16);
                idst[i] = (int16_t)v;
            }
        } else if (wp->container_bits == 24) {
            for (size_t i = 0; i < nsamp; i++) {
                int32_t v = pcm_i32 ? pcm_i32[src_off + i]
                                    : om_f64_to_i32(pcm_f64 ? pcm_f64[src_off + i] : 0.0, 24);
                if (pcm_i32 && src_bit_depth < 24) v <<= (24 - src_bit_depth);
                if (pcm_i32 && src_bit_depth > 24) v >>= (src_bit_depth - 24);
                uint32_t u = (uint32_t)v;
                dst_bytes[i * 3 + 0] = (BYTE)(u & 0xFFU);
                dst_bytes[i * 3 + 1] = (BYTE)((u >> 8) & 0xFFU);
                dst_bytes[i * 3 + 2] = (BYTE)((u >> 16) & 0xFFU);
            }
        } else {
            int32_t *idst = (int32_t *)dst_bytes;
            for (size_t i = 0; i < nsamp; i++) {
                int32_t v = pcm_i32 ? pcm_i32[src_off + i]
                                    : om_f64_to_i32(pcm_f64 ? pcm_f64[src_off + i] : 0.0, 32);
                if (pcm_i32 && src_bit_depth < 32) v = (int32_t)((uint32_t)v << (32 - src_bit_depth));
                idst[i] = v;
            }
        }

        IAudioRenderClient_ReleaseBuffer(wp->render, chunk, 0);
        if (!wp->started) {
            IAudioClient_Start(wp->client);
            wp->started = true;
        }
        written += chunk;
    }
    return (int)written;
}

void om_hal_drain(om_hal_handle_t *h) {
    if (!h || !h->priv) return;
    if (om_asio_is_handle(h)) {
        om_asio_drain(h);
        return;
    }
    if (strcmp(h->device_id, "null") == 0 ||
        strcmp(h->backend_name, "WAV Bit-Exact Sink") == 0 ||
        strcmp(h->backend_name, "Null Timed Sink") == 0) return;
    wasapi_priv_t *wp = (wasapi_priv_t *)h->priv;
    if (!wp->started) return;
    for (int i = 0; i < 100; i++) {
        UINT32 pad = 0;
        if (FAILED(IAudioClient_GetCurrentPadding(wp->client, &pad)) || pad == 0) break;
        om_sleep_ms(5);
    }
    IAudioClient_Stop(wp->client);
    wp->started = false;
}

void om_hal_drop(om_hal_handle_t *h) {
    if (!h || !h->priv) return;
    if (om_asio_is_handle(h)) {
        om_asio_drop(h);
        return;
    }
    if (strcmp(h->device_id, "null") == 0 ||
        strcmp(h->backend_name, "WAV Bit-Exact Sink") == 0 ||
        strcmp(h->backend_name, "Null Timed Sink") == 0) return;
    wasapi_priv_t *wp = (wasapi_priv_t *)h->priv;
    if (wp->client) {
        IAudioClient_Stop(wp->client);
        IAudioClient_Reset(wp->client);
        wp->started = false;
    }
}

void om_hal_close(om_hal_handle_t *h) {
    if (!h || !h->priv) return;
    if (om_asio_is_handle(h)) {
        om_asio_close(h);
        return;
    }
    if (strcmp(h->device_id, "null") == 0 ||
        strcmp(h->backend_name, "WAV Bit-Exact Sink") == 0 ||
        strcmp(h->backend_name, "Null Timed Sink") == 0) {
        om_wavsink_close(h);
        return;
    }
    wasapi_priv_t *wp = (wasapi_priv_t *)h->priv;
    if (wp->started && wp->client) IAudioClient_Stop(wp->client);
    if (wp->mmcss_handle) AvRevertMmThreadCharacteristics(wp->mmcss_handle);
    if (wp->render) IAudioRenderClient_Release(wp->render);
    if (wp->client) IAudioClient_Release(wp->client);
    if (wp->device) IMMDevice_Release(wp->device);
    free(wp);
    h->priv = NULL;
}

#endif /* _WIN32 || OM_WASAPI_SYNTAX_CHECK */
