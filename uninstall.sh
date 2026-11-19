#!/usr/bin/env bash
set -euo pipefail

REPO="${QOBUZ_MODS_REPO:-Jupitarrr/qobuz-mods}"
REF="${QOBUZ_MODS_REF:-main}"
INSTALL_DIR="${QOBUZ_MODS_HOME:-$HOME/.qobuz-mods}"

[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "error: invalid QOBUZ_MODS_REPO: $REPO" >&2
  exit 1
}
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ && "$REF" != *..* && "$REF" != /* && "$REF" != */ ]] || {
  echo "error: invalid QOBUZ_MODS_REF: $REF" >&2
  exit 1
}

case "$INSTALL_DIR" in
  "~") INSTALL_DIR="$HOME" ;;
  "~/"*) INSTALL_DIR="$HOME/${INSTALL_DIR#\~/}" ;;
esac
[[ "$INSTALL_DIR" == /* ]] || INSTALL_DIR="$PWD/$INSTALL_DIR"

# From a checkout, use its installer next door.
SELF="${BASH_SOURCE[0]:-}"
if [[ -n "$SELF" && -f "$SELF" ]]; then
  SELF_DIR="$(cd "$(dirname "$SELF")" && pwd)"
  if [[ -f "$SELF_DIR/install.sh" && -f "$SELF_DIR/bin/qobuz-mod.js" ]]; then
    exec bash "$SELF_DIR/install.sh" restore "$@"
  fi
fi

# From `curl .../uninstall.sh | bash`, prefer the source already on disk.
if [[ -f "$INSTALL_DIR/uninstall.sh" ]]; then
  exec bash "$INSTALL_DIR/uninstall.sh" "$@"
fi

# No installed source: fetch the installer and let it bootstrap before restoring.
tmp="$(mktemp -d "${TMPDIR:-/tmp}/qobuz-mods-uninstall.XXXXXX")"
# shellcheck disable=SC2064
trap "rm -rf $(printf '%q' "$tmp")" EXIT
curl -fsSL --retry 3 --connect-timeout 15 \
  -o "$tmp/install.sh" \
  "https://raw.githubusercontent.com/$REPO/$REF/install.sh" ||
  {
    echo "error: could not download the qobuz-mods installer" >&2
    exit 1
  }
bash "$tmp/install.sh" restore "$@"
