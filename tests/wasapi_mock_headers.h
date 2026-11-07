#ifndef OM_WASAPI_MOCK_HEADERS_H
#define OM_WASAPI_MOCK_HEADERS_H

/*
 * Minimal clean-room C11 type and COM/Registry declarations mirroring documented
 * Microsoft Windows SDK WASAPI / MMDevice / MMCSS / Win32 Registry / COM signatures
 * so hal_wasapi.c and hal_asio.c undergo strict -fsyntax-only type verification on Linux.
 */

#include <stdint.h>
#include <stddef.h>
#include <wchar.h>

typedef long HRESULT;
typedef long LSTATUS;
typedef unsigned long DWORD;
typedef unsigned short WORD;
typedef unsigned char BYTE;
typedef unsigned int UINT;
typedef uint32_t UINT32;
typedef int64_t REFERENCE_TIME;
typedef wchar_t WCHAR;
typedef WCHAR *LPWSTR;
typedef const WCHAR *LPCWSTR;
typedef char *LPSTR;
typedef const char *LPCSTR;
typedef void *HANDLE;
typedef void *HWND;
typedef void *HKEY;

#define S_OK ((HRESULT)0L)
#define ERROR_SUCCESS 0L
#define SUCCEEDED(hr) (((HRESULT)(hr)) >= 0)
#define FAILED(hr) (((HRESULT)(hr)) < 0)

#define CP_UTF8 65001
#define COINIT_MULTITHREADED 0x0
#define COINIT_APARTMENTTHREADED 0x2
#define CLSCTX_INPROC_SERVER 0x1
#define CLSCTX_ALL 0x17
#define DEVICE_STATE_ACTIVE 0x00000001
#define STGM_READ 0x00000000L
#define VT_LPWSTR 31

#define HKEY_LOCAL_MACHINE ((HKEY)(uintptr_t)0x80000002ULL)
#define KEY_READ 0x20019U
#define REG_SZ 1U

#define WAVE_FORMAT_IEEE_FLOAT 0x0003
#define WAVE_FORMAT_EXTENSIBLE 0xFFFE
#define SPEAKER_FRONT_LEFT 0x1
#define SPEAKER_FRONT_RIGHT 0x2
#define SPEAKER_FRONT_CENTER 0x4

#define AUDCLNT_SHAREMODE_SHARED 0
#define AUDCLNT_SHAREMODE_EXCLUSIVE 1
#define AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM 0x80000000U
#define AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY 0x08000000U

typedef enum { eRender = 0, eCapture = 1 } EDataFlow;
typedef enum { eConsole = 0, eMultimedia = 1, eCommunications = 2 } ERole;

typedef struct {
    uint32_t Data1;
    uint16_t Data2;
    uint16_t Data3;
    uint8_t  Data4[8];
} GUID;

typedef GUID IID;
typedef GUID CLSID;

static const CLSID CLSID_MMDeviceEnumerator = {0xBCDE0395, 0xE52F, 0x467C, {0x8E,0x3D,0xC4,0x57,0x92,0x91,0x69,0x2E}};
static const IID IID_IMMDeviceEnumerator    = {0xA95664D2, 0x9614, 0x4F35, {0xA7,0x46,0xDE,0x8D,0xB6,0x36,0x17,0xE6}};
static const IID IID_IAudioClient           = {0x1CB9AD4C, 0xDBFA, 0x4C32, {0xB1,0x78,0xC2,0xF5,0x68,0xA7,0x03,0xB2}};
static const IID IID_IAudioRenderClient     = {0xF294ACFC, 0x3146, 0x4483, {0xA7,0xBF,0xAD,0xDC,0xA7,0xC2,0x60,0xE2}};
static const GUID KSDATAFORMAT_SUBTYPE_PCM        = {0x00000001, 0x0000, 0x0010, {0x80,0x00,0x00,0xAA,0x00,0x38,0x9B,0x71}};
static const GUID KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = {0x00000003, 0x0000, 0x0010, {0x80,0x00,0x00,0xAA,0x00,0x38,0x9B,0x71}};

typedef struct {
    GUID fmtid;
    DWORD pid;
} PROPERTYKEY;

static const PROPERTYKEY PKEY_Device_FriendlyName = {{0xa45c254e, 0xdf1c, 0x4efd, {0x80,0x20,0x67,0xd1,0x46,0xa8,0x50,0xe0}}, 14};

typedef struct {
    WORD vt;
    LPWSTR pwszVal;
} PROPVARIANT;

typedef struct {
    WORD  wFormatTag;
    WORD  nChannels;
    DWORD nSamplesPerSec;
    DWORD nAvgBytesPerSec;
    WORD  nBlockAlign;
    WORD  wBitsPerSample;
    WORD  cbSize;
} WAVEFORMATEX;

typedef struct {
    WAVEFORMATEX Format;
    union {
        WORD wValidBitsPerSample;
        WORD wSamplesPerBlock;
        WORD wReserved;
    } Samples;
    DWORD dwChannelMask;
    GUID  SubFormat;
} WAVEFORMATEXTENSIBLE;

typedef struct IPropertyStore IPropertyStore;
typedef struct IMMDevice IMMDevice;
typedef struct IMMDeviceCollection IMMDeviceCollection;
typedef struct IMMDeviceEnumerator IMMDeviceEnumerator;
typedef struct IAudioClient IAudioClient;
typedef struct IAudioRenderClient IAudioRenderClient;

struct IPropertyStore { void *lpVtbl; };
struct IMMDevice { void *lpVtbl; };
struct IMMDeviceCollection { void *lpVtbl; };
struct IMMDeviceEnumerator { void *lpVtbl; };
struct IAudioClient { void *lpVtbl; };
struct IAudioRenderClient { void *lpVtbl; };

int WideCharToMultiByte(UINT cp, DWORD flags, const WCHAR *wstr, int cchWide, char *mbstr, int cbMulti, const char *def, int *usedDef);
int MultiByteToWideChar(UINT cp, DWORD flags, const char *mbstr, int cbMulti, WCHAR *wstr, int cchWide);
HRESULT CoInitializeEx(void *pvReserved, DWORD dwCoInit);
HRESULT CoCreateInstance(const CLSID *rclsid, void *pUnkOuter, DWORD dwClsContext, const IID *riid, void **ppv);
HRESULT CLSIDFromString(LPCWSTR lpsz, CLSID *pclsid);
void CoTaskMemFree(void *pv);
void PropVariantInit(PROPVARIANT *pvar);
HRESULT PropVariantClear(PROPVARIANT *pvar);
HANDLE AvSetMmThreadCharacteristicsW(LPCWSTR TaskName, DWORD *TaskIndex);
int AvRevertMmThreadCharacteristics(HANDLE AvrtHandle);
HWND GetDesktopWindow(void);

LSTATUS RegOpenKeyExA(HKEY hKey, LPCSTR lpSubKey, DWORD ulOptions, DWORD samDesired, HKEY *phkResult);
LSTATUS RegEnumKeyExA(HKEY hKey, DWORD dwIndex, LPSTR lpName, DWORD *lpcchName, DWORD *lpReserved, LPSTR lpClass, DWORD *lpcchClass, void *lpftLastWriteTime);
LSTATUS RegQueryValueExA(HKEY hKey, LPCSTR lpValueName, DWORD *lpReserved, DWORD *lpType, BYTE *lpData, DWORD *lpcbData);
LSTATUS RegCloseKey(HKEY hKey);

HRESULT IMMDeviceEnumerator_EnumAudioEndpoints(IMMDeviceEnumerator *self, EDataFlow flow, DWORD mask, IMMDeviceCollection **ppDevices);
HRESULT IMMDeviceEnumerator_GetDefaultAudioEndpoint(IMMDeviceEnumerator *self, EDataFlow flow, ERole role, IMMDevice **ppEndpoint);
HRESULT IMMDeviceEnumerator_GetDevice(IMMDeviceEnumerator *self, LPCWSTR pwstrId, IMMDevice **ppDevice);
unsigned long IMMDeviceEnumerator_Release(IMMDeviceEnumerator *self);

HRESULT IMMDeviceCollection_GetCount(IMMDeviceCollection *self, UINT *pcDevices);
HRESULT IMMDeviceCollection_Item(IMMDeviceCollection *self, UINT nDevice, IMMDevice **ppDevice);
unsigned long IMMDeviceCollection_Release(IMMDeviceCollection *self);

HRESULT IMMDevice_GetId(IMMDevice *self, LPWSTR *ppstrId);
HRESULT IMMDevice_OpenPropertyStore(IMMDevice *self, DWORD stgmAccess, IPropertyStore **ppProperties);
HRESULT IMMDevice_Activate(IMMDevice *self, const IID *iid, DWORD dwClsCtx, PROPVARIANT *pActivationParams, void **ppInterface);
unsigned long IMMDevice_Release(IMMDevice *self);

HRESULT IPropertyStore_GetValue(IPropertyStore *self, const PROPERTYKEY *key, PROPVARIANT *pv);
unsigned long IPropertyStore_Release(IPropertyStore *self);

HRESULT IAudioClient_IsFormatSupported(IAudioClient *self, int ShareMode, const WAVEFORMATEX *pFormat, WAVEFORMATEX **ppClosestMatch);
HRESULT IAudioClient_Initialize(IAudioClient *self, int ShareMode, DWORD StreamFlags, REFERENCE_TIME hnsBufferDuration, REFERENCE_TIME hnsPeriodicity, const WAVEFORMATEX *pFormat, const GUID *AudioSessionGuid);
HRESULT IAudioClient_GetMixFormat(IAudioClient *self, WAVEFORMATEX **ppDeviceFormat);
HRESULT IAudioClient_GetBufferSize(IAudioClient *self, UINT32 *pNumBufferFrames);
HRESULT IAudioClient_GetService(IAudioClient *self, const IID *riid, void **ppv);
HRESULT IAudioClient_GetCurrentPadding(IAudioClient *self, UINT32 *pNumPaddingFrames);
HRESULT IAudioClient_Start(IAudioClient *self);
HRESULT IAudioClient_Stop(IAudioClient *self);
HRESULT IAudioClient_Reset(IAudioClient *self);
unsigned long IAudioClient_Release(IAudioClient *self);

HRESULT IAudioRenderClient_GetBuffer(IAudioRenderClient *self, UINT32 NumFramesRequested, BYTE **ppData);
HRESULT IAudioRenderClient_ReleaseBuffer(IAudioRenderClient *self, UINT32 NumFramesWritten, DWORD dwFlags);
unsigned long IAudioRenderClient_Release(IAudioRenderClient *self);

#endif
