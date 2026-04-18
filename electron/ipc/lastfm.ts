import type { IpcMain } from 'electron';
import { shell } from 'electron';
import { IPC, type LastFmPeriod, type ScrobbleInput } from '../../shared/types';
import * as lfm from '../services/lastfm';

export function registerLastFmIpc(ipcMain: IpcMain) {
  ipcMain.handle(IPC.LASTFM_STATUS, () => lfm.status());

  ipcMain.handle(IPC.LASTFM_BEGIN_AUTH, async () => {
    const res = await lfm.beginAuth();
    // Open the user's default browser to the Last.fm auth page — renderer
    // would also work via window.open, but keeping it in main means we don't
    // open a new Electron window for it.
    await shell.openExternal(res.authUrl);
    return res;
  });

  ipcMain.handle(IPC.LASTFM_FINISH_AUTH, (_e, token: string) => lfm.finishAuth(token));
  ipcMain.handle(IPC.LASTFM_DISCONNECT, () => lfm.disconnect());
  ipcMain.handle(IPC.LASTFM_SET_KEYS, (_e, apiKey: string, apiSecret: string) => lfm.setKeys(apiKey, apiSecret));
  ipcMain.handle(IPC.LASTFM_SET_SCROBBLE, (_e, enabled: boolean) => lfm.setScrobbleEnabled(enabled));

  ipcMain.handle(IPC.LASTFM_PROFILE, () => lfm.getProfile());
  ipcMain.handle(IPC.LASTFM_USER_TOP_ARTISTS, (_e, p: LastFmPeriod, limit?: number) => lfm.getTopArtists(p, limit));
  ipcMain.handle(IPC.LASTFM_USER_TOP_TRACKS, (_e, p: LastFmPeriod, limit?: number) => lfm.getTopTracks(p, limit));
  ipcMain.handle(IPC.LASTFM_USER_TOP_ALBUMS, (_e, p: LastFmPeriod, limit?: number) => lfm.getTopAlbums(p, limit));
  ipcMain.handle(IPC.LASTFM_USER_RECENT, (_e, limit?: number) => lfm.getRecentTracks(limit));

  ipcMain.handle(IPC.LASTFM_CHARTS_ARTISTS, (_e, limit?: number) => lfm.getChartTopArtists(limit));
  ipcMain.handle(IPC.LASTFM_CHARTS_TRACKS, (_e, limit?: number) => lfm.getChartTopTracks(limit));

  ipcMain.handle(IPC.LASTFM_NOW_PLAYING, (_e, input: Omit<ScrobbleInput, 'playedAt'>) => lfm.updateNowPlaying(input));
  ipcMain.handle(IPC.LASTFM_SCROBBLE, (_e, input: ScrobbleInput) => lfm.scrobble(input));
}

// Exported for the player store to call directly.
export const scrobbler = {
  updateNowPlaying: lfm.updateNowPlaying,
  scrobble: lfm.scrobble,
};
