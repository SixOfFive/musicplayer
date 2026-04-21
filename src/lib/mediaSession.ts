// OS-level media integration. Two sources feed into the same set of
// transport actions:
//
//   1. Electron globalShortcut from main — hardware media keys
//      (Play/Pause, Next, Prev, Stop on keyboards + Bluetooth
//      headsets + remotes) arrive on the `mediaKeys.onKey` push
//      channel.
//
//   2. Chromium's navigator.mediaSession — exposes our playback to
//      the OS-level "now playing" plumbing:
//        - Windows: System Media Transport Controls (the widget that
//          pops up when you press a media key + the Win 11 quick-
//          settings tile)
//        - macOS: Now Playing in Control Center + Touch Bar + the
//          on-screen media key overlay
//        - Linux: MPRIS2 over D-Bus (KDE / GNOME media applets,
//          playerctl, Bluetooth LE headset controls)
//
// Both paths route into the same player-store actions (toggle / next /
// prev / stop / seek). Metadata (title, artist, album, cover) is
// pushed via navigator.mediaSession.metadata whenever the current
// track changes, so the OS widget displays the right thing.
//
// Why this lives in a standalone module rather than inside the player
// store: the subscriptions are one-shot for the whole app lifetime,
// don't belong in component lifecycles, and the metadata-push side
// needs to observe player state changes which is a subscribe pattern
// that doesn't fit cleanly into Zustand's set() flow.

import { usePlayer } from '../store/player';
import { mediaUrl } from './mediaUrl';

type MediaAction = 'play-pause' | 'next' | 'prev' | 'stop';

/**
 * Dispatch a transport action. Source-agnostic: hardware key press,
 * mediaSession button tap, Bluetooth headphone, lock screen, they all
 * arrive here. Logs with the source so we can tell them apart in
 * debugging.
 */
function dispatch(action: MediaAction, source: string): void {
  const p = usePlayer.getState();
  console.log(`[media] ${source} → ${action}`);
  switch (action) {
    case 'play-pause': p.toggle(); break;
    case 'next':       void p.next(); break;
    case 'prev':       void p.prev(); break;
    case 'stop':
      // We don't expose a "stop" in the UI (just pause), so map stop
      // to pause here. Some Bluetooth devices distinguish pause vs
      // stop but most users don't — aligning them keeps behaviour
      // predictable.
      if (p.isPlaying) p.toggle();
      break;
  }
}

export function initMediaSession(): void {
  if (typeof window === 'undefined') return;

  // --- Hardware media keys via main-process globalShortcut ---------------
  const mk: any = (window.mp as any).mediaKeys;
  if (mk?.onKey) {
    mk.onKey((action: MediaAction) => dispatch(action, 'hw-key'));
  }

  // --- navigator.mediaSession: OS-level "now playing" --------------------
  // Action handlers: the OS widget sends these when the user taps
  // play/pause/next/prev in the system UI or on their headphones.
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play',          () => dispatch('play-pause', 'mediaSession:play'));
      navigator.mediaSession.setActionHandler('pause',         () => dispatch('play-pause', 'mediaSession:pause'));
      navigator.mediaSession.setActionHandler('nexttrack',     () => dispatch('next', 'mediaSession:next'));
      navigator.mediaSession.setActionHandler('previoustrack', () => dispatch('prev', 'mediaSession:prev'));
      navigator.mediaSession.setActionHandler('stop',          () => dispatch('stop', 'mediaSession:stop'));
      // seekto gets called when the user scrubs the OS widget's
      // timeline. We mirror that through the same seek() action the
      // in-app scrubber uses, so Cast / HA / DLNA routing all kicks
      // in identically.
      navigator.mediaSession.setActionHandler('seekto', (e) => {
        if (typeof e.seekTime === 'number') {
          usePlayer.getState().seek(e.seekTime);
        }
      });
    } catch (err: any) {
      // Older Chromium versions lack some action types ('stop' was
      // added later than 'play'/'pause'). `setActionHandler` throws
      // on unknown action names rather than silently skipping, so
      // wrap the whole block and log.
      console.warn('[media] setActionHandler failed:', err?.message ?? err);
    }

    // Keep playbackState in sync with the store so the OS widget
    // shows the right ▶ / ⏸ glyph without waiting for a state change
    // event from us.
    usePlayer.subscribe((s, prev) => {
      if (s.isPlaying === prev.isPlaying) return;
      try {
        navigator.mediaSession.playbackState = s.isPlaying ? 'playing' : 'paused';
      } catch { /* older Chromium — harmless */ }
    });

    // Push track metadata to the OS widget whenever the current track
    // changes. We compare track IDs rather than queue index so repeat-
    // one + shuffle don't falsely trigger metadata churn.
    let lastTrackId: number | undefined;
    usePlayer.subscribe((s) => {
      const cur = s.queue[s.index];
      if (!cur || cur.id === lastTrackId) return;
      lastTrackId = cur.id;
      const artwork = cur.coverArtPath
        ? [{ src: mediaUrl(cur.coverArtPath) ?? '', sizes: '512x512', type: 'image/jpeg' }]
        : [];
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title:  cur.title || 'Unknown',
          artist: cur.artist ?? 'Unknown artist',
          album:  cur.album ?? '',
          artwork,
        });
      } catch { /* some Chromium builds choke on empty artwork arrays */ }
    });

    // Periodically publish position state so the OS widget's timeline
    // tracks our scrubber. 1 Hz is enough — matches the Cast / HA /
    // DLNA remote-sink polls. setPositionState throws if duration
    // isn't finite, so guard.
    setInterval(() => {
      const s = usePlayer.getState();
      if (!Number.isFinite(s.duration) || s.duration <= 0) return;
      try {
        navigator.mediaSession.setPositionState?.({
          duration: s.duration,
          position: Math.min(s.position, s.duration),
          playbackRate: 1,
        });
      } catch { /* noop — invalid states are common during track changes */ }
    }, 1000);

    console.log('[media] navigator.mediaSession handlers wired');
  } else {
    console.log('[media] navigator.mediaSession not available in this Chromium build');
  }
}
