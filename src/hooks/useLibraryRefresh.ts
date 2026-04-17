import { useEffect } from 'react';

/**
 * Subscribe to library-change signals. Fires whenever:
 *  - a track/album is deleted (TrackRow dispatches `mp-library-changed`)
 *  - a scan finishes (pushed by Electron main via scan:progress phase === 'done')
 *
 * Views use this to re-fetch their data without polling.
 */
export function useLibraryRefresh(cb: () => void) {
  useEffect(() => {
    const onChange = () => cb();
    window.addEventListener('mp-library-changed', onChange);
    const offProgress = window.mp.scan.onProgress((p: any) => {
      if (p?.phase === 'done') onChange();
    });
    return () => {
      window.removeEventListener('mp-library-changed', onChange);
      offProgress?.();
    };
  // We intentionally re-subscribe on every cb identity change (caller controls memo).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cb]);
}
