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

export type Mp3Quality = 'V0' | 'V2' | 'CBR320' | 'CBR256';

export interface ConversionSettings {
  enabled: boolean;
  // MP3 quality preset. V0 ≈ 245 kbps VBR (archival); CBR320 is max constant bitrate.
  quality: Mp3Quality;
  // Show the "Shrink album" button when converting this album's FLAC tracks to
  // MP3 would save at least this much of the album's total size, as a percent.
  // Default 5: "show it when it'll shave 5% or more off the album".
  // 0 = always show the button (useful when you want to force-convert anything
  // with FLAC in it regardless of savings).
  minSavingsPercent: number;
  // After converting, move originals to trash (default) or delete permanently.
  // We never just unlink without shell.trashItem — this bool only picks which
  // safe removal method to use.
  moveOriginalsToTrash: boolean;
}

/**
 * Estimated ratio of MP3 V0 size to FLAC size. Based on: CD-quality FLAC
 * (16/44.1) is ~850-900 kbps; V0 MP3 averages ~245 kbps. That's ~0.29 raw,
 * but we use 0.35 to be conservative — hi-res FLACs compress even more
 * aggressively, and we'd rather UNDER-promise savings than over-promise them.
 * Therefore `projected_savings = flac_bytes * (1 - MP3_SIZE_RATIO_VS_FLAC)`.
 */
export const MP3_SIZE_RATIO_VS_FLAC = 0.35;

export interface ConvertProgress {
  phase: 'idle' | 'starting' | 'converting' | 'verifying' | 'removing-originals' | 'done' | 'error';
  albumId: number | null;
  tracksTotal: number;
  tracksDone: number;
  currentFile: string | null;
  bytesBefore: number;
  bytesAfter: number;
  message: string | null;
}

export type PlaylistPathStyle = 'absolute' | 'relative';

export interface PlaylistExportSettings {
  enabled: boolean;
  // Absolute folder path where `.m3u8` files are written. Blank = auto-resolve
  // to <first music dir>/Playlists/, falling back to userData/Playlists/.
  folder: string;
  // Absolute paths are most portable on this machine; relative paths make the
  // playlist + music folder copyable to another host together.
  pathStyle: PlaylistPathStyle;
  // Also sync the Liked Songs virtual playlist as a real .m3u8 file.
  exportLiked: boolean;
}

export interface LastFmSettings {
  // User-registered Last.fm API credentials (created at
  // https://www.last.fm/api/account/create). Key is public; secret signs
  // mutating calls like scrobble.
  apiKey: string;
  apiSecret: string;
  // Long-lived session key obtained via the auth.getToken → browser-auth →
  // auth.getSession flow. Valid indefinitely; cleared on Disconnect.
  sessionKey: string;
  username: string;
  // Enable/disable scrobbling without disconnecting the account.
  scrobbleEnabled: boolean;
  // Minimum seconds listened before a track is eligible to scrobble.
  // Last.fm's own rule: ≥ 30 sec AND (≥ 4 min OR ≥ 50% of duration).
  // This is the 30-second floor; the other half is computed at call time.
  minScrobbleSec: number;
}

/**
 * Home Assistant integration. When configured, any `media_player.*`
 * entity HA exposes becomes a valid playback sink — HA speakers
 * ("HA Preview"), but also every Sonos / AirPlay / Squeezebox / Snapcast /
 * MusicAssistant / AVR target a real HA install usually has, via one
 * uniform REST interface.
 *
 * Token handling:
 *   - Long-lived access token from the user's HA profile page.
 *   - Stored only in `settings.json` inside `userData` (never in the
 *     repo, never logged). Log lines print `token=<redacted>` — see
 *     `electron/services/homeassistant.ts`.
 */
export interface HomeAssistantSettings {
  enabled: boolean;
  /** e.g. `https://homeassistant.local:8123` — no trailing slash. */
  baseUrl: string;
  /** Long-lived access token. NEVER log or transmit outside the main
   *  process; treated as write-only from the UI's perspective once set
   *  (the settings panel shows a masked placeholder, not the value). */
  token: string;
}

export interface AppSettings {
  firstRunComplete: boolean;
  conversion: ConversionSettings;
  playlistExport: PlaylistExportSettings;
  update: UpdateSettings;
  debug: DebugSettings;
  lastfm: LastFmSettings;
  homeAssistant: HomeAssistantSettings;
  library: {
    directories: LibraryDirectory[];
    databasePath: string;
    coverArtCachePath: string;
    // Where new cover art is written:
    //   'cache'        → app userData dir (default; no writes to your music collection)
    //   'album-folder' → alongside the audio files, as cover.jpg / cover.png
    //                    Every mainstream music app (Jellyfin, Plex, MusicBee, foobar)
    //                    also reads this file, so your art travels with the collection.
    //                    Falls back to cache if the music folder isn't writable.
    coverArtStorage: 'cache' | 'album-folder';
    // Filename used when coverArtStorage is 'album-folder'. Common choices:
    // "cover", "folder", "AlbumArt". Extension is appended automatically.
    coverArtFilename: string;
    // Gate for destructive ops. When true, delete-from-disk menu items are enabled.
    allowFileDeletion: boolean;
  };
  scan: ScanOptions;
  visualizer: VisualizerSettings;
  playback: {
    crossfadeMs: number;
    replayGain: 'off' | 'track' | 'album';
    outputDevice: string | null;
    // Last known volume, 0..1. Restored on startup so users aren't blasted
    // at 80% when they had it low, or vice versa.
    volume: number;
    // 10-band parametric EQ (ISO third-octave centers). Gains in dB, -12..+12.
    eqEnabled: boolean;
    eqGainsDb: number[];   // length 10
    eqPreamp: number;      // dB, -12..+6, applied before bands
  };
}

export interface Playlist {
  id: number;
  name: string;
  description: string | null;
  kind: 'manual' | 'smart';
  trackCount: number;
  /** Sum of `tracks.duration_sec` across all tracks in the playlist. 0 if
   *  unknown / no tracks. Populated by `pl:list` so the Playlists grid
   *  can show a hover tooltip analogous to album cards without needing a
   *  second round-trip per card. */
  durationSec?: number;
  /** Sum of `tracks.size` (on-disk bytes) across all tracks. Same
   *  rationale as `durationSec`. Not a guarantee of cumulative play
   *  bandwidth — a track referenced twice counts twice. */
  bytes?: number;
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
  SCAN_ALBUM: 'scan:album',
  // Library queries
  LIBRARY_TRACKS: 'library:tracks',
  LIBRARY_ALBUMS: 'library:albums',
  LIBRARY_ARTISTS: 'library:artists',
  LIBRARY_ARTIST: 'library:artist',
  LIBRARY_ALBUM: 'library:album',
  LIBRARY_SEARCH: 'library:search',
  LIBRARY_LARGEST_ALBUMS: 'library:largest-albums',
  LIBRARY_MIGRATE_COVER_ART: 'library:migrate-cover-art',
  LIBRARY_REVEAL_IN_FOLDER: 'library:reveal-in-folder',
  // Google Cast (Chromecast / Nest Mini). Main process owns discovery,
  // the media server, and device control; renderer only orchestrates.
  CAST_LIST: 'cast:list',
  CAST_PLAY: 'cast:play',
  CAST_PAUSE: 'cast:pause',
  CAST_RESUME: 'cast:resume',
  CAST_STOP: 'cast:stop',
  CAST_SET_VOLUME: 'cast:set-volume',
  CAST_ACTIVE: 'cast:active',
  CAST_SEEK: 'cast:seek',
  CAST_STATUS: 'cast:status', // main → renderer push
  // Home Assistant media_player targets. Same transport surface as Cast
  // so the player store can route to either with identical shapes.
  HA_TEST: 'ha:test',                   // test baseUrl + token (settings panel)
  HA_LIST: 'ha:list',                   // list media_player entities
  HA_PLAY: 'ha:play',
  HA_PAUSE: 'ha:pause',
  HA_RESUME: 'ha:resume',
  HA_STOP: 'ha:stop',
  HA_SET_VOLUME: 'ha:set-volume',
  HA_SEEK: 'ha:seek',
  HA_ACTIVE: 'ha:active',
  HA_STATUS: 'ha:status', // main → renderer push
  // DLNA / UPnP MediaRenderer. Both directions:
  //   - Sender: discover LAN renderers + drive one via SOAP AVTransport.
  //   - Receiver: this app advertises itself as a renderer; incoming
  //     media URLs arrive via DLNA_INCOMING and we play through the
  //     same <audio> element.
  DLNA_LIST:          'dlna:list',
  DLNA_RESCAN:        'dlna:rescan',
  DLNA_PLAY:          'dlna:play',
  DLNA_PAUSE:         'dlna:pause',
  DLNA_RESUME:        'dlna:resume',
  DLNA_STOP:          'dlna:stop',
  DLNA_SET_VOLUME:    'dlna:set-volume',
  DLNA_SEEK:          'dlna:seek',
  DLNA_ACTIVE:        'dlna:active',
  DLNA_STATUS:        'dlna:status',    // main → renderer push (sender status)
  DLNA_SCAN:          'dlna:scan',      // main → renderer push (discovery progress)
  DLNA_INCOMING:      'dlna:incoming',  // main → renderer push (receiver got a URL)
  DLNA_RECEIVER_STATE:'dlna:receiver-state', // renderer → main (our <audio> state for sender-facing responses)
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
  // Home / library stats
  LIBRARY_STATS: 'library:stats',
  // Playback statistics
  STATS_RECORD_PLAY: 'stats:record-play',
  STATS_OVERVIEW: 'stats:overview',
  // FLAC -> MP3 conversion
  CONVERT_ALBUM_TO_MP3: 'convert:album-to-mp3',
  CONVERT_CANCEL: 'convert:cancel',
  CONVERT_PROGRESS: 'convert:progress',
  CONVERT_CHECK_AVAILABLE: 'convert:check-available',
  // Playlist export / import (universal M3U8)
  PL_EXPORT_ALL: 'pl:export-all',
  PL_IMPORT_FROM_FOLDER: 'pl:import-from-folder',
  // Self-update (git-based)
  UPDATE_INFO: 'update:info',
  UPDATE_CHECK: 'update:check',
  UPDATE_APPLY: 'update:apply',
  // Debug
  DEBUG_TOGGLE_DEVTOOLS: 'debug:toggle-devtools',
  // Internet radio (Radio-Browser)
  RADIO_TOP: 'radio:top',
  RADIO_TRENDING: 'radio:trending',
  RADIO_SEARCH: 'radio:search',
  RADIO_BY_TAG: 'radio:by-tag',
  RADIO_BY_COUNTRY: 'radio:by-country',
  RADIO_TAGS: 'radio:tags',
  RADIO_CLICK: 'radio:click',
  RADIO_START_SNIFF: 'radio:start-sniff',
  RADIO_STOP_SNIFF: 'radio:stop-sniff',
  RADIO_NOW_PLAYING: 'radio:now-playing', // main -> renderer push event
  // Last.fm
  LASTFM_STATUS: 'lastfm:status',
  LASTFM_BEGIN_AUTH: 'lastfm:begin-auth',
  LASTFM_FINISH_AUTH: 'lastfm:finish-auth',
  LASTFM_DISCONNECT: 'lastfm:disconnect',
  LASTFM_SET_KEYS: 'lastfm:set-keys',
  LASTFM_SET_SCROBBLE: 'lastfm:set-scrobble',
  LASTFM_PROFILE: 'lastfm:profile',
  LASTFM_USER_TOP_ARTISTS: 'lastfm:user-top-artists',
  LASTFM_USER_TOP_TRACKS: 'lastfm:user-top-tracks',
  LASTFM_USER_TOP_ALBUMS: 'lastfm:user-top-albums',
  LASTFM_USER_RECENT: 'lastfm:user-recent',
  LASTFM_CHARTS_ARTISTS: 'lastfm:charts-artists',
  LASTFM_CHARTS_TRACKS: 'lastfm:charts-tracks',
  LASTFM_NOW_PLAYING: 'lastfm:now-playing',
  LASTFM_SCROBBLE: 'lastfm:scrobble',
} as const;

export interface ScrobbleInput {
  artist: string;
  track: string;
  album?: string | null;
  albumArtist?: string | null;
  durationSec?: number | null;
  playedAt: number;
}

export type LastFmPeriod = '7day' | '1month' | '3month' | '6month' | '12month' | 'overall';

export interface LastFmStatus {
  connected: boolean;
  username: string | null;
  scrobbleEnabled: boolean;
  hasCredentials: boolean;   // apiKey + apiSecret present
}

export interface LastFmProfile {
  name: string;
  realname: string | null;
  url: string;
  country: string | null;
  playcount: number;
  registered: number | null;
  image: string | null;
}

export interface LastFmArtist { name: string; playcount?: number; url: string; image: string | null; listeners?: number; }
export interface LastFmTrackLite { name: string; artist: string; playcount?: number; listeners?: number; url: string; image: string | null; scrobbledAt?: number | null; nowPlaying?: boolean; album?: string | null; }
export interface LastFmAlbum { name: string; artist: string; playcount?: number; url: string; image: string | null; }

export interface RadioStation {
  stationuuid: string;
  name: string;
  url: string;
  url_resolved: string;
  homepage: string;
  favicon: string;
  tags: string;
  country: string;
  countrycode: string;
  language: string;
  codec: string;
  bitrate: number;
  votes: number;
  clickcount: number;
  lastcheckok: 0 | 1;
}

export interface RadioTag { name: string; stationcount: number; }

export interface UpdateCheckResult {
  upToDate: boolean;
  currentVersion: string;
  currentSha: string | null;
  latestSha: string | null;
  commitsBehind: number | null;
  latestMessage: string | null;
  latestDate: string | null;
  dirtyWorkingTree: boolean;
  error: string | null;
  upstreamUrl: string;
}

export interface UpdateSettings {
  enabled: boolean;
  checkOnStartup: boolean;
  repoSlug: string;         // "SixOfFive/musicplayer"
  branch: string;           // "main"
}

export interface DebugSettings {
  // When true, open Chromium DevTools automatically at startup.
  openDevToolsOnStartup: boolean;
  // Forward renderer console.log to main stdout (useful in dev terminals).
  logRendererToMain: boolean;
}

export interface LibraryStats {
  trackCount: number;
  albumCount: number;
  artistCount: number;
  playlistCount: number;
  likedCount: number;
  totalBytes: number;
  totalDurationSec: number;
  coverArtCoverage: number;  // 0..1: fraction of albums with art
  oldestYear: number | null;
  newestYear: number | null;
  topGenre: string | null;
  topGenreCount: number;
  biggestAlbum: { title: string; artist: string | null; bytes: number } | null;
  longestTrack: { title: string; artist: string | null; seconds: number } | null;
  mostRecentlyAdded: Array<{ id: number; title: string; artist: string | null; album: string | null; dateAdded: number; coverArtPath: string | null }>;
}

export interface StatsOverview {
  // Cumulative listening
  totalListenedSec: number;
  totalPlays: number;
  uniqueTracksPlayed: number;
  uniqueArtistsPlayed: number;
  uniqueAlbumsPlayed: number;

  // Time-bucketed
  listenedTodaySec: number;
  listenedThisWeekSec: number;
  listenedThisMonthSec: number;
  listenedThisYearSec: number;
  listenedLast7DaysSec: number;
  listenedLast30DaysSec: number;

  // Averages
  avgDailyListenedSec: number;      // across all days any plays exist
  activeDayCount: number;            // distinct days with at least one play
  currentStreakDays: number;         // consecutive days up to today with plays
  longestStreakDays: number;

  // Distributions
  mostActiveHour: number | null;     // 0..23, UTC-offset corrected in renderer
  mostActiveDayOfWeek: number | null;// 0 Sun .. 6 Sat
  hourHistogram: number[];           // length 24, sums of listened_sec
  dayOfWeekHistogram: number[];      // length 7

  // Top lists
  topTracks: Array<{ id: number; title: string; artist: string | null; album: string | null; playCount: number; coverArtPath: string | null }>;
  topArtists: Array<{ id: number; name: string; playCount: number; listenedSec: number }>;
  topAlbums: Array<{ id: number; title: string; artist: string | null; playCount: number; coverArtPath: string | null }>;
  topGenres: Array<{ genre: string; playCount: number }>;

  // Firsts / lasts
  firstPlayAt: number | null;
  lastPlayAt: number | null;
  firstPlayedTrack: { id: number; title: string; artist: string | null } | null;
  lastPlayedTrack: { id: number; title: string; artist: string | null } | null;

  // Fun facts
  longestSessionSec: number;         // longest contiguous burst (gaps > 10 min = new session)
  sessionCount: number;
  avgSessionSec: number;
  mostPlayedDay: { date: string; sec: number } | null; // biggest single-day listening
}

export type TrackSort = 'title' | 'artist' | 'album' | 'year' | 'genre' | 'duration' | 'date_added' | 'track_no';
export type SortDir = 'asc' | 'desc';

export interface TrackQuery {
  limit?: number;
  offset?: number;
  query?: string;
  sortBy?: TrackSort;
  sortDir?: SortDir;
}

export type AlbumSort = 'title' | 'artist' | 'year' | 'genre' | 'track_count' | 'date_added';

export interface AlbumQuery {
  limit?: number;
  offset?: number;
  query?: string;
  sortBy?: AlbumSort;
  sortDir?: SortDir;
  genre?: string;
}

export type IpcChannel = typeof IPC[keyof typeof IPC];

/**
 * Search hit shapes — richer than the original LIBRARY_SEARCH payload so the
 * dedicated Search view can show cover art + track counts + sizes without a
 * follow-up fetch per result.
 */
export interface SearchTrackHit {
  id: number;
  title: string;
  artist: string | null;
  album: string | null;
  albumId: number | null;
  artistId: number | null;
  durationSec: number | null;
  coverArtPath: string | null;
  path: string;
}
export interface SearchAlbumHit {
  id: number;
  title: string;
  artist: string | null;
  coverArtPath: string | null;
  year: number | null;
  genre?: string | null;
  trackCount: number;
  bytes: number;
  durationSec?: number;
}
export interface SearchArtistHit {
  id: number;
  name: string;
  trackCount: number;
  albumCount: number;
}
export interface SearchResults {
  tracks: SearchTrackHit[];
  albums: SearchAlbumHit[];
  artists: SearchArtistHit[];
}

export interface CastDeviceRef {
  id: string;
  name: string;
  host: string;
  type: 'chromecast' | 'nest' | 'unknown';
}

/**
 * A Home Assistant `media_player.*` entity usable as a playback sink.
 * Mirrors the shape of `CastDeviceRef` so the OutputDevicePicker can
 * render both lists with the same row component.
 */
export interface HaEntityRef {
  id: string;                // entity_id e.g. "media_player.living_room"
  name: string;              // friendly_name (falls back to id)
  state: string;             // "playing" | "paused" | "idle" | "off" | …
  /** HA `supported_features` bitmask. PAUSE=1, SEEK=2, VOLUME_SET=4,
   *  STOP=4096, PLAY=16384, PLAY_MEDIA=512. The picker greys out the
   *  speaker icon's scrubber / volume slider when the chosen entity
   *  doesn't advertise the relevant bit. */
  supportedFeatures: number;
  volume: number | null;     // 0..1, or null if HA hasn't reported yet
}

/** Cast / HA push status updates share this shape so the renderer's
 *  player-store subscriber handles both without branching. The source
 *  field identifies which sink the update came from — lets the store
 *  ignore stragglers when the user just switched targets. */
export interface HaStatusUpdate {
  entityId: string;
  currentTime: number;
  duration: number | null;
  playerState: 'PLAYING' | 'PAUSED' | 'BUFFERING' | 'IDLE' | 'UNKNOWN';
}

/** A DLNA MediaRenderer discovered on the LAN. Same row shape as Cast/HA
 *  so the output picker can render all three sink kinds with one row
 *  component. `id` is the device's UDN (uuid:… string). */
export interface DlnaDeviceRef {
  id: string;
  name: string;
  host: string;
  manufacturer?: string;
  modelName?: string;
}

/** DLNA status push, matching Cast/HA shape. */
export interface DlnaStatusUpdate {
  deviceId: string;
  currentTime: number;
  duration: number | null;
  playerState: 'PLAYING' | 'PAUSED' | 'BUFFERING' | 'IDLE' | 'UNKNOWN';
}

/** Progress tick published during initial DLNA discovery. Drives the
 *  "scanning for speakers" indicator in the picker dropdown. */
export interface DlnaScanProgress {
  elapsedMs: number;
  totalMs: number;
  found: number;
  done: boolean;
}

/** Media push from a remote DLNA sender (VLC's "Render to..." etc.).
 *  Main forwards this to the renderer, which loads the URL into the
 *  shared <audio> element the same way a local track or radio stream
 *  would be. */
export interface DlnaIncomingMedia {
  uri: string;
  title?: string;
  artist?: string;
  album?: string;
}

export interface LargestAlbum {
  id: number;
  title: string;
  artist: string | null;
  coverArtPath: string | null;
  trackCount: number;
  bytes: number;
}
