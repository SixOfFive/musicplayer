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
    // Health probes — fired by AlbumView on mount + by player's error
    // handler on playback failure. Both are throttled main-side to
    // avoid re-statting the same file in rapid succession. Return
    // shapes:
    //   probeTrack:  { ok, removed, reason, path?, title? }
    //   probeAlbum:  { ok, rescanned, reason, added?, updated?, removed?, albumDeleted? }
    probeTrack: (trackId: number) => ipcRenderer.invoke('library:probe-track', trackId),
    probeAlbum: (albumId: number) => ipcRenderer.invoke('library:probe-album', albumId),
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
    // Save-scheduler status + manual flush. `status` reports how many
    // edits are queued in on-close mode and what mode is currently
    // effective; `flushNow` drains the queue on demand.
    schedStatus: () => ipcRenderer.invoke(IPC.PL_SCHED_STATUS),
    flushNow: () => ipcRenderer.invoke(IPC.PL_SCHED_FLUSH),
    clearLastError: () => ipcRenderer.invoke('pl:clear-last-error'),
    // Rewrite corrupt .m3u8 files in place — keeps salvageable tracks,
    // drops malformed lines. Called by the Import dialog when the
    // user opts in to fixing a partial-parse file.
    fixCorrupt: (absPaths: string[]) => ipcRenderer.invoke(IPC.PL_FIX_CORRUPT, absPaths),
    // Per-playlist Save Now / Load Now (bypasses the scheduler).
    // saveNowPeek: check whether the .m3u8 exists on disk already,
    //              so the UI can show a merge-vs-overwrite prompt.
    // saveNow:    force write {mode: 'overwrite' | 'merge'}.
    // loadNow:    pull tracks from disk into the playlist, de-duped.
    saveNowPeek: (id: number) => ipcRenderer.invoke('pl:save-now-peek', id),
    saveNow: (id: number, mode: 'overwrite' | 'merge') => ipcRenderer.invoke('pl:save-now', id, mode),
    loadNow: (id: number) => ipcRenderer.invoke('pl:load-now', id),
    // Mid-playback auto-refresh. Player calls this ~15s before the
    // current track ends when the queue came from a playlist view.
    // Returns { changed: false, mtimeMs, reason } when nothing moved
    // on disk, or { changed: true, mtimeMs, tracks, reason } with
    // the refreshed tracks ready to swap into the queue on 'ended'.
    // Pass knownMtimeMs: null to establish a baseline at play-start
    // without fetching track data.
    checkRefresh: (id: number, knownMtimeMs: number | null) =>
      ipcRenderer.invoke('pl:check-refresh', id, knownMtimeMs),
    // Copy every liked track's AUDIO FILE into <dest>/<Artist>/<file>.
    // Interactive: main sends conflict / error prompt events while the
    // copy runs, renderer replies via `copyLikedDecide`. See
    // electron/ipc/copy-liked.ts for the protocol details.
    copyLikedPickDest: () => ipcRenderer.invoke('pl:copy-liked-pick-dest'),
    copyLikedStart: (destDir: string) => ipcRenderer.invoke('pl:copy-liked-start', destDir),
    copyLikedDecide: (id: number, action: string) => ipcRenderer.invoke('pl:copy-liked-decide', { id, action }),
    copyLikedAbort: () => ipcRenderer.invoke('pl:copy-liked-abort'),
    onCopyLikedProgress: (cb: (p: { done: number; total: number; currentFile: string | null }) => void) => {
      const listener = (_: unknown, p: any) => cb(p);
      ipcRenderer.on('pl:copy-liked-progress', listener);
      return () => ipcRenderer.removeListener('pl:copy-liked-progress', listener);
    },
    onCopyLikedConflict: (cb: (p: { id: number; srcPath: string; destPath: string; artist: string }) => void) => {
      const listener = (_: unknown, p: any) => cb(p);
      ipcRenderer.on('pl:copy-liked-conflict', listener);
      return () => ipcRenderer.removeListener('pl:copy-liked-conflict', listener);
    },
    onCopyLikedError: (cb: (p: { id: number; srcPath: string; destPath: string; error: string; artist: string }) => void) => {
      const listener = (_: unknown, p: any) => cb(p);
      ipcRenderer.on('pl:copy-liked-error', listener);
      return () => ipcRenderer.removeListener('pl:copy-liked-error', listener);
    },
    onCopyLikedDone: (cb: (p: { total: number; copied: number; overwritten: number; skipped: number; failed: number; aborted: boolean; errors: Array<{ path: string; error: string }> }) => void) => {
      const listener = (_: unknown, p: any) => cb(p);
      ipcRenderer.on('pl:copy-liked-done', listener);
      return () => ipcRenderer.removeListener('pl:copy-liked-done', listener);
    },
  },
  likes: {
    toggle: (trackId: number) => ipcRenderer.invoke(IPC.LIKE_TOGGLE, trackId),
    list: () => ipcRenderer.invoke(IPC.LIKE_LIST),
  },
  stats: {
    recordPlay: (trackId: number, listenedSec: number, completed: boolean) =>
      ipcRenderer.invoke(IPC.STATS_RECORD_PLAY, trackId, listenedSec, completed),
    overview: () => ipcRenderer.invoke(IPC.STATS_OVERVIEW),
    // Fat aggregate dump for the fun-fact banner. Called once per
    // LibraryStatsPanel mount; the returned object is memoised and
    // the panel reshuffles fact order per session.
    neat: () => ipcRenderer.invoke(IPC.STATS_NEAT),
  },
  // Year-tag audit + fix. `auditYears` scans the DB and returns a
  // preview of fixable issues. `fixYears` takes a subset of those
  // fixes and writes them back to the files via ffmpeg, emitting
  // progress events through `onFixProgress`.
  tags: {
    auditYears: () => ipcRenderer.invoke(IPC.TAGS_AUDIT_YEARS),
    fixYears: (fixes: Array<{ trackId: number; path: string; year: number }>) =>
      ipcRenderer.invoke(IPC.TAGS_FIX_YEARS, fixes),
    onFixProgress: (cb: (p: { done: number; total: number; currentPath: string | null; errors: Array<{ trackId: number; path: string; error: string }>; finished: boolean }) => void) => {
      const listener = (_: unknown, p: any) => cb(p);
      ipcRenderer.on(IPC.TAGS_FIX_PROGRESS, listener);
      return () => ipcRenderer.removeListener(IPC.TAGS_FIX_PROGRESS, listener);
    },
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
    // Transport commands (Play/Pause/Stop/Seek) pushed by a remote
    // DLNA sender at our receiver. Renderer subscribes to drive its
    // own <audio> element so pause on the remote side actually pauses
    // our local playback.
    onIncomingTransport: (cb: (t: { action: 'play' | 'pause' | 'stop' | 'seek'; positionSec?: number }) => void) => {
      const listener = (_: unknown, t: any) => cb(t);
      ipcRenderer.on(IPC.DLNA_INCOMING_TRANSPORT, listener);
      return () => ipcRenderer.removeListener(IPC.DLNA_INCOMING_TRANSPORT, listener);
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
  // System media keys — hardware Play/Pause/Next/Prev/Stop buttons.
  // Main registers globalShortcut for each and pushes the action name
  // through this channel. Renderer subscribes once from the player
  // store so keys work globally regardless of which view is mounted.
  mediaKeys: {
    onKey: (cb: (action: 'play-pause' | 'next' | 'prev' | 'stop') => void) => {
      const listener = (_: unknown, action: any) => cb(action);
      ipcRenderer.on(IPC.MEDIA_KEY, listener);
      return () => ipcRenderer.removeListener(IPC.MEDIA_KEY, listener);
    },
  },
  // Local recommendation engine. `limit` clamped server-side to [1,500];
  // default 100 if omitted. `seed` is optional: passing a number applies
  // score jitter + artist/album diversification so every call produces
  // a visibly different ordering. Omit for deterministic results.
  suggestions: {
    get: (limit?: number, seed?: number) => ipcRenderer.invoke(IPC.SUGGESTIONS_GET, limit, seed),
  },
  // Time-synced lyrics. `get` is cache-first (instant on repeat opens of
  // the same track); `refetch` bypasses the cache for "wrong match" /
  // "I just fixed the tags" cases. `setManual` stores user-pasted
  // lyrics permanently as source='manual' so re-fetches won't clobber
  // them. `clear` drops the cache row so the next open re-runs the
  // full disk + LRCLib lookup. All return shapes match
  // `services/lyrics.ts::LyricsResult`.
  lyrics: {
    get: (trackId: number) => ipcRenderer.invoke('lyrics:get', trackId),
    refetch: (trackId: number) => ipcRenderer.invoke('lyrics:refetch', trackId),
    setManual: (trackId: number, raw: string) => ipcRenderer.invoke('lyrics:set-manual', trackId, raw),
    clear: (trackId: number) => ipcRenderer.invoke('lyrics:clear', trackId),
    // Cheap availability check (cache + disk only, no network).
    // Returns 'cached' | 'disk' | 'none'. NowPlayingBar uses it to
    // tint the lyrics icon green when something exists, grey when
    // nothing does.
    peek: (trackId: number) => ipcRenderer.invoke('lyrics:peek', trackId),
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
