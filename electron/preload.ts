import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/types';

const api = {
  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (patch: unknown) => ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
  },
  library: {
    listDirs: () => ipcRenderer.invoke(IPC.LIBRARY_LIST_DIRS),
    addDir: (p: string) => ipcRenderer.invoke(IPC.LIBRARY_ADD_DIR, p),
    removeDir: (id: number) => ipcRenderer.invoke(IPC.LIBRARY_REMOVE_DIR, id),
    pickDir: () => ipcRenderer.invoke(IPC.LIBRARY_PICK_DIR),
    tracks: (opts?: import('../shared/types').TrackQuery) =>
      ipcRenderer.invoke(IPC.LIBRARY_TRACKS, opts ?? {}),
    albums: (opts?: import('../shared/types').AlbumQuery) =>
      ipcRenderer.invoke(IPC.LIBRARY_ALBUMS, opts ?? {}),
    deleteTrack: (id: number, deleteFile?: boolean) => ipcRenderer.invoke(IPC.LIBRARY_DELETE_TRACK, id, !!deleteFile),
    deleteAlbum: (id: number, deleteFiles?: boolean) => ipcRenderer.invoke(IPC.LIBRARY_DELETE_ALBUM, id, !!deleteFiles),
    defaultMusicDir: () => ipcRenderer.invoke(IPC.FIRST_RUN_DEFAULT_DIR),
    stats: () => ipcRenderer.invoke(IPC.LIBRARY_STATS),
    artists: () => ipcRenderer.invoke(IPC.LIBRARY_ARTISTS),
    artist: (id: number) => ipcRenderer.invoke(IPC.LIBRARY_ARTIST, id),
    album: (id: number) => ipcRenderer.invoke(IPC.LIBRARY_ALBUM, id),
    search: (q: string) => ipcRenderer.invoke(IPC.LIBRARY_SEARCH, q),
    fileUrl: (p: string) => ipcRenderer.invoke(IPC.PLAYBACK_FILE_URL, p),
  },
  scan: {
    start: () => ipcRenderer.invoke(IPC.SCAN_START),
    cancel: () => ipcRenderer.invoke(IPC.SCAN_CANCEL),
    onProgress: (cb: (p: unknown) => void) => {
      const listener = (_: unknown, payload: unknown) => cb(payload);
      ipcRenderer.on(IPC.SCAN_PROGRESS, listener);
      return () => ipcRenderer.removeListener(IPC.SCAN_PROGRESS, listener);
    },
  },
  metadata: {
    providers: () => ipcRenderer.invoke(IPC.META_PROVIDERS),
    testProvider: (id: string) => ipcRenderer.invoke(IPC.META_TEST_PROVIDER, id),
  },
  visualizer: {
    list: () => ipcRenderer.invoke(IPC.VIS_LIST),
    scanDirs: (dirs: string[]) => ipcRenderer.invoke(IPC.VIS_SCAN_DIRS, dirs),
    readPreset: (src: string) => ipcRenderer.invoke(IPC.VIS_READ_PRESET, src),
    openDir: (dir: string) => ipcRenderer.invoke(IPC.VIS_OPEN_DIR, dir),
  },
  playlists: {
    list: () => ipcRenderer.invoke(IPC.PL_LIST),
    create: (name: string, description?: string | null) => ipcRenderer.invoke(IPC.PL_CREATE, name, description ?? null),
    rename: (id: number, name: string, description: string | null) => ipcRenderer.invoke(IPC.PL_RENAME, id, name, description),
    remove: (id: number) => ipcRenderer.invoke(IPC.PL_DELETE, id),
    get: (id: number) => ipcRenderer.invoke(IPC.PL_GET, id),
    addTracks: (id: number, trackIds: number[]) => ipcRenderer.invoke(IPC.PL_ADD_TRACKS, id, trackIds),
    removeTracks: (id: number, trackIds: number[]) => ipcRenderer.invoke(IPC.PL_REMOVE_TRACKS, id, trackIds),
    reorder: (id: number, ids: number[]) => ipcRenderer.invoke(IPC.PL_REORDER, id, ids),
    exportAll: () => ipcRenderer.invoke(IPC.PL_EXPORT_ALL),
    importFromFolder: () => ipcRenderer.invoke(IPC.PL_IMPORT_FROM_FOLDER),
  },
  likes: {
    toggle: (trackId: number) => ipcRenderer.invoke(IPC.LIKE_TOGGLE, trackId),
    list: () => ipcRenderer.invoke(IPC.LIKE_LIST),
  },
  stats: {
    recordPlay: (trackId: number, listenedSec: number, completed: boolean) =>
      ipcRenderer.invoke(IPC.STATS_RECORD_PLAY, trackId, listenedSec, completed),
    overview: () => ipcRenderer.invoke(IPC.STATS_OVERVIEW),
  },
  update: {
    info: () => ipcRenderer.invoke(IPC.UPDATE_INFO),
    check: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),
    apply: () => ipcRenderer.invoke(IPC.UPDATE_APPLY),
    onAutoEvent: (cb: (e: unknown) => void) => {
      const listener = (_: unknown, payload: unknown) => cb(payload);
      ipcRenderer.on('update:auto-event', listener);
      return () => ipcRenderer.removeListener('update:auto-event', listener);
    },
  },
  debug: {
    toggleDevTools: () => ipcRenderer.invoke(IPC.DEBUG_TOGGLE_DEVTOOLS),
  },
  lastfm: {
    status: () => ipcRenderer.invoke(IPC.LASTFM_STATUS),
    beginAuth: () => ipcRenderer.invoke(IPC.LASTFM_BEGIN_AUTH),
    finishAuth: (token: string) => ipcRenderer.invoke(IPC.LASTFM_FINISH_AUTH, token),
    disconnect: () => ipcRenderer.invoke(IPC.LASTFM_DISCONNECT),
    setKeys: (apiKey: string, apiSecret: string) => ipcRenderer.invoke(IPC.LASTFM_SET_KEYS, apiKey, apiSecret),
    setScrobble: (enabled: boolean) => ipcRenderer.invoke(IPC.LASTFM_SET_SCROBBLE, enabled),
    profile: () => ipcRenderer.invoke(IPC.LASTFM_PROFILE),
    userTopArtists: (period: string, limit?: number) => ipcRenderer.invoke(IPC.LASTFM_USER_TOP_ARTISTS, period, limit),
    userTopTracks: (period: string, limit?: number) => ipcRenderer.invoke(IPC.LASTFM_USER_TOP_TRACKS, period, limit),
    userTopAlbums: (period: string, limit?: number) => ipcRenderer.invoke(IPC.LASTFM_USER_TOP_ALBUMS, period, limit),
    userRecent: (limit?: number) => ipcRenderer.invoke(IPC.LASTFM_USER_RECENT, limit),
    chartsArtists: (limit?: number) => ipcRenderer.invoke(IPC.LASTFM_CHARTS_ARTISTS, limit),
    chartsTracks: (limit?: number) => ipcRenderer.invoke(IPC.LASTFM_CHARTS_TRACKS, limit),
    nowPlaying: (input: unknown) => ipcRenderer.invoke(IPC.LASTFM_NOW_PLAYING, input),
    scrobble: (input: unknown) => ipcRenderer.invoke(IPC.LASTFM_SCROBBLE, input),
  },
  radio: {
    top: (limit?: number) => ipcRenderer.invoke(IPC.RADIO_TOP, limit),
    trending: (limit?: number) => ipcRenderer.invoke(IPC.RADIO_TRENDING, limit),
    search: (q: string, limit?: number) => ipcRenderer.invoke(IPC.RADIO_SEARCH, q, limit),
    byTag: (tag: string, limit?: number) => ipcRenderer.invoke(IPC.RADIO_BY_TAG, tag, limit),
    byCountry: (cc: string, limit?: number) => ipcRenderer.invoke(IPC.RADIO_BY_COUNTRY, cc, limit),
    tags: (limit?: number) => ipcRenderer.invoke(IPC.RADIO_TAGS, limit),
    click: (uuid: string) => ipcRenderer.invoke(IPC.RADIO_CLICK, uuid),
  },
  convert: {
    checkAvailable: () => ipcRenderer.invoke(IPC.CONVERT_CHECK_AVAILABLE),
    albumToMp3: (albumId: number) => ipcRenderer.invoke(IPC.CONVERT_ALBUM_TO_MP3, albumId),
    cancel: () => ipcRenderer.invoke(IPC.CONVERT_CANCEL),
    onProgress: (cb: (p: unknown) => void) => {
      const listener = (_: unknown, p: unknown) => cb(p);
      ipcRenderer.on(IPC.CONVERT_PROGRESS, listener);
      return () => ipcRenderer.removeListener(IPC.CONVERT_PROGRESS, listener);
    },
  },
};

contextBridge.exposeInMainWorld('mp', api);

export type MpApi = typeof api;
