import type { IpcMain } from 'electron';
import {
  getLyricsForTrack,
  setManualLyrics,
  clearLyricsForTrack,
  peekLyricsAvailable,
} from '../services/lyrics';

/**
 * IPC bridge for the LyricsPanel.
 *
 *   lyrics:get        → read-with-cache. Returns instantly when a cache
 *                       row exists; otherwise consults disk + LRCLib in
 *                       sequence and stores the result.
 *   lyrics:refetch    → bypass the cache. User clicked "Re-fetch" because
 *                       the wrong song matched, or they edited their
 *                       artist/title tags after a previous miss.
 *   lyrics:set-manual → user pasted lyrics into the textarea. Stored as
 *                       source='manual' so re-fetch doesn't clobber it.
 *   lyrics:clear      → drop cached row entirely; next open reruns the
 *                       full lookup.
 *
 * No progress events — every call is synchronous-feeling from the user's
 * perspective (LRCLib responses come back in <1s typically; the longest
 * legitimate wait is the 8s timeout in the service).
 */
export function registerLyricsIpc(ipcMain: IpcMain): void {
  ipcMain.handle('lyrics:get', async (_e, trackId: number) => {
    if (typeof trackId !== 'number' || trackId <= 0) return null;
    return getLyricsForTrack(trackId, false);
  });

  ipcMain.handle('lyrics:refetch', async (_e, trackId: number) => {
    if (typeof trackId !== 'number' || trackId <= 0) return null;
    return getLyricsForTrack(trackId, true);
  });

  ipcMain.handle('lyrics:set-manual', async (_e, trackId: number, raw: string) => {
    if (typeof trackId !== 'number' || trackId <= 0) return null;
    return setManualLyrics(trackId, String(raw ?? ''));
  });

  ipcMain.handle('lyrics:clear', async (_e, trackId: number) => {
    if (typeof trackId !== 'number' || trackId <= 0) return false;
    clearLyricsForTrack(trackId);
    return true;
  });

  // Cheap availability probe — used by NowPlayingBar to tint the
  // lyrics icon. Cache + disk only, never LRCLib.
  ipcMain.handle('lyrics:peek', async (_e, trackId: number) => {
    if (typeof trackId !== 'number' || trackId <= 0) return 'none';
    return peekLyricsAvailable(trackId);
  });
}
