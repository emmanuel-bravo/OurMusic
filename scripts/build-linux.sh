#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "${ROOT_DIR}/bin"

echo "[OurMusic] Compilando motor de audio C11 (ALSA + FLAC/ALAC/MP3/WAV/DSD + DSP Biquad 64-bit)..."
gcc -O2 -Wall -Wextra -Wno-unused-parameter -std=c11 \
  -D_POSIX_C_SOURCE=200809L -D_FILE_OFFSET_BITS=64 \
  "${ROOT_DIR}/native/main_engine.c" \
  "${ROOT_DIR}/native/engine_core.c" \
  "${ROOT_DIR}/native/dsp_eq.c" \
  "${ROOT_DIR}/native/dec_dispatch.c" \
  "${ROOT_DIR}/native/dec_wav.c" \
  "${ROOT_DIR}/native/dec_flac.c" \
  "${ROOT_DIR}/native/dec_alac.c" \
  "${ROOT_DIR}/native/dec_mp3.c" \
  "${ROOT_DIR}/native/dec_dsd.c" \
  "${ROOT_DIR}/native/hal_alsa.c" \
  "${ROOT_DIR}/native/hal_wavsink.c" \
  -lasound -lpthread -lm \
  -o "${ROOT_DIR}/bin/ourmusic-engine"

echo "[OurMusic] Motor compilado en bin/ourmusic-engine"

if pkg-config --exists gtk+-3.0 webkit2gtk-4.1 2>/dev/null; then
  echo "[OurMusic] Compilando ventana nativa de escritorio (GTK3 + WebKit2GTK 4.1)..."
  # shellcheck disable=SC2046
  gcc -O2 -Wall $(pkg-config --cflags gtk+-3.0 webkit2gtk-4.1) \
    "${ROOT_DIR}/native/linux_gui.c" \
    $(pkg-config --libs gtk+-3.0 webkit2gtk-4.1) \
    -o "${ROOT_DIR}/bin/ourmusic-gui"
  echo "[OurMusic] Interfaz nativa compilada en bin/ourmusic-gui"
elif pkg-config --exists gtk+-3.0 webkit2gtk-4.0 2>/dev/null; then
  echo "[OurMusic] Compilando ventana nativa de escritorio (GTK3 + WebKit2GTK 4.0)..."
  # shellcheck disable=SC2046
  gcc -O2 -Wall $(pkg-config --cflags gtk+-3.0 webkit2gtk-4.0) \
    "${ROOT_DIR}/native/linux_gui.c" \
    $(pkg-config --libs gtk+-3.0 webkit2gtk-4.0) \
    -o "${ROOT_DIR}/bin/ourmusic-gui"
  echo "[OurMusic] Interfaz nativa compilada en bin/ourmusic-gui"
else
  echo "[OurMusic] Nota: WebKit2GTK no detectado; se utilizará la interfaz web local en navegador."
fi
