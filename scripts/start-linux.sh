#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -x "${ROOT_DIR}/bin/ourmusic-engine" ] || [ ! -x "${ROOT_DIR}/bin/ourmusic-gui" ]; then
  bash "${ROOT_DIR}/scripts/build-linux.sh"
fi

export GDK_BACKEND="${GDK_BACKEND:-wayland,x11}"
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1

exec node "${ROOT_DIR}/src/index.mjs" "$@"
