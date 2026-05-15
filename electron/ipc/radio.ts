import type { IpcMain, BrowserWindow } from 'electron';
import { IPC } from '../../shared/types';
import * as rb from '../services/radio-browser';
import { RadioMetadataSniffer } from '../services/radio-metadata';

// Only ever one sniffer active — stations are singular ("one current station
// playing"). start replaces the previous; stop cleans up.
let activeSniffer: RadioMetadataSniffer | null = null;
let activeUrl: string | null = null;

export function registerRadioIpc(ipcMain: IpcMain, getWin: () => BrowserWindow | null) {
  ipcMain.handle(IPC.RADIO_TOP, (_e, limit: number = 50) => rb.topStations(limit));
  ipcMain.handle(IPC.RADIO_TRENDING, (_e, limit: number = 50) => rb.trendingStations(limit));
  ipcMain.handle(IPC.RADIO_SEARCH, (_e, q: string, limit: number = 100) => rb.searchStations(q, limit));
  ipcMain.handle(IPC.RADIO_BY_TAG, (_e, tag: string, limit: number = 100) => rb.stationsByTag(tag, limit));
  ipcMain.handle(IPC.RADIO_BY_COUNTRY, (_e, cc: string, limit: number = 100) => rb.stationsByCountry(cc, limit));
  ipcMain.handle(IPC.RADIO_TAGS, (_e, limit: number = 100) => rb.popularTags(limit));
  ipcMain.handle(IPC.RADIO_CLICK, (_e, stationuuid: string) => rb.registerClick(stationuuid));

  // ICY metadata sniff — starts a parallel HTTP connection with `Icy-MetaData: 1`
  // and pushes StreamTitle values to the renderer. The renderer's audio
  // element still handles actual playback; this is purely metadata scraping.
  ipcMain.handle(IPC.RADIO_START_SNIFF, (_e, streamUrl: string) => {
    if (activeSniffer && activeUrl === streamUrl) return; // already sniffing this station
    if (activeSniffer) { activeSniffer.stop(); activeSniffer = null; activeUrl = null; }
    if (!streamUrl) return;

    // HLS has its own metadata scheme (in-segment ID3). Skip ICY for .m3u8 —
    // sniffer would just fail the content-type sniff and waste a request.
    if (/\.m3u8(\?|$)/i.test(streamUrl)) return;

    const sniffer = new RadioMetadataSniffer(streamUrl, (title) => {
      const win = getWin();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.RADIO_NOW_PLAYING, { streamUrl, title });
      }
    });
    activeSniffer = sniffer;
    activeUrl = streamUrl;
    sniffer.start();
  });

  ipcMain.handle(IPC.RADIO_STOP_SNIFF, () => {
    if (activeSniffer) { activeSniffer.stop(); activeSniffer = null; activeUrl = null; }
  });
}

/**
 * Tear down any active radio metadata sniffer. Called from main's
 * before-quit. The sniffer holds a long-lived HTTP connection to the
 * stream URL — if we don't kill it explicitly, the open socket can
 * keep the process alive past quit time, especially on Windows where
 * a half-closed TCP socket can block app exit for several seconds.
 */
export function shutdownRadioSniffer(): void {
  if (activeSniffer) {
    try { activeSniffer.stop(); } catch { /* noop */ }
    activeSniffer = null;
    activeUrl = null;
  }
}
