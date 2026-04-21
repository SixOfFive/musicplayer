import type { IpcMain, BrowserWindow } from 'electron';
import { IPC } from '../../shared/types';
import {
  haTestConnection,
  haListEntities,
  haPlay,
  haPause,
  haResume,
  haStop,
  haSetVolume,
  haSeek,
  haActiveEntityId,
  onHaStatus,
  type HaStatusUpdate,
} from '../services/homeassistant';

/**
 * Register Home Assistant IPC handlers. Parallels the Cast IPC layer
 * (electron/ipc/cast.ts) deliberately — same handler shapes, same
 * logging conventions — so the renderer's output picker can treat
 * both as interchangeable sinks beyond the first selection step.
 *
 * The HA service starts no background work at registration time: the
 * status poller only spins up once the user picks an HA target via
 * `ha:play`, and the entity list is only fetched when the renderer
 * asks via `ha:list`. Nothing happens on the network until then.
 */
export function registerHomeAssistantIpc(ipcMain: IpcMain, getWin: () => BrowserWindow | null) {
  // Forward every HA status update to the renderer. Same channel
  // separation as cast so a single IPC listener per side covers it.
  onHaStatus((u: HaStatusUpdate) => {
    const win = getWin();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.HA_STATUS, u);
    }
  });

  // Test baseUrl + token without touching persisted settings — used by
  // the settings panel's "Test connection" button so the user gets
  // immediate feedback before committing a save.
  ipcMain.handle(IPC.HA_TEST, async (_e, baseUrl: string, token: string) => {
    try {
      const r = await haTestConnection(baseUrl, token);
      process.stdout.write(`[ha-ipc] test OK (version=${r.version})\n`);
      return { ok: true, version: r.version };
    } catch (err: any) {
      // Surface the user-facing error but leave logging to haTestConnection
      // (already scrubs the token before forming the message).
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle(IPC.HA_LIST, () => haListEntities());

  ipcMain.handle(IPC.HA_PLAY, async (_e, entityId: string, filePath: string, meta?: { title?: string; artist?: string; album?: string }) => {
    process.stdout.write(`[ha-ipc] play request | entityId=${entityId} | file=${filePath}\n`);
    try {
      await haPlay(entityId, filePath, meta);
      process.stdout.write(`[ha-ipc] play resolved\n`);
    } catch (err: any) {
      // Log here with a recognisable prefix; re-throw so the renderer's
      // picker can bail back to local on failure. The renderer sees the
      // message string, not the token (haPlay / haRequest redact).
      process.stdout.write(`[ha-ipc] play FAILED: ${err?.message ?? err}\n`);
      throw err;
    }
  });

  ipcMain.handle(IPC.HA_PAUSE,      ()                          => haPause());
  ipcMain.handle(IPC.HA_RESUME,     ()                          => haResume());
  ipcMain.handle(IPC.HA_STOP,       ()                          => haStop());
  ipcMain.handle(IPC.HA_SET_VOLUME, (_e, level: number)         => haSetVolume(Number(level)));
  ipcMain.handle(IPC.HA_SEEK,       (_e, seconds: number)       => haSeek(Number(seconds)));
  ipcMain.handle(IPC.HA_ACTIVE,     ()                          => haActiveEntityId());
}
