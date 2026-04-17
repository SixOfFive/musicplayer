#!/usr/bin/env bash
# MusicPlayer — Linux/macOS launcher.
# First run: installs dependencies and rebuilds native modules for Electron.
# Subsequent runs: just starts the dev environment (Vite + Electron).

set -euo pipefail

# cd to the directory this script lives in, regardless of where it was invoked from.
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

say() { printf '\033[1;36m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

# ---- Dependency checks ------------------------------------------------------

command -v node >/dev/null 2>&1 || die "[ERROR] node not found on PATH. Install Node.js LTS (>=18) from https://nodejs.org or your package manager."
command -v npm  >/dev/null 2>&1 || die "[ERROR] npm not found on PATH. It usually ships with Node.js."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
    die "[ERROR] Node.js >= 18 required (found v$(node -v | sed 's/v//'))."
fi

# Linux-only: Electron needs a handful of system libs. Warn if missing; don't fail.
if [ "$(uname -s)" = "Linux" ]; then
    MISSING=()
    for lib in libgtk-3.so.0 libnss3.so libasound.so.2 libxss.so.1; do
        ldconfig -p 2>/dev/null | grep -q "$lib" || MISSING+=("$lib")
    done
    if [ "${#MISSING[@]}" -gt 0 ]; then
        warn "[WARN] Missing Linux libraries Electron needs: ${MISSING[*]}"
        warn "       Debian/Ubuntu:  sudo apt install libgtk-3-0 libnss3 libasound2 libxss1"
        warn "       Fedora:         sudo dnf install gtk3 nss alsa-lib libXScrnSaver"
        warn "       Arch:           sudo pacman -S gtk3 nss alsa-lib libxss"
        warn "       Will try to launch anyway."
    fi
fi

# ---- Install / rebuild ------------------------------------------------------

if [ ! -d node_modules ]; then
    say "================================================================"
    say " First run detected — installing dependencies. This may take a bit."
    say "================================================================"
    npm install

    # electron-builder's install-app-deps also runs as postinstall, but re-run
    # explicitly in case of an interrupted install.
    say "Rebuilding native modules against Electron's Node ABI…"
    npm run rebuild || warn "[WARN] rebuild failed — if the app errors loading better-sqlite3, run 'npm run rebuild' manually."
fi

# ---- Launch -----------------------------------------------------------------

say "================================================================"
say " Starting MusicPlayer (Vite + Electron)…"
say " Press Ctrl+C to stop."
say "================================================================"
exec npm run electron:dev
