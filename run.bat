@echo off
setlocal enabledelayedexpansion

REM MusicPlayer - Windows launcher
REM Self-heals dependencies at every run:
REM   - npm install if node_modules is missing
REM   - npm install if package.json is newer than node_modules/.package-lock.json
REM     (catches newly-added deps since the last install)
REM   - npm rebuild ffmpeg-static if its binary is missing
REM     (catches interrupted binary downloads)
REM Then launches the dev environment.

cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm was not found on PATH. Install Node.js LTS from https://nodejs.org and retry.
    pause
    exit /b 1
)

set "NEEDS_INSTALL=0"

REM 1) Missing node_modules entirely — first run or freshly cleaned.
if not exist "node_modules" (
    set "NEEDS_INSTALL=1"
    echo [deps] node_modules not found.
)

REM 2) package.json was modified after the last install.
REM    We compare mtimes via `forfiles /d` + a timestamp written after install.
if "!NEEDS_INSTALL!"=="0" (
    if exist "node_modules\.package-lock.json" (
        for %%A in ("package.json") do set "PKG_MTIME=%%~tA"
        for %%A in ("node_modules\.package-lock.json") do set "LOCK_MTIME=%%~tA"
        REM Lex-sort trick: Windows %~t output is `MM/DD/YYYY HH:MM AM` which doesn't
        REM sort reliably. Use PowerShell for a proper comparison.
        for /f "delims=" %%R in ('powershell -NoProfile -Command "if ((Get-Item package.json).LastWriteTime -gt (Get-Item node_modules\.package-lock.json).LastWriteTime) { 'newer' } else { 'same' }"') do set "PKG_CMP=%%R"
        if "!PKG_CMP!"=="newer" (
            set "NEEDS_INSTALL=1"
            echo [deps] package.json is newer than last install — re-syncing.
        )
    ) else (
        set "NEEDS_INSTALL=1"
        echo [deps] No lock marker found — re-installing.
    )
)

if "!NEEDS_INSTALL!"=="1" (
    echo ======================================================================
    echo  Installing / updating dependencies...
    echo ======================================================================
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

REM 3) ffmpeg binary probe. ffmpeg-static downloads the binary during its
REM    postinstall script. If the download was interrupted (network blip,
REM    antivirus quarantine, proxy), the package is "installed" but the
REM    binary is missing. `npm rebuild` re-runs the postinstall hook.
if not exist "node_modules\ffmpeg-static\ffmpeg.exe" (
    echo [deps] ffmpeg binary missing. Rebuilding ffmpeg-static...
    call npm rebuild ffmpeg-static
    if not exist "node_modules\ffmpeg-static\ffmpeg.exe" (
        echo [WARN] Still no ffmpeg binary after rebuild. FLAC-to-MP3 conversion will be disabled.
        echo        Try: npm install ffmpeg-static --force
    ) else (
        echo [ok] ffmpeg-static ready.
    )
) else (
    echo [ok] Bundled ffmpeg present.
)

echo ======================================================================
echo  Starting MusicPlayer (Vite + Electron)...
echo  Close this window or press Ctrl+C to stop.
echo ======================================================================
call npm run electron:dev

endlocal
