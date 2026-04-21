// Global media-key registration. Binds the hardware buttons on
// keyboards / headphones / remote controls that the OS exposes as
// "media keys" (Play/Pause, Next Track, Previous Track, Stop) to our
// app so they work even when the MusicPlayer window isn't focused.
//
// Electron's `globalShortcut` accepts well-known accelerators for these
// —  'MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack',
// 'MediaStop' — and wires up to the OS on our behalf. On Windows this
// registers a low-level keyboard hook for the corresponding VK codes;
// on macOS it registers a Media key event handler; on Linux it picks
// up XF86Audio* keysyms.
//
// Two important nuances:
//
//   1. Hardware keys are a SINGLE-APP SYSTEM RESOURCE. Only one app on
//      the machine can own them at a time. The first registrant wins.
//      Spotify / iTunes / Apple Music usually grab them at launch, so
//      if they're already running and registered, our register() call
//      silently returns false. We report that to stdout so the user
//      can diagnose "why don't my media keys work in MusicPlayer?"
//
//   2. navigator.mediaSession in the RENDERER is the other half of
//      this — OS integrations like Windows' SMTC widget, macOS' Now
//      Playing panel, Linux MPRIS, Bluetooth headphone controls, all
//      route through Chromium's media-session plumbing regardless of
//      who owns the globalShortcut. So even if Spotify has the keys,
//      the OS widget still knows about our playback and can control
//      it. See src/lib/mediaSession.ts.

import { app, globalShortcut, type BrowserWindow } from 'electron';
import { IPC, type MediaKeyAction } from '../../shared/types';

const ACCELERATORS: Record<MediaKeyAction, string> = {
  'play-pause': 'MediaPlayPause',
  'next':       'MediaNextTrack',
  'prev':       'MediaPreviousTrack',
  'stop':       'MediaStop',
};

/** Track which accelerators we successfully registered so `unregister`
 *  only touches ours (don't want to yank another app's shortcuts if
 *  they overlap — though globalShortcut's ownership model prevents
 *  that, this is belt + suspenders). */
const ownedAccelerators = new Set<string>();

/**
 * Register all four media-key accelerators. Each handler sends the
 * corresponding action name to the renderer via IPC, where the player
 * store picks it up and invokes the appropriate transport function.
 *
 * If `registrationPolicy` (rare) or another app already owns a key,
 * `globalShortcut.register` returns `false`. We log each outcome so
 * `[media-keys]` lines in stdout tell the user exactly which keys were
 * captured and which were already claimed.
 */
export function registerMediaKeys(getWin: () => BrowserWindow | null): void {
  for (const [action, accel] of Object.entries(ACCELERATORS) as [MediaKeyAction, string][]) {
    const ok = globalShortcut.register(accel, () => {
      const win = getWin();
      if (!win || win.isDestroyed()) return;
      win.webContents.send(IPC.MEDIA_KEY, action);
    });
    if (ok) {
      ownedAccelerators.add(accel);
      process.stdout.write(`[media-keys] bound ${accel} → ${action}\n`);
    } else {
      // Typical cause on Windows: Spotify.exe is running and holds the
      // keys. On macOS: iTunes / Music.app has them. User-fixable by
      // quitting the other app — not something we can do anything
      // about programmatically.
      process.stdout.write(`[media-keys] could NOT bind ${accel} (another app owns it)\n`);
    }
  }

  // Release on quit. globalShortcut state persists in the OS even
  // after our process dies on some platforms, so being explicit avoids
  // leaving phantom registrations behind after crashes.
  app.on('will-quit', unregisterMediaKeys);
}

export function unregisterMediaKeys(): void {
  for (const accel of ownedAccelerators) {
    try { globalShortcut.unregister(accel); } catch { /* best effort */ }
  }
  ownedAccelerators.clear();
}
