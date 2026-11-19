#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/qobuz-mods-installer-test.XXXXXX")"
# shellcheck disable=SC2064
trap "rm -rf $(printf '%q' "$TMP")" EXIT

STAGE="$TMP/qobuz-mods-main"
mkdir -p "$STAGE"
while IFS= read -r -d '' file; do
  mkdir -p "$STAGE/$(dirname "$file")"
  cp -p "$ROOT/$file" "$STAGE/$file"
done < <(cd "$ROOT" && git ls-files -z)
tar -czf "$TMP/source.tar.gz" -C "$TMP" qobuz-mods-main

OUT="$TMP/out.txt"
cat "$ROOT/install.sh" |
  QOBUZ_MODS_TARBALL="$TMP/source.tar.gz" \
  QOBUZ_MODS_HOME="$TMP/home" \
  bash -s -- version >"$OUT"

EXPECTED="$(node -p "require('$ROOT/package.json').version")"
grep -qx "$EXPECTED" "$OUT" || {
  echo "installer version output did not match $EXPECTED" >&2
  cat "$OUT" >&2
  exit 1
}
[[ -f "$TMP/home/bin/qobuz-mod.js" ]]
[[ -f "$TMP/home/.qobuz-mods-install" ]]
[[ -f "$TMP/home/runtime/loader.js" ]]

echo "installer smoke test OK"
