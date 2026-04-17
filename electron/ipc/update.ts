import type { IpcMain } from 'electron';
import { IPC } from '../../shared/types';
import { checkForUpdates, applyUpdate, getUpdateInfo } from '../services/updater';

export function registerUpdateIpc(ipcMain: IpcMain) {
  ipcMain.handle(IPC.UPDATE_INFO, () => getUpdateInfo());
  ipcMain.handle(IPC.UPDATE_CHECK, () => checkForUpdates());
  ipcMain.handle(IPC.UPDATE_APPLY, () => applyUpdate());
}
