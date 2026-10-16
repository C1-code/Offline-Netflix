#!/usr/bin/env bash
# First-run bootstrap for a fresh clone. Called by "Offline Netflix.bat"
# (Windows/WSL) but works on plain Linux too. Installs user-local
# prerequisites — Node via nvm, a static ffmpeg into tools/bin/ — and never
# needs sudo. Then hands off to ./setup.sh (fresh clones only) and ./start.sh.
# Idempotent: re-running only fills in whatever is still missing.
#
#   tools/first-run.sh                  install missing prereqs, then start
#   tools/first-run.sh --check          report present/missing, change nothing
#   WITH_WHISPER=0 tools/first-run.sh   skip the ~1GB AI-subtitle stack
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p data
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log()  { printf '\n== %s ==\n' "$*"; }
info() { printf '   %s\n' "$*"; }
fail() { printf '\n[setup] ERROR: %s\n' "$*" >&2; exit 1; }

CHECK_ONLY=0
if [ "${1:-}" = "--check" ] || [ "${1:-}" = "-c" ]; then CHECK_ONLY=1; fi
MISSING=0

# curl/wget wrapper — curl is used by start.sh's health checks; wget is the
# fallback for machines that ship only one of the two.
fetch() { # fetch <url> <outfile>
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    return 1
  fi
}

NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
load_nvm() {
  [ -s "$NVM_DIR/nvm.sh" ] || return 1
  set +eu          # nvm.sh is not written for set -u
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  set -eu
  return 0
}
node_ok() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && return 0
  load_nvm && command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1
}

# Static ffmpeg landing spot goes on PATH first, so the app (and this script)
# find our downloaded copy; a system ffmpeg is only used if tools/bin is empty.
export PATH="$ROOT/tools/bin:$PATH"

log "Prerequisite check"

# --- curl (start.sh's health checks use it) ---
command -v curl >/dev/null 2>&1 && info "curl — ok" \
  || info "NOTE: curl not found — start.sh health checks need it (sudo apt-get install curl)"

# --- node / npm (nvm keeps everything in ~/.nvm — user-owned, no sudo) ---
if node_ok; then
  info "node $(node --version) — ok"
else
  if [ "$CHECK_ONLY" = 1 ]; then
    info "MISSING: node/npm (first run installs it via nvm)"
    MISSING=1
  else
    log "Installing Node via nvm (user-local, no sudo)"
    fetch "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh" "$TMP/nvm-install.sh" \
      || fail "could not download the nvm installer (internet is needed for first-run setup)"
    # PROFILE=/dev/null keeps the installer from touching rc files; it is
    # sourced explicitly right after instead.
    PROFILE=/dev/null bash "$TMP/nvm-install.sh" >/dev/null 2>&1 || fail "nvm installation failed"
    load_nvm || fail "nvm.sh not found after install"
    nvm install 22 >/dev/null 2>&1 || fail "Node 22 install failed"
    nvm alias default 22 >/dev/null 2>&1 || true
    node_ok || fail "node/npm still unavailable after nvm install"
    info "node $(node --version) installed"
  fi
fi

# --- ffmpeg / ffprobe (system copy if present, else static build in tools/bin) ---
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  info "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f1-3) — ok"
else
  if [ "$CHECK_ONLY" = 1 ]; then
    info "MISSING: ffmpeg/ffprobe (first run downloads a static build into tools/bin)"
    MISSING=1
  else
    log "Downloading static ffmpeg into tools/bin (no sudo needed)"
    command -v xz >/dev/null 2>&1 || fail "xz is required to unpack ffmpeg (sudo apt-get install xz-utils), then re-run"
    arch="$(uname -m)"
    case "$arch" in
      x86_64) urls=("https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz"
                   "https://www.johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz");;
      aarch64|arm64) urls=("https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linuxarm64-gpl.tar.xz"
                   "https://www.johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz");;
      *) fail "no static ffmpeg available for '$arch' — install ffmpeg manually and re-run";;
    esac
    got=""
    for url in "${urls[@]}"; do
      info "trying ${url##*/} ..."
      if fetch "$url" "$TMP/ffmpeg.tar.xz" && tar -xJf "$TMP/ffmpeg.tar.xz" -C "$TMP" 2>/dev/null; then
        got=1; break
      fi
      rm -f "$TMP/ffmpeg.tar.xz"; rm -rf "$TMP"/ffmpeg-*
    done
    [ -n "$got" ] || fail "all ffmpeg downloads failed (internet is needed for first-run setup)"
    cp "$TMP"/ffmpeg-*/ffmpeg "$TMP"/ffmpeg-*/ffprobe tools/bin/
    chmod +x tools/bin/ffmpeg tools/bin/ffprobe
    "$ROOT/tools/bin/ffmpeg" -version >/dev/null 2>&1 || fail "downloaded ffmpeg does not run on this machine"
    info "ffmpeg ready: tools/bin/ffmpeg"
  fi
fi

# --- project deps + config via ./setup.sh (idempotent; it leaves an existing
#     config.json alone) ---
NEED_SETUP=0
[ -f config.json ] || NEED_SETUP=1
[ -d node_modules ] || NEED_SETUP=1
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import ensurepip, venv' >/dev/null 2>&1; then
  # python3-venv is often absent on fresh distros and needs apt/sudo — skip
  # Whisper rather than block the first run; the subtitle pipeline degrades
  # gracefully (embedded English streams still work).
  export WITH_WHISPER=0
  info "python3 venv unavailable — AI-subtitle (Whisper) setup skipped"
  info "(enable later: sudo apt-get install -y python3-venv && bash tools/setup-whisper.sh)"
elif [ ! -d tools/.venv ]; then
  NEED_SETUP=1
fi

if [ "$NEED_SETUP" = 1 ]; then
  if [ "$CHECK_ONLY" = 1 ]; then
    info "MISSING: config.json and/or node_modules (first run runs ./setup.sh)"
    MISSING=1
  else
    log "Running ./setup.sh (config bootstrap + npm install + Whisper if allowed)"
    bash setup.sh || fail "setup.sh failed"
  fi
else
  info "config.json + node_modules present — setup already done"
fi

if [ "$CHECK_ONLY" = 1 ]; then
  if [ "$MISSING" = 0 ]; then
    echo "All prerequisites present."
    exit 0
  fi
  echo "Some prerequisites are missing — a real (non --check) run will install them."
  exit 1
fi

# --- start (start.sh restarts any previous instance, so this is safe to re-run) ---
log "Starting server"
if ./start.sh; then
  touch data/.first-run-done
  info "First-run setup complete. Future double-clicks skip straight to launch."
else
  fail "server failed to start — see data/server.log"
fi