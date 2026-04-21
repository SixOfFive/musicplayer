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
    largestAlbums: (limit?: number) => ipcRenderer.invoke(IPC.LIBRARY_LARGEST_ALBUMS, limit ?? 25),
    migrateCoverArt: () => ipcRenderer.invoke(IPC.LIBRARY_MIGRATE_COVER_ART),
    revealInFolder: (targetPath: string) => ipcRenderer.invoke(IPC.LIBRARY_REVEAL_IN_FOLDER, targetPath),
    fileUrl: (p: string) => ipcRenderer.invoke(IPC.PLAYBACK_FILE_URL, p),
  },
  scan: {
    start: () => ipcRenderer.invoke(IPC.SCAN_START),
    album: (albumId: number) => ipcRenderer.invoke(IPC.SCAN_ALBUM, albumId),
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
    startSniff: (streamUrl: string) => ipcRenderer.invoke(IPC.RADIO_START_SNIFF, streamUrl),
    stopSniff: () => ipcRenderer.invoke(IPC.RADIO_STOP_SNIFF),
    onNowPlaying: (cb: (payload: { streamUrl: string; title: string | null }) => void) => {
      const listener = (_: unknown, payload: any) => cb(payload);
      ipcRenderer.on(IPC.RADIO_NOW_PLAYING, listener);
      return () => ipcRenderer.removeListener(IPC.RADIO_NOW_PLAYING, listener);
    },
  },
  cast: {
    list: () => ipcRenderer.invoke(IPC.CAST_LIST),
    play: (deviceId: string, filePath: string, meta?: unknown) => ipcRenderer.invoke(IPC.CAST_PLAY, deviceId, filePath, meta),
    pause: () => ipcRenderer.invoke(IPC.CAST_PAUSE),
    resume: () => ipcRenderer.invoke(IPC.CAST_RESUME),
    stop: () => ipcRenderer.invoke(IPC.CAST_STOP),
    setVolume: (level: number) => ipcRenderer.invoke(IPC.CAST_SET_VOLUME, level),
    seek: (seconds: number) => ipcRenderer.invoke(IPC.CAST_SEEK, seconds),
    active: () => ipcRenderer.invoke(IPC.CAST_ACTIVE),
    // Main pushes cast status (currentTime/duration/playerState) via
    // this event whenever the active device sends a new status frame.
    onStatus: (cb: (payload: { currentTime: number; duration: number | null; playerState: string; deviceId: string }) => void) => {
      const listener = (_: unknown, p: any) => cb(p);
      ipcRenderer.on(IPC.CAST_STATUS, listener);
      return () => ipcRenderer.removeListener(IPC.CAST_STATUS, listener);
    },
  },
  // DLNA / UPnP sinks (sender + receiver). Same shape as cast/ha with
  // two extra push channels: scan progress (for the boot-time
  // discovery indicator) and incoming media (remote DLNA sender
  // pushing a URL at our receiver).
  dlna: {
    list: () => ipcRenderer.invoke(IPC.DLNA_LIST),
    rescan: () => ipcRenderer.invoke(IPC.DLNA_RESCAN),
    play: (deviceId: string, filePath: string, meta?: unknown) => ipcRenderer.invoke(IPC.DLNA_PLAY, deviceId, filePath, meta),
    pause: () => ipcRenderer.invoke(IPC.DLNA_PAUSE),
    resume: () => ipcRenderer.invoke(IPC.DLNA_RESUME),
    stop: () => ipcRenderer.invoke(IPC.DLNA_STOP),
    setVolume: (level: number) => ipcRenderer.invoke(IPC.DLNA_SET_VOLUME, level),
    seek: (seconds: number) => ipcRenderer.invoke(IPC.DLNA_SEEK, seconds),
    active: () => ipcRenderer.invoke(IPC.DLNA_ACTIVE),
    onStatus: (cb: (p: { deviceId: string; currentTime: number; duration: number | null; playerState: string }) => void) => {
      const listener = (_: unknown, p: any) => cb(p);
      ipcRenderer.on(IPC.DLNA_STATUS, listener);
      return () => ipcRenderer.removeListener(IPC.DLNA_STATUS, listener);
    },
    onScanProgress: (cb: (p: { elapsedMs: number; totalMs: number; found: number; done: boolean }) => void) => {
      const listener = (_: unknown, p: any) => cb(p);
      ipcRenderer.on(IPC.DLNA_SCAN, listener);
      return () => ipcRenderer.removeListener(IPC.DLNA_SCAN, listener);
    },
    onIncoming: (cb: (m: { uri: string; title?: string; artist?: string; album?: string }) => void) => {
      const listener = (_: unknown, m: any) => cb(m);
      ipcRenderer.on(IPC.DLNA_INCOMING, listener);
      return () => ipcRenderer.removeListener(IPC.DLNA_INCOMING, listener);
    },
    // Renderer tells main what transport state to report to external
    // DLNA senders polling our receiver.
    setReceiverState: (state: { transport?: 'PLAYING' | 'PAUSED_PLAYBACK' | 'STOPPED' | 'TRANSITIONING'; positionSec?: number; durationSec?: number; currentUri?: string }) =>
      ipcRenderer.invoke(IPC.DLNA_RECEIVER_STATE, state),
  },
  // Home Assistant sinks. Same surface as cast above, with one extra
  // handler (`test`) for the settings panel's "Test connection" button.
  // Never exposes the HA token to the renderer — the renderer passes
  // it on `test` only (before it's persisted); for every other handler
  // the main process reads the stored token itself.
  ha: {
    test: (baseUrl: string, token: string) => ipcRenderer.invoke(IPC.HA_TEST, baseUrl, token),
    list: () => ipcRenderer.invoke(IPC.HA_LIST),
    play: (entityId: string, filePath: string, meta?: unknown) => ipcRenderer.invoke(IPC.HA_PLAY, entityId, filePath, meta),
    pause: () => ipcRenderer.invoke(IPC.HA_PAUSE),
    resume: () => ipcRenderer.invoke(IPC.HA_RESUME),
    stop: () => ipcRenderer.invoke(IPC.HA_STOP),
    setVolume: (level: number) => ipcRenderer.invoke(IPC.HA_SET_VOLUME, level),
    seek: (seconds: number) => ipcRenderer.invoke(IPC.HA_SEEK, seconds),
    active: () => ipcRenderer.invoke(IPC.HA_ACTIVE),
    onStatus: (cb: (payload: { entityId: string; currentTime: number; duration: number | null; playerState: string }) => void) => {
      const listener = (_: unknown, p: any) => cb(p);
      ipcRenderer.on(IPC.HA_STATUS, listener);
      return () => ipcRenderer.removeListener(IPC.HA_STATUS, listener);
    },
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
