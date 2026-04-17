import type { IpcMain } from 'electron';
import { IPC } from '../../shared/types';
import { getSettings, updateSettings } from '../services/settings-store';

export function registerSettingsIpc(ipcMain: IpcMain) {
  ipcMain.handle(IPC.SETTINGS_GET, () => getSettings());
  ipcMain.handle(IPC.SETTINGS_SET, (_e, patch) => updateSettings(patch));
}
