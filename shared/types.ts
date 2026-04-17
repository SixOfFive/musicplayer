// Shared types used by both Electron main and React renderer.

export type TrackId = number;
export type AlbumId = number;
export type ArtistId = number;

export interface Track {
  id: TrackId;
  path: string;
  title: string;
  artistId: ArtistId | null;
  artist: string | null;
  albumId: AlbumId | null;
  album: string | null;
  albumArtist: string | null;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  genre: string | null;
  durationSec: number | null;
  bitrate: number | null;
  sampleRate: number | null;
  codec: string | null;
  dateAdded: number; // epoch ms
  coverArtPath: string | null;
}

export interface Album {
  id: AlbumId;
  title: string;
  artist: string | null;
  year: number | null;
  coverArtPath: string | null;
  trackCount: number;
}

export interface Artist {
  id: ArtistId;
  name: string;
  albumCount: number;
  trackCount: number;
}

export interface LibraryDirectory {
  id: number;
  path: string;
  enabled: boolean;
  lastScannedAt: number | null;
}

export interface ScanProgress {
  phase: 'idle' | 'enumerating' | 'reading-tags' | 'fetching-art' | 'done' | 'error';
  filesSeen: number;
  filesProcessed: number;
  bytesSeen: number;          // total bytes of all files found in enumerating phase
  bytesProcessed: number;     // cumulative bytes of files parsed in reading-tags
  currentFile: string | null;
  message: string | null;
  // Art fetch runs concurrently with (or after) the main scan.
  // `null` means no art-fetch is active. Fields match filesSeen/filesProcessed shape.
  art: {
    active: boolean;
    albumsTotal: number;
    albumsDone: number;
    currentAlbum: string | null;
  } | null;
}

export type MetadataProviderId =
  | 'none'
  | 'musicbrainz'
  | 'coverartarchive'
  | 'lastfm'
  | 'discogs'
  | 'deezer'
  | 'acoustid'
  | 'accuraterip'
  | 'cuetoolsdb';

export interface MetadataProvider {
  id: MetadataProviderId;
  label: string;
  freeTier: boolean;
  requiresKey: boolean;
  description: string;
}

export interface ScanOptions {
  // Which providers to consult when tags are missing or for cover art.
  providers: MetadataProviderId[];
  // Optional API keys (keyed by provider).
  apiKeys: Partial<Record<MetadataProviderId, string>>;
  // Only rescan files whose mtime changed.
  incremental: boolean;
  // Fetch cover art for tracks that don't have embedded art.
  fetchCoverArt: boolean;
  // Write fetched tags back into the files.
  writeBackTags: boolean;
  // File extensions to include.
  extensions: string[];
}

export interface VisualizerPlugin {
  id: string;
  name: string;
  author?: string;
  kind: 'milkdrop' | 'avs' | 'native-winamp' | 'builtin';
  // For milkdrop: path or URL to .milk file. For built-in: identifier.
  source: string;
  builtin: boolean;
  enabled: boolean;
}

export interface VisualizerSettings {
  activePluginId: string | null;
  fps: 30 | 60 | 120;
  sensitivity: number; // 0..1
  smoothing: number;   // 0..1
  fullscreenOnPlay: boolean;
  pluginSearchPaths: string[];
}

export interface AppSettings {
  firstRunComplete: boolean;
  library: {
    directories: LibraryDirectory[];
    databasePath: string;
    coverArtCachePath: string;
    // Gate for destructive ops. When true, delete-from-disk menu items are enabled.
    allowFileDeletion: boolean;
  };
  scan: ScanOptions;
  visualizer: VisualizerSettings;
  playback: {
    crossfadeMs: number;
    replayGain: 'off' | 'track' | 'album';
    outputDevice: string | null;
  };
}

export interface Playlist {
  id: number;
  name: string;
  description: string | null;
  kind: 'manual' | 'smart';
  trackCount: number;
  createdAt: number;
  updatedAt: number;
}

// A virtual playlist id used for the auto-populated "Liked Songs" master.
// Negative so it never collides with real row ids.
export const LIKED_PLAYLIST_ID = -1;

// IPC channel names — single source of truth.
export const IPC = {
  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  // Library dirs
  LIBRARY_LIST_DIRS: 'library:list-dirs',
  LIBRARY_ADD_DIR: 'library:add-dir',
  LIBRARY_REMOVE_DIR: 'library:remove-dir',
  LIBRARY_PICK_DIR: 'library:pick-dir',
  // Scanning
  SCAN_START: 'scan:start',
  SCAN_CANCEL: 'scan:cancel',
  SCAN_PROGRESS: 'scan:progress', // main -> renderer event
  // Library queries
  LIBRARY_TRACKS: 'library:tracks',
  LIBRARY_ALBUMS: 'library:albums',
  LIBRARY_ARTISTS: 'library:artists',
  LIBRARY_ALBUM: 'library:album',
  LIBRARY_SEARCH: 'library:search',
  // Playback helpers
  PLAYBACK_FILE_URL: 'playback:file-url',
  // Visualizer plugins
  VIS_LIST: 'vis:list',
  VIS_SCAN_DIRS: 'vis:scan-dirs',
  VIS_READ_PRESET: 'vis:read-preset',
  VIS_OPEN_DIR: 'vis:open-dir',
  // Metadata providers
  META_PROVIDERS: 'meta:providers',
  META_TEST_PROVIDER: 'meta:test-provider',
  // Playlists & likes
  PL_LIST: 'pl:list',
  PL_CREATE: 'pl:create',
  PL_RENAME: 'pl:rename',
  PL_DELETE: 'pl:delete',
  PL_GET: 'pl:get',
  PL_ADD_TRACKS: 'pl:add-tracks',
  PL_REMOVE_TRACKS: 'pl:remove-tracks',
  PL_REORDER: 'pl:reorder',
  LIKE_TOGGLE: 'like:toggle',
  LIKE_LIST: 'like:list',
  // Destructive library ops
  LIBRARY_DELETE_TRACK: 'library:delete-track',
  LIBRARY_DELETE_ALBUM: 'library:delete-album',
  // First-run
  FIRST_RUN_DEFAULT_DIR: 'first-run:default-dir',
} as const;

export type TrackSort = 'title' | 'artist' | 'album' | 'year' | 'genre' | 'duration' | 'date_added' | 'track_no';
export type SortDir = 'asc' | 'desc';

export interface TrackQuery {
  limit?: number;
  offset?: number;
  query?: string;
  sortBy?: TrackSort;
  sortDir?: SortDir;
}

export type AlbumSort = 'title' | 'artist' | 'year' | 'genre' | 'track_count';

export interface AlbumQuery {
  limit?: number;
  offset?: number;
  query?: string;
  sortBy?: AlbumSort;
  sortDir?: SortDir;
  genre?: string;
}

export type IpcChannel = typeof IPC[keyof typeof IPC];
