@echo off
REM ==========================================================================
REM  MusicPlayer — Windows force-reset helper
REM
REM  Unsticks the "MusicPlayer cannot be closed" NSIS installer loop when
REM  taskkill alone doesn't clear things. Runs through every way a stale
REM  instance can hide itself on Windows, in escalating order of severity,
REM  stopping as soon as the install dir becomes writable.
REM
REM  Usage: double-click. No admin required for per-user installs
REM  (perMachine: false in package.json). Elevate only if you originally
REM  did a per-machine install.
REM
REM  This script is non-destructive to your library / settings / playlists:
REM  it only touches processes and the Programs folder where the .exe
REM  lives. All user data in %APPDATA%\musicplayer\ is untouched.
REM ==========================================================================

setlocal enabledelayedexpansion
set "INSTALL_DIR=%LOCALAPPDATA%\Programs\musicplayer"
set "RENAMED_DIR=%LOCALAPPDATA%\Programs\musicplayer-old-%RANDOM%"

echo ========================================================================
echo  MusicPlayer — Windows force-reset
echo  Install dir: %INSTALL_DIR%
echo ========================================================================
echo.

REM --------------------------------------------------------------------------
REM  Step 1: kill every known image name variant.
REM
REM  MusicPlayer.exe  -- main process and every Chromium helper inherit this
REM  Uninstall MusicPlayer.exe  -- the uninstaller from a prior install
REM  Un_A.exe  -- NSIS's renamed temp uninstaller (runs from %TEMP%)
REM  Au_.exe   -- older NSIS temp uninstaller name
REM  ffmpeg.exe  -- our own child from Shrink-album / tag rewriter
REM --------------------------------------------------------------------------
echo [1/5] Killing known process names...
taskkill /F /IM "MusicPlayer.exe" /T >nul 2>&1
taskkill /F /IM "Uninstall MusicPlayer.exe" /T >nul 2>&1
taskkill /F /IM "Un_A.exe" /T >nul 2>&1
taskkill /F /IM "Au_.exe" /T >nul 2>&1
taskkill /F /IM "ffmpeg.exe" /T >nul 2>&1
echo      ...done.
echo.

REM --------------------------------------------------------------------------
REM  Step 2: kill any process whose main window title contains "MusicPlayer".
REM
REM  NSIS's "cannot close" check sometimes matches by window title rather
REM  than process image name. If a Chromium helper is running under a
REM  renamed image (rare but possible via some update paths) its window
REM  would still be titled "MusicPlayer" and this finds it.
REM --------------------------------------------------------------------------
echo [2/5] Searching for windows titled "MusicPlayer"...
powershell -NoProfile -Command ^
  "$procs = Get-Process | Where-Object { $_.MainWindowTitle -like '*usicPlayer*' };" ^
  "if ($procs) { $procs | ForEach-Object { Write-Host ('      killing PID {0} ({1}) — window: {2}' -f $_.Id, $_.ProcessName, $_.MainWindowTitle); Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } }" ^
  "else { Write-Host '      none found.' }"
echo.

REM --------------------------------------------------------------------------
REM  Step 3: kill any process with a DLL / .node module loaded from the
REM  install dir. Catches invisible helpers that have no window but are
REM  still holding file handles inside our Programs folder — commonly
REM  better_sqlite3.node or a Chromium utility process that orphaned.
REM --------------------------------------------------------------------------
echo [3/5] Searching for processes with modules loaded from install dir...
powershell -NoProfile -Command ^
  "$target = [System.Environment]::GetFolderPath('LocalApplicationData') + '\Programs\musicplayer';" ^
  "$matches = Get-Process | Where-Object { try { $_.Modules | Where-Object { $_.FileName -like ($target + '*') } } catch { $false } };" ^
  "if ($matches) { $matches | ForEach-Object { Write-Host ('      killing PID {0} ({1})' -f $_.Id, $_.ProcessName); Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } }" ^
  "else { Write-Host '      none found.' }"
echo.

REM --------------------------------------------------------------------------
REM  Step 4: brief pause. Windows takes a moment to release executable
REM  file mappings after process exit, especially on SSDs with Defender
REM  real-time scanning active. Two seconds is usually enough; if the
REM  rename attempt below fails, we escalate to handle.exe.
REM --------------------------------------------------------------------------
echo [4/5] Waiting 2s for OS to release file handles...
timeout /T 2 /NOBREAK >nul
echo.

REM --------------------------------------------------------------------------
REM  Step 5: try renaming the install dir. If Windows lets us, nothing
REM  holds a hard handle on anything inside it — the installer will
REM  succeed cleanly. If it fails, fetch Sysinternals handle.exe and
REM  tell the user exactly which PID is still holding something.
REM --------------------------------------------------------------------------
echo [5/5] Testing install-dir accessibility via rename...
if not exist "%INSTALL_DIR%" (
    echo      install dir doesn't exist — you can run the installer now.
    echo.
    echo ========================================================================
    echo  Done. Run MusicPlayer-Setup-*.exe to install.
    echo ========================================================================
    pause
    exit /b 0
)

move "%INSTALL_DIR%" "%RENAMED_DIR%" >nul 2>&1
if !errorlevel! equ 0 (
    echo      success — renamed to %RENAMED_DIR%
    echo      the installer will create a fresh musicplayer folder on next run.
    echo      delete the renamed folder manually once you've confirmed the new install works.
    echo.
    echo ========================================================================
    echo  Done. Run MusicPlayer-Setup-*.exe to install.
    echo ========================================================================
    pause
    exit /b 0
)

echo      FAILED — something is still holding a handle inside %INSTALL_DIR%.
echo.
echo ------------------------------------------------------------------------
echo  Escalating: fetching Sysinternals handle.exe to diagnose...
echo ------------------------------------------------------------------------
set "HANDLE_EXE=%TEMP%\handle.exe"
if not exist "%HANDLE_EXE%" (
    echo  downloading to %HANDLE_EXE%...
    curl --silent --location --fail --output "%HANDLE_EXE%" "https://live.sysinternals.com/handle.exe"
    if !errorlevel! neq 0 (
        echo  download failed. Manually grab handle.exe from:
        echo    https://learn.microsoft.com/sysinternals/downloads/handle
        echo  save it as %HANDLE_EXE% and re-run this script.
        pause
        exit /b 1
    )
)
echo.
echo  handles held inside %INSTALL_DIR%:
echo  ------------------------------------------------------------------------
"%HANDLE_EXE%" -accepteula -nobanner "%INSTALL_DIR%" 2>nul
echo  ------------------------------------------------------------------------
echo.
echo  Close / taskkill the process(es) listed above, then re-run this script.
echo  If a system process owns the handle, a reboot is the only cure.
echo.
pause
exit /b 1
