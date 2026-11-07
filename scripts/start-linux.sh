#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -x "${ROOT_DIR}/bin/ourmusic-engine" ]; then
  bash "${ROOT_DIR}/scripts/build-linux.sh"
fi

exec node "${ROOT_DIR}/src/index.mjs" "$@"
