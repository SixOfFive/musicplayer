# MusicPlayer

A personal, local-first music player with a Spotify-style interface — Electron + React + TypeScript desktop app for Windows, macOS and Linux (including KDE Plasma).

## Quick start

**Windows:** double-click `run.bat` (or run it from a terminal).
**macOS / Linux:** `./run.sh` from the project root.

Both scripts check for Node (>=18) + npm, install dependencies on first run, rebuild native modules against Electron's ABI, verify the bundled `ffmpeg` binary is present, then launch the dev environment.

Manual:

```bash
npm install                 # installs deps + rebuilds better-sqlite3 for Electron ABI
npm run electron:dev        # Vite + Electron in parallel
npm run electron:build      # produces platform installer via electron-builder
```

## Features

### Library
- **Recursive scan** of one or more music folders with a 4Hz progress panel (phase, throughput, GB scanned, ETA, current file)
- **Tag reading** via `music-metadata` — ID3v1/v2.3/v2.4 (MP3, WAV), Vorbis Comments (FLAC, OGG, OPUS), APE, iTunes MP4 atoms (M4A/AAC), ASF (WMA)
- **Embedded cover art** extracted on scan, cached or written alongside audio (configurable)
- **Online cover art** fetched in the background after tag scan from: MusicBrainz → Cover Art Archive → Deezer — rate-limited per provider, cached, retries on manual rescan
- **Incremental scanning** — tracks unchanged by mtime+size are skipped; albums already marked "not found online" stay skipped unless touched
- **Startup resume** — if app was closed mid-art-fetch, resumes automatically on next launch
- **Live refresh** — Albums/Home/Library/Artist views re-fetch as covers land, without polling

### Playback
- Double-click a track → plays with the visible list as queue
- Hover an album card → Spotify-style green ▶ play button
- Album detail page: big cover, title/artist/year/genre/runtime, big Play button, full track list
- Artist detail page: every album of theirs + every track, Play All button
- Scrubber with seek support (HTTP Range requests through custom `mp-media` protocol via Electron's `net.fetch`)
- Volume, prev/next, heart-to-like, now-playing bar persistent across views

### Playlists (universal .m3u8 format)
- **Left-sidebar "Playlists" tab** → dedicated grid view with Export-all / Import-from-folder buttons
- **Auto-export on every edit** — creating, renaming, adding/removing/reordering tracks, and liking/unliking all write a `.m3u8` immediately
- **Startup import** — any `.m3u8` in the export folder that isn't already in the DB gets loaded as a new playlist
- **Liked Songs** is a virtual playlist (backed by `track_likes` table) that also exports as `Liked Songs.m3u8`
- Playlist format: `#EXTM3U` + `#EXTINF:<sec>,<artist> - <title>` — readable by foobar2000, MusicBee, VLC, Winamp, Jellyfin, Plex, Navidrome, iTunes, and every Android music player
- Path style selectable: absolute (default) or relative (portable with the music tree)
- Default location: `<firstMusicFolder>/Playlists/` → falls back to `userData/Playlists`

### Track & album views
- **Right-click any track row** for a context menu: Play, Like, Add to playlist (any existing or + new), Remove from library, optionally Delete file (gated by a setting — uses `shell.trashItem`)
- **Sortable columns** on tracks and albums (title / artist / album / year / genre / duration / track # / date added)
- **Genre filter** on the Albums view
- **Artist search + sort** on the Artists view

### Statistics & fun facts
- **Every play is recorded**: per-track `play_count`, `last_played_at`, `total_listened_sec` + individual `play_events` for time-series
- Sessions with < 5 sec of audio are discarded as noise
- **Home screen** surfaces:
  - 6 stat tiles: tracks / albums / artists / library size / total runtime / playlists+likes
  - Purple "fun fact" card that auto-rotates every 12s (click to cycle manually) with 20+ facts generated from the library and play history:
    - Back-to-back playback time, top genre, year span, chunkiest album, longest track, cover-art coverage
    - Hours listened today / this week / this month / this year / last 30 days
    - Active day count, average per day, current + longest listening streaks
    - Most-musical hour of the day, biggest day of the week
    - Most-played track / artist / album / genre
    - Unique artists sampled, % of library played, longest continuous session, session count + average
    - Biggest single listening day, first track ever played
  - Recently-added strip + Your albums grid

### Visualizer
- **Pluggable backend API** — every backend consumes an `AudioFrame` bus with FFT bins, waveform, bass/mid/treble energies, beat flag + intensity, running BPM
- **5 built-in visualizers** (Canvas2D, zero deps): Spectrum Bars, Mirror Bars, Oscilloscope, Radial Spectrum, Beat Particles
- **20 bundled Milkdrop presets** via `butterchurn` (WebGL port of Milkdrop 2) — classic Geiss, Flexi, Aderrasi, Rovastar, etc.
- **User plugins**: drop `.milk` files into any folder listed in Settings → Visualizer → Plugin folders
- **Winamp `.dll` plugins**: listed but marked unloadable. A Windows-only FFI bridge (`node-ffi-napi`) is scaffolded under the `native-winamp` backend kind — not implemented.

### FLAC → MP3 conversion ("Shrink albums")
- **Button on AlbumView** for any album with FLAC tracks ≥ 20 MB
- **Yellow 🗜 badge on album cards** when the album is above the 66th-percentile size in your library (configurable percentile slider in Settings)
- Uses bundled **ffmpeg** (via `ffmpeg-static`) with `libmp3lame`
- Quality options: **VBR V0** (~245 kbps, archival — default), V2 (~190), CBR 320, CBR 256
- Preserves all tags (`-map_metadata 0`) and embedded cover art (`-map 0:v? -c:v copy`)
- **Safety**: refuses to overwrite existing MP3s, verifies every output is present and >= 30 KB, and only removes FLACs after *all* new MP3s verify. Originals go to the system trash by default (toggle-able)
- Progress bar, cancellation, and DB path/codec/size updates in a single transaction at the end

### Settings (five tabs)
- **Library** — folders, scan progress, database/cache paths, cover art storage (app cache *or* alongside audio files as `cover.jpg` / `folder.jpg`), playlist export folder + path style, destructive-ops gate
- **Scanning & Metadata** — incremental, fetch cover art, write-back tags, file extensions list, per-provider toggles + API keys + connection test
- **Visualizer** — target FPS, beat sensitivity, smoothing, fullscreen-on-play, plugin search folders, active plugin picker
- **Playback** — crossfade, ReplayGain mode
- **Shrink albums** — enable, MP3 quality, size-percentile threshold, trash vs. permanent delete

## Storage & standards

- **Music folder default** — `app.getPath('music')`:
  - macOS: `~/Music`
  - Linux (KDE/GNOME): XDG `XDG_MUSIC_DIR` (usually `~/Music`)
  - Windows: `%USERPROFILE%\Music`
- **Library DB & cover-art cache** — `app.getPath('userData')`:
  - macOS: `~/Library/Application Support/MusicPlayer/`
  - Linux: `~/.config/MusicPlayer/`
  - Windows: `%APPDATA%\MusicPlayer\`
- **Playlist export** — `<firstMusicFolder>/Playlists/` (configurable). Any `.m3u8` already there on startup imports as new playlists.
- **Cover art alongside audio** (optional) — `cover.jpg` (filename configurable) in each album folder. Compatible with Jellyfin/Plex/foobar/MusicBee/Navidrome conventions.

## Supported audio formats

Enabled by default:

| Ext | Container / codec | Tag format | Playback | Notes |
|---|---|---|---|---|
| `.mp3` | MPEG-1 Layer III | ID3v1, ID3v2 | ✅ | |
| `.flac` | FLAC | Vorbis Comments | ✅ | Lossless. Candidate for MP3 shrink. |
| `.wav` | RIFF/WAV (PCM) | ID3, LIST INFO | ✅ | |
| `.m4a` | MPEG-4 / AAC or ALAC | iTunes MP4 atoms | ✅ | |
| `.aac` | raw ADTS AAC | ID3v2 | ✅ | |
| `.ogg` | Ogg Vorbis | Vorbis Comments | ✅ | |
| `.opus` | Ogg Opus | Vorbis Comments | ✅ | |
| `.wma` | Windows Media Audio | ASF | ⚠ Windows only | Chromium's non-Windows builds ship without the WMA decoder. |

Also readable by the tag parser if you add them to the extensions list (scan-only — Electron can't play them without a native decoder): `.aiff` / `.aif`, `.mpc`, `.wv`, `.ape`, `.dsf` / `.dff`, `.mka`, `.webm`, `.tak`, `.tta`.

## Metadata & integrity providers

Configured in Settings → Scanning & Metadata. All free; some need a free API key.

| Provider | What it gives | Key | Wired |
|---|---|---|---|
| MusicBrainz | Canonical artist/album/track IDs (MBIDs), release metadata | No | Yes |
| Cover Art Archive | Front/back cover art keyed to MBIDs | No | Yes |
| Deezer | 1000×1000 album art via public search API | No | Yes |
| Last.fm | Bios, similar artists, scrobble counts | Free key | Stub |
| Discogs | Physical-media metadata, cover art | Free token | Stub |
| AcoustID / Chromaprint | Fingerprint → MusicBrainz match for tag-less files | Free key + `fpcalc` | Stub |
| AccurateRip | Per-track CRC32 of decoded audio samples for verified CD rips | No | Stub |
| CUETools DB (CTDB) | Alternative CRC/verification DB, wider coverage | No | Stub |

All providers go through per-provider `SerialRateLimiter` instances so the scan never bursts against anyone's API.

AccurateRip + CTDB exist specifically to answer *"is there a free online catalog with CRC checks for songs/albums?"* — yes, the same databases EAC, dBpoweramp, and XLD use. Verification panel is not yet wired into the UI.

## Project layout

```
electron/                   Main process
  main.ts                   Window, protocol, IPC registration, startup jobs
  preload.ts                contextBridge → window.mp
  services/
    db.ts                   better-sqlite3 schema + migrations
    settings-store.ts       JSON persistence + deep-merge
    cover-art.ts            Central save-album-art helper (cache or album folder)
    metadata-providers.ts   MB / CAA / Deezer with throttling
    ffmpeg.ts               Wraps ffmpeg-static for MP3 conversion
    playlist-export.ts      M3U8 write / parse / import orchestrator
  ipc/
    library.ts              tracks / albums / artists / stats / delete / artist detail
    scan.ts                 Recursive walk + tag parse + background art fetch
    metadata.ts             Provider list + test endpoints
    playlists.ts            Playlists + likes (auto-exports on every write)
    convert.ts              FLAC→MP3 per-album pipeline with progress events
    stats.ts                Play events + overview aggregations
    settings.ts             get/set
    visualizer.ts           Plugin discovery (built-in + bundled Milkdrop + user dirs)
shared/
  types.ts                  Shared TS types + IPC channel names
src/
  audio/AudioEngine.ts      AnalyserNode + beat/BPM detection
  visualizer/
    plugin-api.ts           Backend contract + factory registry
    host.ts                 Canvas lifecycle + rAF loop
    backends/builtin.ts     Canvas2D built-ins
    backends/milkdrop.ts    butterchurn wrapper
  store/                    Zustand (player, library)
  hooks/                    useScanProgress, useLibraryRefresh
  lib/mediaUrl.ts           Build mp-media:// URLs
  components/               Sidebar, TopBar, NowPlayingBar, TrackRow, AlbumCard,
                            FirstRun, SortHeader, ScanProgressPanel, ArtStatusStrip,
                            LibraryStatsPanel, ShrinkAlbumButton
  views/                    Home, Library, Albums, Album (detail), Artists,
                            Artist (detail), Playlist, Playlists, Visualizer,
                            Settings/*
scripts/
  inspect-db.mjs            Diagnostic helper (run via electron-as-node)
  test-walk.mjs             Walk test harness
  test-parse.mjs            music-metadata smoke test
run.bat / run.sh            First-run installer + dev launcher
```

## Roadmap

- Wire Last.fm / Discogs / AcoustID provider HTTP bodies (interfaces exist; stubs in `metadata-providers.ts`)
- AccurateRip / CTDB verification panel on album detail view
- Drag-and-drop playlist reordering (IPC is ready)
- MPRIS D-Bus bridge for KDE Plasma media controls
- macOS MediaSession Now Playing widget
- Lyrics panel (plain `.lrc` file alongside audio)
- AVS preset backend (JS port exists)
- Optional Windows-only `node-ffi-napi` bridge for native Winamp `vis_*.dll` plugins
