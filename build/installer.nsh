; Custom NSIS macros for electron-builder. Protects the uninstall →
; reinstall dance that electron-updater runs during auto-update from
; being blocked by lingering MusicPlayer processes or child sockets.
;
; Symptom without this: user clicks "Restart to update", the new
; installer silently launches the old uninstaller, Windows can't
; delete one of the .node native modules because a background DLNA
; HTTP listener / mDNS socket / electron helper still has a handle,
; the uninstaller hangs or partially completes, and the user is left
; with a broken install that needs manual "install over" to recover.
;
; !macro customInit / customUnInit run at the very top of the installer
; and uninstaller respectively (before any file operations). taskkill
; /F kills forcefully, /T also walks the process tree so all electron
; helper processes (GPU, renderer, utility) go down together. We
; silence output and ignore errors because a "process not running"
; exit is not a failure — we just want a clean slate.

!macro customInit
  ; Two passes with a 1-second gap between them. The first pass kicks
  ; everything, the sleep lets Windows actually release the file
  ; handles on node_modules\*.node (better-sqlite3, ffmpeg-static),
  ; the second pass catches anything that was still shutting down
  ; during the first. 500ms wasn't always enough on slower disks —
  ; users reported silent install failures where MusicPlayer-Setup
  ; exited cleanly but nothing got replaced.
  nsExec::Exec 'taskkill /F /IM MusicPlayer.exe /T'
  Sleep 1000
  nsExec::Exec 'taskkill /F /IM MusicPlayer.exe /T'
  Sleep 500
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /IM MusicPlayer.exe /T'
  Sleep 1000
  nsExec::Exec 'taskkill /F /IM MusicPlayer.exe /T'
  Sleep 500
!macroend
