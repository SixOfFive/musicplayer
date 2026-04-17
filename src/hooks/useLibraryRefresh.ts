import { useEffect, useRef } from 'react';

/**
 * Subscribe to library-change signals. Fires whenever:
 *  - a track/album is deleted (TrackRow dispatches `mp-library-changed`)
 *  - a scan finishes (phase === 'done')
 *  - a cover art download lands (message === 'album-art-landed')
 *
 * Callbacks are debounced to at most one call per 750ms so Albums views with
 * many new covers don't re-query SQLite on every art-fetch event.
 */
export function useLibraryRefresh(cb: () => void) {
  const lastRun = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const debounced = () => {
      const now = Date.now();
      if (now - lastRun.current > 750) {
        lastRun.current = now;
        cb();
        return;
      }
      if (pending.current) return;
      pending.current = setTimeout(() => {
        pending.current = null;
        lastRun.current = Date.now();
        cb();
      }, 750);
    };

    const onChange = () => debounced();
    window.addEventListener('mp-library-changed', onChange);
    const offProgress = window.mp.scan.onProgress((p: any) => {
      if (p?.phase === 'done') debounced();
      else if (p?.message === 'album-art-landed') debounced();
    });
    return () => {
      window.removeEventListener('mp-library-changed', onChange);
      offProgress?.();
      if (pending.current) clearTimeout(pending.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cb]);
}
