#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/mods/now-playing"
SRC="$OUT/native/nowplaying.mm"
TARGET="$OUT/qobuz-nowplaying.node"

if [[ ! -f "$SRC" ]]; then
  echo "native source not found: $SRC" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "the now-playing native addon currently builds only on macOS" >&2
  exit 1
fi

SDK="$(xcrun --show-sdk-path)"
ARCH="$(uname -m)"

NODE_BIN="$(command -v node || true)"
CANDIDATES=(
  "${NODE_INCLUDE:-}"
  "/usr/local/include/node"
  "/opt/homebrew/include/node"
  "$(dirname "$(dirname "$NODE_BIN")")/include/node"
  "$HOME/.nvm/versions/node/$(node -v 2>/dev/null)/include/node"
)

NODE_INCLUDE=""
for candidate in "${CANDIDATES[@]}"; do
  if [[ -n "$candidate" && -f "$candidate/node_api.h" ]]; then
    NODE_INCLUDE="$candidate"
    break
  fi
done

if [[ -z "$NODE_INCLUDE" ]]; then
  echo "node_api.h not found." >&2
  echo "Install Xcode Command Line Tools and Node headers, or set NODE_INCLUDE." >&2
  exit 1
fi

echo "building $TARGET (arch=$ARCH, headers=$NODE_INCLUDE)"
mkdir -p "$OUT"

clang++ \
  -std=c++17 \
  -fobjc-arc \
  -bundle \
  -undefined dynamic_lookup \
  -arch "$ARCH" \
  -mmacosx-version-min=10.15 \
  -DNAPI_VERSION=8 \
  -I"$NODE_INCLUDE" \
  -isysroot "$SDK" \
  -framework Foundation \
  -framework AppKit \
  -framework MediaPlayer \
  -o "$TARGET" \
  "$SRC"

codesign --force --options runtime --sign - "$TARGET"

echo "built $TARGET"
file "$TARGET"
codesign --verify --strict "$TARGET" && echo "signature OK"
