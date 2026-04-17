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
    artists: () => ipcRenderer.invoke(IPC.LIBRARY_ARTISTS),
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
  },
  likes: {
    toggle: (trackId: number) => ipcRenderer.invoke(IPC.LIKE_TOGGLE, trackId),
    list: () => ipcRenderer.invoke(IPC.LIKE_LIST),
  },
};

contextBridge.exposeInMainWorld('mp', api);

export type MpApi = typeof api;
