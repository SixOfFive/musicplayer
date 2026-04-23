#!/usr/bin/env bash
# MusicPlayer — Linux/macOS launcher.
# Self-heals dependencies at every run:
#   - npm install if node_modules is missing
#   - npm install if package.json is newer than the last install marker
#     (catches newly-added deps since the last install)
#   - npm rebuild ffmpeg-static if its binary is missing
#     (catches interrupted binary downloads)
# Then launches the dev environment.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

say()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
info() { printf '\033[1;34m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

# ---- Runtime checks ---------------------------------------------------------

command -v node >/dev/null 2>&1 || die "[ERROR] node not found on PATH. Install Node.js LTS (>=18)."
command -v npm  >/dev/null 2>&1 || die "[ERROR] npm not found on PATH."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
    die "[ERROR] Node.js >= 18 required (found v$(node -v | sed 's/v//'))."
fi

# Linux system libs that Electron needs. Warn only.
if [ "$(uname -s)" = "Linux" ]; then
    MISSING=()
    for lib in libgtk-3.so.0 libnss3.so libasound.so.2 libxss.so.1; do
        ldconfig -p 2>/dev/null | grep -q "$lib" || MISSING+=("$lib")
    done
    if [ "${#MISSING[@]}" -gt 0 ]; then
        warn "[WARN] Missing Linux libs Electron needs: ${MISSING[*]}"
        warn "       Debian/Ubuntu:  sudo apt install libgtk-3-0 libnss3 libasound2 libxss1"
        warn "       Fedora:         sudo dnf install gtk3 nss alsa-lib libXScrnSaver"
        warn "       Arch:           sudo pacman -S gtk3 nss alsa-lib libxss"
    fi
fi

# ---- Dependency self-heal ---------------------------------------------------

needs_install=0

# 1) Missing node_modules.
if [ ! -d node_modules ]; then
    info "[deps] node_modules not found."
    needs_install=1
fi

# 2) package.json newer than the last-install marker.
#    `.package-lock.json` inside node_modules is written by npm at end of install,
#    so its mtime is a reliable "last fully installed" timestamp.
if [ "$needs_install" -eq 0 ] && [ -f package.json ]; then
    if [ ! -f node_modules/.package-lock.json ] || \
       [ package.json -nt node_modules/.package-lock.json ]; then
        info "[deps] package.json is newer than last install — re-syncing."
        needs_install=1
    fi
fi

if [ "$needs_install" -eq 1 ]; then
    say "================================================================"
    say " Installing / updating dependencies…"
    say "================================================================"
    npm install
fi

# 3) ffmpeg binary probe. ffmpeg-static's postinstall downloads a platform
#    binary from GitHub. If that was interrupted (flaky network, proxy, AV),
#    the package dir exists but the binary doesn't. `npm rebuild` re-runs
#    the postinstall hook, which re-downloads.
FFMPEG_BIN="node_modules/ffmpeg-static/ffmpeg"
if [ ! -x "$FFMPEG_BIN" ]; then
    warn "[deps] ffmpeg binary missing. Rebuilding ffmpeg-static…"
    npm rebuild ffmpeg-static || true
    if [ ! -x "$FFMPEG_BIN" ]; then
        warn "[WARN] Still no ffmpeg binary after rebuild. FLAC-to-MP3 conversion will be disabled."
        warn "       Try: npm install ffmpeg-static --force"
    else
        info "[ok] ffmpeg-static ready."
    fi
else
    info "[ok] Bundled ffmpeg present."
fi

# ---- Launch -----------------------------------------------------------------

# Exit code 42 is the updater's "restart me" signal — after a successful
# `git reset --hard origin/<branch>` (+ optional npm install) the
# Electron main process exits 42 so we loop back around here and spawn
# a fresh instance on the new code. Any other exit code (0 normal close,
# 1 crash, 130 Ctrl-C, …) falls out of the loop like before.
#
# `set -e` at the top of the file would kill us on a non-zero exit from
# the child — we temporarily relax that for the command itself and
# re-check the code manually so Ctrl-C / clean quit / crash all propagate
# the right way.
say "================================================================"
say " Starting MusicPlayer (Vite + Electron)…"
say " Press Ctrl+C to stop."
say "================================================================"

while true; do
    set +e
    npm run electron:dev
    rc=$?
    set -e
    if [ "$rc" -eq 42 ]; then
        say "================================================================"
        say " Auto-update applied — re-launching…"
        say "================================================================"
        # Re-sync deps if the update bumped package.json (updater already
        # did this, but a defensive second check costs nothing and catches
        # the edge case where the updater bailed mid-install).
        if [ ! -f node_modules/.package-lock.json ] || \
           [ package.json -nt node_modules/.package-lock.json ]; then
            info "[deps] package.json is newer than last install — re-syncing before relaunch."
            npm install
        fi
        continue
    fi
    exit "$rc"
done
