; Custom NSIS macros for electron-builder. Ensures a clean slate
; before install / uninstall touches any files — no "MusicPlayer
; cannot be closed" dialog, no handle-locked .node files, no lingering
; helper processes holding the install dir open.
;
; Five-layer escalation, all run from customInit / customUnInit so
; the user never has to intervene:
;
;   1. taskkill every plausible image name (not just MusicPlayer.exe):
;        - MusicPlayer.exe          — main + Chromium helpers
;        - "Uninstall MusicPlayer.exe" — the prior install's uninstaller
;        - Un_A.exe / Au_.exe       — NSIS temp-copy uninstallers in %TEMP%
;        - ffmpeg.exe               — our child from Shrink / tag rewriter
;
;   2. 1.5-second sleep. Windows keeps executable file mappings alive
;      for a moment after process exit and NSIS's FindProcess snapshot
;      lags the kernel's actual state; this gap lets both catch up.
;
;   3. PowerShell module-scan sweep: finds ANY process whose loaded
;      modules (DLLs / .node files) live inside the install dir, then
;      Stop-Process -Force. Catches invisible helpers with no window
;      that are still holding better_sqlite3.node or similar.
;
;   4. 1-second settling pause before NSIS's post-init running-check
;      fires, so the process table snapshot it reads is clean.
;
; NOTE: an earlier version also did a `MainWindowTitle -like '*usicPlayer*'`
; sweep as a final catch-all. That was a footgun: any browser tab on
; "github.com/SixOfFive/musicplayer" had "musicplayer" in its window
; title, and the wildcard match killed the user's whole browser
; mid-download. Removed -- the targeted taskkill calls above + the
; module-scan are sufficient.
;
; PowerShell is on every supported Windows install (7+). The -NoProfile
; / -ExecutionPolicy Bypass flags keep it from being blocked by
; corporate group policy that disables scripts by default.
;
; NSIS-isms worth noting:
;   - Backtick string delimiters (introduced in NSIS 3) let us embed
;     single AND double quotes inside the command without escaping hell.
;   - `$$` escapes the NSIS-level `$` so PowerShell variables like
;     `$_` and `$t` reach PowerShell unmolested — NSIS treats a single
;     `$` as its own variable-interpolation prefix.

!macro mpKillStraysOnce
  nsExec::Exec 'taskkill /F /IM "MusicPlayer.exe" /T'
  nsExec::Exec 'taskkill /F /IM "Uninstall MusicPlayer.exe" /T'
  nsExec::Exec 'taskkill /F /IM "Un_A.exe" /T'
  nsExec::Exec 'taskkill /F /IM "Au_.exe" /T'
  nsExec::Exec 'taskkill /F /IM "ffmpeg.exe" /T'

  Sleep 1500

  ; Module-scan sweep. Finds any process whose loaded modules live
  ; inside our install dir and force-stops it. Wrapped in an outer
  ; try/catch so a Modules-access exception on a protected process
  ; (e.g. System.exe) doesn't abort the whole cleanup.
  ;
  ; Window-title sweep was REMOVED: a wildcard `*usicPlayer*` match
  ; on MainWindowTitle killed the user's Chrome browser when they
  ; were on the GitHub releases page during install. The module
  ; sweep alone is sufficient -- nothing outside our install dir
  ; should be loading our DLLs.
  nsExec::Exec `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $$t = [Environment]::GetFolderPath('LocalApplicationData') + '\Programs\musicplayer'; Get-Process | Where-Object { try { $$_.Modules | Where-Object { $$_.FileName -like ($$t + '*') } } catch { $$false } } | ForEach-Object { Stop-Process -Id $$_.Id -Force -ErrorAction SilentlyContinue } } catch {}`

  Sleep 800
!macroend

; Run the whole cleanup sequence TWICE. Why the second pass matters
; specifically for the auto-update path: electron-updater's
; quitAndInstall spawns the new installer as a detached child WHILE
; the old app is still shutting down. During that ~1-2 second window
; Chromium may re-spawn a utility / GPU helper during its own
; teardown, or our before-quit handler may spin up an ffmpeg sibling
; to flush a pending tag write. First pass catches the mainline
; state; second pass catches anything the first pass's kill cascade
; accidentally triggered.
!macro mpKillStrays
  !insertmacro mpKillStraysOnce
  !insertmacro mpKillStraysOnce
!macroend

!macro customInit
  !insertmacro mpKillStrays
!macroend

!macro customUnInit
  !insertmacro mpKillStrays
!macroend
