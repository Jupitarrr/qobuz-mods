#!/usr/bin/env bash
set -euo pipefail

REPO="${QOBUZ_MODS_REPO:-Jupitarrr/qobuz-mods}"
REF="${QOBUZ_MODS_REF:-main}"
INSTALL_DIR="${QOBUZ_MODS_HOME:-$HOME/.qobuz-mods}"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  BOLD=$'\033[1m'
  GREEN=$'\033[32m'
  RED=$'\033[31m'
  RESET=$'\033[0m'
else
  BOLD='' GREEN='' RED='' RESET=''
fi

say() { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$GREEN" "$RESET" "$*"; }
die() {
  printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2
  exit 1
}

[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  die "invalid QOBUZ_MODS_REPO: $REPO (expected owner/repo)"
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ && "$REF" != *..* && "$REF" != /* && "$REF" != */ ]] ||
  die "invalid QOBUZ_MODS_REF: $REF"

usage() {
  cat <<EOF
${BOLD}Qobuz Mods installer${RESET}

Usage:
  curl -fsSL https://raw.githubusercontent.com/$REPO/$REF/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/$REPO/$REF/install.sh | bash -s -- --force

  ./install.sh [command] [options]        (from a checkout)

Commands (default: patch):
  patch         Install/update the runtime and patch Qobuz in place
  restore       Undo the patch
  update        Re-apply the patch after a Qobuz update
  doctor        Inspect the install and print diagnostics
  list          List installed mods
  build-native  Build the macOS Now Playing addon
  version       Print the CLI version
  help          Show this help

Options are passed to qobuz-mod, for example --app, --force, --no-native, --json.

Environment:
  QOBUZ_MODS_HOME=$INSTALL_DIR   source install directory for curl installs
  QOBUZ_MODS_REPO=$REPO          GitHub owner/repo
  QOBUZ_MODS_REF=$REF            branch, tag, or commit to install
  QOBUZ_MODS_TARBALL=<path>      use a local source tarball instead of downloading
EOF
}

# The first positional argument may select a command; everything else is a
# qobuz-mod option. This keeps `./install.sh --force` and
# `curl ... | bash -s -- restore` working through the same entry point.
COMMAND=patch
if (($# > 0)); then
  case "$1" in
    patch | restore | update | doctor | list | build-native | version | help | -h | --help)
      case "$1" in
        -h | --help) COMMAND=help ;;
        *) COMMAND="$1" ;;
      esac
      shift
      ;;
  esac
fi

if [[ "$COMMAND" == "help" ]]; then
  usage
  exit 0
fi

[[ "$(uname -s)" == "Darwin" ]] ||
  die "Qobuz Mods currently supports macOS only (Windows is not tested yet)."

command -v node >/dev/null 2>&1 ||
  die "node is required (>= 18). Install it with Homebrew: brew install node"

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
((NODE_MAJOR >= 18)) ||
  die "node >= 18 is required (found $(node -v 2>/dev/null || echo none))."

command -v curl >/dev/null 2>&1 || die "curl is required."
command -v tar >/dev/null 2>&1 || die "tar is required."

# Only patch-like commands need the compiler. restore/doctor/list/version work
# with the already-installed runtime.
NEEDS_NATIVE=0
case "$COMMAND" in
  patch | update | build-native) NEEDS_NATIVE=1 ;;
esac
for arg in "$@"; do
  [[ "$arg" == "--no-native" ]] && NEEDS_NATIVE=0
done
if ((NEEDS_NATIVE == 1)) && ! xcode-select -p >/dev/null 2>&1; then
  die "Xcode Command Line Tools are required to build the Now Playing addon.
Install them with: xcode-select --install
Or re-run with --no-native to skip the addon."
fi

# Resolve the install directory to an absolute path without requiring it to
# exist yet.
case "$INSTALL_DIR" in
  "~") INSTALL_DIR="$HOME" ;;
  "~/"*) INSTALL_DIR="$HOME/${INSTALL_DIR#\~/}" ;;
esac
[[ "$INSTALL_DIR" == /* ]] || INSTALL_DIR="$PWD/$INSTALL_DIR"
case "$INSTALL_DIR" in
  "" | "/" | "$HOME") die "refusing to use unsafe QOBUZ_MODS_HOME: $INSTALL_DIR" ;;
esac

# Running from a checkout: use it directly, just like before.
SELF="${BASH_SOURCE[0]:-}"
LOCAL_ROOT=""
if [[ -n "$SELF" && -f "$SELF" ]]; then
  candidate="$(cd "$(dirname "$SELF")" && pwd)"
  if [[ -f "$candidate/bin/qobuz-mod.js" && -f "$candidate/runtime/loader.js" ]]; then
    LOCAL_ROOT="$candidate"
  fi
fi

bootstrap_from_archive() {
  local archive="$1"
  local tmp src
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/qobuz-mods.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf $(printf '%q' "$tmp")" EXIT
  src="$tmp/src"

  if [[ -n "$archive" ]]; then
    [[ -f "$archive" ]] || die "source tarball not found: $archive"
    step "using source tarball $archive"
    cp "$archive" "$tmp/source.tar.gz"
  else
    step "downloading $REPO@$REF"
    curl -fL --retry 3 --connect-timeout 15 \
      -o "$tmp/source.tar.gz" \
      "https://codeload.github.com/$REPO/tar.gz/$REF" ||
      die "could not download $REPO@$REF"
  fi

  [[ -s "$tmp/source.tar.gz" ]] || die "downloaded source archive is empty"
  mkdir -p "$src"
  tar -xzf "$tmp/source.tar.gz" -C "$src" --strip-components=1 ||
    die "could not extract source archive"
  [[ -f "$src/bin/qobuz-mod.js" ]] ||
    die "source archive does not look like qobuz-mods (missing bin/qobuz-mod.js)"

  mkdir -p "$(dirname "$INSTALL_DIR")"
  rm -rf "${INSTALL_DIR}.new"
  cp -R "$src" "${INSTALL_DIR}.new"
  rm -rf "$INSTALL_DIR"
  mv "${INSTALL_DIR}.new" "$INSTALL_DIR"
  chmod +x "$INSTALL_DIR/install.sh" "$INSTALL_DIR/uninstall.sh" 2>/dev/null || true

  cat >"$INSTALL_DIR/.qobuz-mods-install" <<EOF
repo=$REPO
ref=$REF
installed_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
EOF

  step "installed source to $INSTALL_DIR"
  ROOT="$INSTALL_DIR"
}

ROOT=""
if [[ -n "$LOCAL_ROOT" ]]; then
  ROOT="$LOCAL_ROOT"
  step "using local checkout $ROOT"
else
  bootstrap_from_archive "${QOBUZ_MODS_TARBALL:-}"
fi

if node "$ROOT/bin/qobuz-mod.js" "$COMMAND" "$@"; then
  if [[ -z "$LOCAL_ROOT" && "$COMMAND" == "patch" ]]; then
    say ""
    say "${GREEN}Installed and patched.${RESET}"
    say "  source:  $ROOT"
    say "  restore: $ROOT/uninstall.sh"
    say "  update:  curl -fsSL https://raw.githubusercontent.com/$REPO/$REF/install.sh | bash"
  fi
else
  status=$?
  exit "$status"
fi
