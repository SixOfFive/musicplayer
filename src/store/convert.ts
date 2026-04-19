// Conversion progress store.
//
// The FLAC → MP3 conversion runs in the main process and emits
// `convert:progress` events via IPC. Previously each <ShrinkAlbumButton>
// instance subscribed on mount and stored progress in local state —
// which broke two things:
//
//   1. Navigating away from the album view unmounted the button, lost
//      the progress state. Navigating back showed the button as idle
//      until the NEXT progress event arrived (a jarring "is it running
//      or not?" experience).
//
//   2. Multiple buttons for the same album (e.g. one on the album card
//      grid, one on the album detail page) each subscribed separately;
//      nothing coordinated them.
//
// Centralising progress into this store fixes both. The subscription is
// set up ONCE when the store initialises (module load), progress is
// stored keyed by albumId, and any component that hooks into the store
// reflects whatever the current state of the job is.

import { create } from 'zustand';
import type { ConvertProgress } from '../../shared/types';

interface ConvertState {
  // Latest progress per album. Cleared when the job for that album
  // enters a terminal phase (`done` / `error`) AND is older than a
  // short grace window (so the UI can show a "saved X MB" flash
  // before the button vanishes on the next library refresh).
  byAlbum: Map<number, ConvertProgress>;
  // Wall-clock timestamps (epoch ms) for the first progress event we
  // saw per album. Used to compute ETA from throughput in the UI.
  // Cleared when the album's job terminates.
  startedAt: Map<number, number>;

  setProgress(p: ConvertProgress): void;
  clear(albumId: number): void;
}

export const useConvert = create<ConvertState>((set) => ({
  byAlbum: new Map(),
  startedAt: new Map(),
  setProgress(p) {
    set((state) => {
      // Always use a fresh Map so Zustand's shallow equality triggers
      // a re-render. Mutating in place would silently fail.
      const next = new Map(state.byAlbum);
      const nextStarted = new Map(state.startedAt);
      if (p.albumId != null) {
        next.set(p.albumId, p);
        // Record the start time once per album. We re-record on
        // 'starting' so a re-attempt of the same album resets the
        // ETA basis instead of reusing a stale one from a prior run.
        if (!nextStarted.has(p.albumId) || p.phase === 'starting') {
          nextStarted.set(p.albumId, Date.now());
        }
      }
      return { byAlbum: next, startedAt: nextStarted };
    });
  },
  clear(albumId) {
    set((state) => {
      const next = new Map(state.byAlbum);
      const nextStarted = new Map(state.startedAt);
      next.delete(albumId);
      nextStarted.delete(albumId);
      return { byAlbum: next, startedAt: nextStarted };
    });
  },
}));

// One-time subscription — fires before any component that reads the
// store mounts. The Electron preload exposes `convert.onProgress`
// (ipcRenderer.on wrapper). Unsubscribe is intentionally never called:
// the subscription lives for the lifetime of the renderer.
if (typeof window !== 'undefined' && window.mp?.convert?.onProgress) {
  window.mp.convert.onProgress((p: any) => {
    if (p && typeof p === 'object' && typeof p.albumId === 'number') {
      useConvert.getState().setProgress(p as ConvertProgress);
    }
  });
}
