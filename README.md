# OurMusic — Reproductor Local de Audio HiFi (Clean-Room · Linux y Windows)

**OurMusic** es un reproductor de música personal y de alta fidelidad (**100 % local**, sin servicios en la nube ni telemetría externa) desarrollado desde cero bajo metodología **clean-room** para **Linux** y **Windows**.

---

## Arquitectura General

1. **Motor de Audio Nativo en C11 (`native/`)**:
   - **Decodificadores propios clean-room** sin dependencias externas de códecs:
     - **FLAC** (`dec_flac.c`, RFC 9639): bloques `CONSTANT`, `VERBATIM`, `FIXED` (0–4), `LPC` (1–32), particiones Rice de 4/5 bits y descorrelación estéreo `mid-side` / `left-side` / `right-side` en 16/24/32 bits (**0 LSB de error**).
     - **ALAC / M4A** (`dec_alac.c`): demuxer ISO BMFF (`stsd`, `stts`, `stsc`, `stsz`, `stco`, `co64`) + decodificador Apple Lossless Golomb-Rice adaptativo y predictor FIR dinámico (**0 LSB de error**).
     - **MP3** (`dec_mp3.c`, ISO/IEC 11172-3 / 13818-3 Layer III): cabeceras Xing/Info y retardo gapless LAME, depósito de bits (*bit reservoir*), Huffman, IMDCT 12/36 y banco polifásico de síntesis.
     - **WAV** (`dec_wav.c`): `RIFF/WAVE` y `WAVE_FORMAT_EXTENSIBLE` entero (8/16/24/32 bits) e IEEE Float (32/64 bits).
     - **DSD** (`dec_dsd.c`): Sony `.dsf` y Philips DSDIFF `.dff` (`DSD64/128/256`) tanto en empaquetado **DoP de 24 bits (`0x05`/`0xFA`)** como en conversión **PCM de alta resolución mediante filtro FIR Blackman-Harris de 64 coeficientes**.
   - **Reproducción Gapless (`engine_core.c`)**: anillo circular en memoria RAM de 64 bloques (`OM_RING_SLOTS`) alimentado por un hilo decodificador dedicado que pre-abre la siguiente pista (`queue_next`) logrando transición continua de muestra exacta sin silencios.
   - **Comunicación Directa con Hardware — Bit-Perfect (`hal_alsa.c` / `hal_wasapi.c`)**:
     - **Linux (ALSA)**: apertura directa `libasound` con `snd_pcm_hw_params_set_rate_resample(..., 0)` para evitar el remuestreo del sistema operativo y respetar la frecuencia nativa de cada pista.
     - **Windows (WASAPI)**: negociación `AUDCLNT_SHAREMODE_EXCLUSIVE` con prioridad de hilo MMCSS `"Pro Audio"` para salto completo del mezclador de Windows, con respaldo automático a `AUDCLNT_SHAREMODE_SHARED`.
2. **Pipeline DSP de 64 bits y Ecualizador Funcional (`dsp_eq.c`, `src/dsp/presetManager.mjs`)**:
   - **Hook de Procesamiento en el Pipeline (`om_dsp_register_hook`)**: cadena extensible de callbacks DSP en coma flotante de 64 bits (incluye procesador de escena estéreo Mid/Side controlable en vivo) y **Bypass Bit-Perfect** automático cuando el ecualizador y los hooks están desactivados.
   - **Pre-amp** ajustable en decibelios (`-18 dB` a `+18 dB`) previo a la cascada de filtros con limitador suave anti-clipping.
   - **Filtros Digitales Biquad RBJ**: cascada de filtros *peaking* de 5 bandas (`60 Hz, 230 Hz, 910 Hz, 3.6 kHz, 14 kHz`) o 10 bandas ISO (`31 Hz – 16 kHz`) recalculados dinámicamente según la frecuencia de muestreo nativa.
   - **Suavizado de Parámetros (*Parameter Smoothing*)**: interpolador exponencial monopolo ($\tau = 15\text{ ms}$) por muestra que elimina clics al mover faders en tiempo real, **con interruptor explícito para activarlo o desactivarlo**.
   - **Gestor de Perfiles JSON**: perfiles clásicos integrados (**Plano**, **Rock**, **Jazz**, **Clásica**, **Vocal / Acústica**, **Graves Profundos**) y guardado/importación/exportación de perfiles personalizados en JSON.
3. **Gestor de Biblioteca y Analizador/Escritor de Metadatos (`src/library/`, `src/tags/`)**:
   - Escaneo recursivo asíncrono de carpetas locales, búsqueda instantánea y filtrado facetado.
   - **Lectura y escritura** directa de etiquetas embebidas en **ID3v2.3/v2.4** (`.mp3`, `.wav`, `.dsf`), **Vorbis Comments + PICTURE** (`.flac`) y **átomos MP4 `ilst`** (`.m4a`/ALAC, con ajuste automático de desplazamientos `stco`/`co64`): título, artista, álbum, año, compositor, género, **letras sincronizadas (`SYLT` / `USLT` / `.lrc`)** y **carátula embebida**.
4. **Gestor de Listas de Reproducción e Interfaz Asíncrona (`src/playlists/`, `src/ui/`)**:
   - Cola activa con precarga gapless, importación/exportación/edición de **M3U/M3U8**, **PLS** y **XSPF**, y motor de **Listas Inteligentes** basadas en reglas dinámicas.
   - Interfaz desacoplada mediante `HTTP + Server-Sent Events (SSE)` servida en ventana nativa de escritorio (`GTK3 + WebKit2GTK` en Linux / modo `--app` en Windows) o navegador web.

---

## Requisitos y Ejecución

### En Linux
Dependencias de compilación estándar: `gcc`, `libasound2-dev` (ALSA), `nodejs >= 20` y opcionalmente `libgtk-3-dev` + `libwebkit2gtk-4.1-dev` para ventana nativa de escritorio.

```bash
# Compilar binarios nativos (bin/ourmusic-engine y bin/ourmusic-gui)
npm run build:linux

# Iniciar aplicación de escritorio (o servidor web local con npm run start:web)
./scripts/start-linux.sh

# Ejecutar suite completa de pruebas automatizadas
npm test
```

### En Windows
Dependencias: **Node.js >= 20** y un compilador C11 en `PATH` (**MinGW-w64 `gcc`** o **Visual Studio `cl.exe`** con Windows SDK).

```bat
:: Compilar bin\ourmusic-engine.exe con soporte WASAPI Exclusive/Shared
scripts\build-windows.bat

:: Iniciar OurMusic en ventana dedicada
scripts\start-windows.bat
```
