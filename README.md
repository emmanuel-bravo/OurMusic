# OurMusic — Reproductor Local de Audio HiFi (Clean-Room · Linux y Windows)

**OurMusic** es un reproductor de música personal y de alta fidelidad (**100 % local**, sin servicios en la nube ni telemetría externa) desarrollado desde cero bajo metodología **clean-room** para **Linux** y **Windows**.

---

## Arquitectura General

1. **Motor de Audio Nativo Optimizado en C11 (`native/`)**:
   - **Decodificadores propios clean-room** compilados con auto-vectorización SIMD (`-O3 -ftree-vectorize -funroll-loops`) sin librerías externas de códecs:
     - **FLAC** (`dec_flac.c`, RFC 9639): bloques `CONSTANT`, `VERBATIM`, `FIXED` (0–4), `LPC` (1–32), decodificación unaria Rice acelerada por hardware (`__builtin_clzll`) y descorrelación estéreo en 16/24/32 bits (**0 LSB de error**).
     - **ALAC / M4A** (`dec_alac.c`): demuxer ISO BMFF (`stsd`, `stts`, `stsc`, `stsz`, `stco`, `co64`) + decodificador Apple Lossless Golomb-Rice adaptativo y predictor FIR dinámico (**0 LSB de error**).
     - **MP3** (`dec_mp3.c`, ISO/IEC 11172-3 / 13818-3 Layer III): cabeceras Xing/Info y retardo gapless LAME, depósito de bits (*bit reservoir*), Huffman, IMDCT 12/36 y banco polifásico de síntesis.
     - **WAV** (`dec_wav.c`): `RIFF/WAVE` y `WAVE_FORMAT_EXTENSIBLE` entero (8/16/24/32 bits) e IEEE Float (32/64 bits).
     - **DSD64 / DSD128 / DSD256 / DSD512 / DSD1024** (`dec_dsd.c`): Sony `.dsf` y Philips DSDIFF `.dff` hasta **45.1584 MHz**, con soporte para **DSD Nativo Directo (`dsdMode: "native"`)**, empaquetado **DoP de 24 bits (`0x05`/`0xFA`)** y conversión **PCM DXD (176.4 / 352.8 kHz) mediante filtro FIR Blackman-Harris de 128 taps acelerado por tablas LUT de 16 etapas y registros de desplazamiento de 128 bits sin `memmove`**.
   - **Anillo Gapless Zero-Copy sin Bloqueo (`engine_core.c`)**: anillo circular en memoria RAM de 64 bloques (`OM_RING_SLOTS`) con desacoplamiento total de candados entre decodificación, DSP y escritura HAL, eliminando copias intermedias en el hilo de salida.
   - **Resampler Sinc Polifásico con Ventana Kaiser de 64 bits (`dsp_resampler.c`)**:
     - **1024 ramas polifásicas** con interpolación delta lineal continua (`fast` / `high` / `ultra`, hasta **> 130 dB** de rechazo anti-aliasing).
     - Mantiene **Bypass Bit-Perfect 0 LSB** siempre que el DAC acepte la tasa nativa, activándose automáticamente solo si el hardware fuerza otra tasa o si el usuario fija sobremuestreo explícito (`targetRate`).
   - **Comunicación Directa con Hardware (`hal_alsa.c` / `hal_wasapi.c` / `hal_asio.c`)**:
     - **Linux (ALSA)**: apertura directa `libasound` con `snd_pcm_hw_params_set_rate_resample(..., 0)` para salida bit-perfect nativa.
     - **Windows (WASAPI + ASIO Nativo)**: negociación `AUDCLNT_SHAREMODE_EXCLUSIVE` con prioridad MMCSS `"Pro Audio"` (respaldo automático a `SHARED`) **y host COM nativo Steinberg ASIO (`asio:<DriverName>`)** con soporte PCM multi-formato y **DSD Direct 1-bit (`IoFormat`)**.

2. **Pipeline DSP Audiófilo de 64 bits (`dsp_eq.c`, `dsp_convolver.c`, `dsp_loudness.c`)**:
   - **Ecualizador Gráfico (5/10 bandas) y Paramétrico Completo de 16 Bandas (`PEQ`)**: frecuencia libre (`10 Hz – 24 kHz`), factor `Q` (`0.1 – 24.0`), ganancia (`-24 dB` a `+24 dB`) y 7 topologías RBJ (`peaking`, `low_shelf`, `high_shelf`, `low_pass`, `high_pass`, `notch`, `all_pass`) con omisión automática de bandas en ganancia unitaria y suavizado exponencial libre de clics ($\tau = 15\text{ ms}$).
   - **Convolver FIR Híbrido de Latencia Cero por Particiones FFT (`dsp_convolver.c`)**: arquitectura Gardner (cabeza en dominio temporal de 256 taps + cola Overlap-Add FFT radix-2 de 512 puntos) para respuestas al impulso `.wav`/`.flac` (corrección acústica / auriculares AutoEQ) con remuestreo automático de IR.
   - **Escáner ITU-R BS.1770-4 / EBU R128 y ReplayGain 2.0 (`dsp_loudness.c`)**: medición exacta de sonoridad integrada (`LUFS` con doble puerta `-70 LUFS` / `-10 LU`), rango `LRA` y **True-Peak 4x inter-sample (`dBTP`)**, más normalización en vivo (`track` / `album`) con protección anti-clipping.
   - **Crossfeed Acústico de Auriculares (Bauer / Meier)**: filtro de sombra craneal ILD (`300–2000 Hz`) + línea de micro-retardo interaural ITD (`0–650 µs`) con compensación de graves centrales.
   - **Hook de Pipeline Extensible (`om_dsp_register_hook`)** + **Bypass Bit-Perfect Automático** cuando todos los módulos DSP están inactivos.

3. **Gestor de Biblioteca Paralelo y Lector O(metadata) (`src/library/`, `src/tags/`)**:
   - Escaneo recursivo paralelo (8 workers concurrentes) con lectura **solo de cabeceras/átomos** (`fs.readSync`), evitando cargar cientos de MB de audio PCM/DSD/FLAC/ALAC en RAM.
   - Lectura y escritura directa de etiquetas **ID3v2.3/v2.4** (`.mp3`, `.wav`, `.dsf`), **Vorbis Comments + PICTURE** (`.flac`) y **MP4 `ilst`** (`.m4a`/ALAC, con ajuste exacto `stco`/`co64`), incluyendo letras sincronizadas y etiquetas `REPLAYGAIN_*` / `R128_*`.

4. **Gestor de Listas de Reproducción y API Asíncrona (`src/playlists/`, `src/server.mjs`)**:
   - Cola activa gapless, importación/exportación **M3U/M3U8**, **PLS** y **XSPF**, y motor de **Listas Inteligentes**.
   - Telemetría adaptativa con **0 % de uso de CPU en reposo** y endpoints REST listos para cualquier interfaz personalizada (`/api/dsp`, `/api/dsp/peq`, `/api/dsp/peq/band`, `/api/dsp/crossfeed`, `/api/dsp/convolver`, `/api/dsp/replaygain`, `/api/dsp/resampler`, `/api/tracks/:id/loudness`).

---

## Requisitos y Ejecución

### En Linux
Dependencias de compilación estándar: `gcc`, `libasound2-dev` (ALSA), `nodejs >= 20` y opcionalmente `libgtk-3-dev` + `libwebkit2gtk-4.1-dev` para ventana nativa de escritorio.

```bash
# Compilar binarios nativos optimizados (bin/ourmusic-engine y bin/ourmusic-gui)
npm run build:linux

# Iniciar aplicación de escritorio (o servidor web local con npm run start:web)
./scripts/start-linux.sh

# Ejecutar suite completa de 21 pruebas automatizadas
npm test
```

### En Windows
Dependencias: **Node.js >= 20** y un compilador C11 en `PATH` (**MinGW-w64 `gcc`** o **Visual Studio `cl.exe`** con Windows SDK).

```bat
:: Compilar bin\ourmusic-engine.exe con soporte WASAPI Exclusive/Shared + ASIO Nativo
scripts\build-windows.bat

:: Iniciar OurMusic en ventana dedicada
scripts\start-windows.bat
```
