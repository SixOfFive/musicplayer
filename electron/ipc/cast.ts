import type { IpcMain, BrowserWindow } from 'electron';
import { IPC } from '../../shared/types';
import {
  startDiscovery,
  listDevices,
  castPlay,
  castPause,
  castResume,
  castStop,
  castSetVolume,
  castSeek,
  castActiveDeviceId,
  onCastStatus,
  type CastStatusUpdate,
} from '../services/cast';

/**
 * Register Cast IPC handlers. The service (mDNS client, media server,
 * active-device state) is started lazily here rather than at app boot so
 * a user who never opens the output picker never pays for discovery
 * traffic on their LAN.
 */
export function registerCastIpc(ipcMain: IpcMain, getWin: () => BrowserWindow | null) {
  // Forward every cast-status update from the service to the renderer
  // via IPC push. The renderer's cast store relays these into player-
  // store updates so the scrubber + play/pause icon track what the
  // Cast device is actually doing.
  onCastStatus((u: CastStatusUpdate) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.CAST_STATUS, u);
    }
  });

  // Any renderer interaction with cast:* implies the user might want
  // to see devices — so kick off discovery the first time any of
  // these fires. Idempotent.
  const ensureStarted = () => { startDiscovery(); };

  ipcMain.handle(IPC.CAST_LIST, () => {
    ensureStarted();
    return listDevices();
  });

  ipcMain.handle(IPC.CAST_PLAY, async (_e, deviceId: string, filePath: string, meta?: { title?: string; artist?: string; album?: string; coverUrl?: string }) => {
    ensureStarted();
    process.stdout.write(`[cast-ipc] play request | deviceId=${deviceId} | file=${filePath}\n`);
    try {
      const r = await castPlay(deviceId, filePath, meta);
      process.stdout.write(`[cast-ipc] play resolved\n`);
      return r;
    } catch (err: any) {
      // Surface the error to the renderer so the picker bails back to
      // local sink — and log it here with a recognisable prefix so we
      // can tell at a glance whether the failure was discovery (device
      // went offline), network (HTTP server), or the Cast session
      // handshake itself.
      process.stdout.write(`[cast-ipc] play FAILED: ${err?.message ?? err}\n${err?.stack ?? ''}\n`);
      throw err;
    }
  });

  ipcMain.handle(IPC.CAST_PAUSE, () => castPause());
  ipcMain.handle(IPC.CAST_RESUME, () => castResume());
  ipcMain.handle(IPC.CAST_STOP, () => castStop());
  ipcMain.handle(IPC.CAST_SET_VOLUME, (_e, level: number) => castSetVolume(Number(level)));
  ipcMain.handle(IPC.CAST_SEEK, (_e, seconds: number) => castSeek(Number(seconds)));
  ipcMain.handle(IPC.CAST_ACTIVE, () => castActiveDeviceId());
}
