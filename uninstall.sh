#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required (>= 18). Install it with Homebrew: brew install node" >&2
  exit 1
fi

exec node "$ROOT/bin/qobuz-mod.js" restore "$@"
