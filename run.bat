@echo off
setlocal

REM MusicPlayer - Windows launcher
REM First run: installs dependencies and rebuilds native modules for Electron.
REM Subsequent runs: just starts the dev environment (Vite + Electron).

cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm was not found on PATH. Install Node.js LTS from https://nodejs.org and retry.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo ======================================================================
    echo  First run detected - installing dependencies. This can take a while.
    echo ======================================================================
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )

    echo ======================================================================
    echo  Rebuilding native modules against Electron's Node ABI...
    echo ======================================================================
    call npm run rebuild
    if errorlevel 1 (
        echo [WARN] electron-rebuild failed. If the app errors out loading better-sqlite3,
        echo        run "npm run rebuild" manually.
    )
)

echo ======================================================================
echo  Starting MusicPlayer (Vite + Electron)...
echo  Close this window or press Ctrl+C to stop.
echo ======================================================================
call npm run electron:dev

endlocal
