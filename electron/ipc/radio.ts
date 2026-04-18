import type { IpcMain } from 'electron';
import { IPC } from '../../shared/types';
import * as rb from '../services/radio-browser';

export function registerRadioIpc(ipcMain: IpcMain) {
  ipcMain.handle(IPC.RADIO_TOP, (_e, limit: number = 50) => rb.topStations(limit));
  ipcMain.handle(IPC.RADIO_TRENDING, (_e, limit: number = 50) => rb.trendingStations(limit));
  ipcMain.handle(IPC.RADIO_SEARCH, (_e, q: string, limit: number = 100) => rb.searchStations(q, limit));
  ipcMain.handle(IPC.RADIO_BY_TAG, (_e, tag: string, limit: number = 100) => rb.stationsByTag(tag, limit));
  ipcMain.handle(IPC.RADIO_BY_COUNTRY, (_e, cc: string, limit: number = 100) => rb.stationsByCountry(cc, limit));
  ipcMain.handle(IPC.RADIO_TAGS, (_e, limit: number = 100) => rb.popularTags(limit));
  ipcMain.handle(IPC.RADIO_CLICK, (_e, stationuuid: string) => rb.registerClick(stationuuid));
}
