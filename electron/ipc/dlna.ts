import type { IpcMain, BrowserWindow } from 'electron';
import { IPC } from '../../shared/types';
import {
  listDlnaDevices,
  startDlnaDiscovery,
  dlnaPlay,
  dlnaPause,
  dlnaResume,
  dlnaStop,
  dlnaSetVolume,
  dlnaSeek,
  dlnaActiveDeviceId,
  onDlnaStatus,
  onDlnaScanProgress,
  onDlnaIncomingMedia,
  setReceiverState,
  type DlnaStatusUpdate,
  type DlnaScanProgress,
  type DlnaIncomingMedia,
} from '../services/dlna';

/**
 * DLNA IPC handlers. Structure parallels the Cast/HA IPCs:
 *
 *   - listing + transport handlers invoked by the renderer
 *   - push channels forwarded from main-side listeners into BrowserWindow
 *   - one renderer → main channel (DLNA_RECEIVER_STATE) so the
 *     `<audio>` element can tell main what transport state + position
 *     to report back to DLNA senders that poll us
 *
 * All handlers are soft-fail: a thrown error is logged + swallowed into
 * the IPC response, never propagated up to the renderer as an "Error
 * invoking remote method" rejection. The service itself already
 * swallows SOAP failures in its safeSoap wrapper; this is the second
 * belt + suspenders layer so a misbehaving DLNA device can't take the
 * app down.
 */
export function registerDlnaIpc(ipcMain: IpcMain, getWin: () => BrowserWindow | null) {
  // Forward status-poll updates (sender side) to the renderer.
  onDlnaStatus((u: DlnaStatusUpdate) => {
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.DLNA_STATUS, u);
  });

  // Forward initial-scan progress ticks.
  onDlnaScanProgress((p: DlnaScanProgress) => {
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.DLNA_SCAN, p);
  });

  // Forward incoming media URLs pushed at our RECEIVER by remote senders.
  // The renderer loads the URL into the audio engine the same way a
  // radio stream would be; our `<audio>` element becomes the actual
  // playback implementation for whoever cast to us.
  onDlnaIncomingMedia((m: DlnaIncomingMedia) => {
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.DLNA_INCOMING, m);
  });

  ipcMain.handle(IPC.DLNA_LIST, () => {
    try { return listDlnaDevices(); }
    catch (err: any) {
      process.stdout.write(`[dlna-ipc] list error: ${err?.message ?? err}\n`);
      return [];
    }
  });

  // User-triggered rescan. Called when the output picker opens so the
  // scan indicator shows up on every invocation, not just at app boot.
  // startDlnaDiscovery is idempotent — re-fires M-SEARCH + restarts
  // the progress-tick loop without tearing down the SSDP client.
  ipcMain.handle(IPC.DLNA_RESCAN, () => {
    try { startDlnaDiscovery(); }
    catch (err: any) { process.stdout.write(`[dlna-ipc] rescan error: ${err?.message ?? err}\n`); }
  });

  ipcMain.handle(IPC.DLNA_PLAY, async (_e, deviceId: string, filePath: string, meta?: { title?: string; artist?: string; album?: string }) => {
    process.stdout.write(`[dlna-ipc] play request | deviceId=${deviceId} | file=${filePath}\n`);
    try {
      await dlnaPlay(deviceId, filePath, meta);
      process.stdout.write(`[dlna-ipc] play resolved\n`);
    } catch (err: any) {
      process.stdout.write(`[dlna-ipc] play FAILED: ${err?.message ?? err}\n`);
      throw err; // renderer's picker needs to know to bail back to local
    }
  });

  ipcMain.handle(IPC.DLNA_PAUSE,      () => dlnaPause());
  ipcMain.handle(IPC.DLNA_RESUME,     () => dlnaResume());
  ipcMain.handle(IPC.DLNA_STOP,       () => dlnaStop());
  ipcMain.handle(IPC.DLNA_SET_VOLUME, (_e, level: number)   => dlnaSetVolume(Number(level)));
  ipcMain.handle(IPC.DLNA_SEEK,       (_e, seconds: number) => dlnaSeek(Number(seconds)));
  ipcMain.handle(IPC.DLNA_ACTIVE,     () => dlnaActiveDeviceId());

  // Renderer → main: tell the DLNA receiver what state to report to
  // external senders polling us. Minimally PLAYING / PAUSED / STOPPED +
  // current position/duration for GetPositionInfo responses.
  ipcMain.handle(IPC.DLNA_RECEIVER_STATE, (_e, state: {
    transport?: 'PLAYING' | 'PAUSED_PLAYBACK' | 'STOPPED' | 'TRANSITIONING';
    positionSec?: number;
    durationSec?: number;
    currentUri?: string;
  }) => {
    setReceiverState(state);
  });
}
