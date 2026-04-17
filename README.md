# MusicPlayer

A personal, local-first music player with a Spotify-style interface — Electron + React + TypeScript desktop app for Windows, macOS and Linux (including KDE Plasma).

## What's in here

This is a scaffold. The architecture and every major subsystem is wired; most "happy paths" work. Expect stubs where noted.

### Features scaffolded

- **Spotify-style UI** — left sidebar (navigation + playlists), top bar (back/forward, search), main content, bottom now-playing bar.
- **Local library** — SQLite (via `better-sqlite3`), with tables for tracks/albums/artists/directories/playlists/likes. Recursive folder scan reading ID3/Vorbis/APE/MP4 tags via `music-metadata`.
- **Out-of-the-box codecs** — see [Supported audio formats](#supported-audio-formats) below.
- **First-run welcome picker** — defaults to the OS-standard music folder (`~/Music` on macOS, `%USERPROFILE%\Music` on Windows, XDG `MUSIC` on Linux/KDE).
- **Playlists** — manual create/rename/delete, reorder IPC, and an auto-populated **Liked Songs** master playlist. Right-click any track for an "Add to…" menu.
- **Sortable lists** — tracks and albums sort by title/artist/album/year/genre/duration/track #/date added, ascending or descending.
- **Genre & year** — stored per track (from tags) and per album (promoted from the first track). Genre filter in the Albums view.
- **Safe deletion** — off by default. When enabled in Settings, right-click offers "Delete file" which uses `shell.trashItem` (cross-platform move-to-trash). Library-only removal is always available.
- **Real-time audio analysis bus** — a shared `AudioEngine` wraps the HTMLAudioElement through an `AnalyserNode` and produces `AudioFrame` objects every animation frame with:
  - raw FFT bins (bytes + floats),
  - time-domain waveform,
  - band energies (bass/mid/treble/loudness),
  - onset-based beat detection with a rolling BPM estimate and beat-phase.
- **Visualizer with a pluggable backend API** — see [Visualizers & plugins](#visualizers--plugins) below.
- **Settings UI** with four tabs:
  - *Library* — add/remove music folders, view scan progress, DB & cover-art cache paths, toggle for destructive file operations.
  - *Scanning & Metadata* — incremental vs full, cover-art fetching, write-back-tags toggle, file extensions list, per-provider toggles + API key entry + connection test.
  - *Visualizer* — target FPS, beat sensitivity, smoothing, fullscreen-on-play, plugin search folders, active plugin selector.
  - *Playback* — crossfade, ReplayGain mode.

## Running

```bash
npm install
npm run rebuild         # build better-sqlite3 against Electron's Node ABI
npm run electron:dev    # Vite + Electron in parallel
```

Build installers:

```bash
npm run electron:build  # platform installer via electron-builder
```

## Supported audio formats

Out of the box the scanner looks for these extensions (configurable in Settings → Scanning & Metadata → File extensions):

| Ext | Container / codec | Tag format read | Playback | Notes |
|---|---|---|---|---|
| `.mp3` | MPEG-1 Layer III | ID3v1, ID3v2.3, ID3v2.4 | ✅ | Standard. |
| `.flac` | FLAC (lossless) | Vorbis Comments | ✅ | Full lossless support. |
| `.wav` | RIFF/WAV (PCM) | ID3, LIST INFO | ✅ | Uncompressed PCM. Tags optional. |
| `.m4a` | MPEG-4 / AAC or ALAC | iTunes MP4 atoms | ✅ | Apple Lossless (ALAC) and AAC both supported. |
| `.aac` | raw ADTS AAC | ID3v2 | ✅ | |
| `.ogg` | Ogg Vorbis | Vorbis Comments | ✅ | |
| `.opus` | Ogg Opus | Vorbis Comments | ✅ | |
| `.wma` | Windows Media Audio | ASF | ⚠️ | Electron's Chromium plays WMA on Windows builds; Linux/macOS builds of Chromium ship without the proprietary decoder. Tags still read on all platforms.|

Less common formats the tag parser (`music-metadata`) can read but that aren't enabled by default — add them in Settings if you use them:

- `.aiff` / `.aif` — AIFF (PCM or compressed), ID3 tags
- `.aifc` — compressed AIFF
- `.mpc` / `.mp+` — Musepack, APE tags
- `.wv` — WavPack, APE tags
- `.ape` — Monkey's Audio, APE tags
- `.dsf` / `.dff` — DSD Stream File / DSDIFF, DSD tags
- `.mka` — Matroska audio, Matroska tags
- `.webm` — audio-only WebM
- `.tak` — Tom's lossless Audio Kompressor
- `.tta` — True Audio

Note: tag reading ≠ playback. Adding `.ape` or `.mpc` to the extensions list lets the scanner index those files, but Electron/Chromium has no built-in decoder for them — they'd scan but fail to play. mp3/wav/flac/m4a/aac/ogg/opus play everywhere.

## Storage & standards

- **Music folder default** — `app.getPath('music')`, which returns:
  - macOS: `~/Music`
  - Linux (including KDE Plasma): XDG `XDG_MUSIC_DIR` (typically `~/Music`)
  - Windows: the "Music" shell known folder (`%USERPROFILE%\Music` by default)
- **Library database & cover-art cache** — `app.getPath('userData')`:
  - macOS: `~/Library/Application Support/MusicPlayer/library.db`
  - Linux: `~/.config/MusicPlayer/library.db`
  - Windows: `%APPDATA%\MusicPlayer\library.db`
- **Tag standards read** — ID3v1/v2.3/v2.4 (MP3, WAV), Vorbis Comments (FLAC, OGG, OPUS), APE (MPC, WavPack), iTunes MP4 atoms (M4A/AAC), ASF (WMA).
- **Cover art** — embedded art is extracted and cached as `album_<id>.<ext>`. When embedded art is missing, the scan providers in Settings are consulted in order.

## Metadata & integrity providers

Configured per-provider in Settings → Scanning & Metadata. All are free to use; some need a free API key.

| Provider | What it gives | Key |
|---|---|---|
| **MusicBrainz** | Canonical artist/album/track IDs (MBIDs), release metadata | No (rate-limited 1 req/s) |
| **Cover Art Archive** | Front/back cover art keyed to MBIDs | No |
| **Last.fm** | Artist bios, similar artists, play counts, secondary art | Free key |
| **Discogs** | Physical-media metadata (labels, catalogs), cover art | Free token |
| **Deezer** | Fast 1000×1000 album art via public search API | No |
| **AcoustID / Chromaprint** | Fingerprint → MusicBrainz match for tag-less files | Free key + `fpcalc` |
| **AccurateRip** | Per-track CRC32 of decoded audio samples for verified CD rips | No |
| **CUETools DB (CTDB)** | Alternative CRC/verification DB with wider coverage | No |

AccurateRip and CTDB are the answer to *"is there an online catalog with CRC checks for songs/albums?"* — yes: they're the databases EAC, dBpoweramp and XLD query, and both expose simple HTTP endpoints. Only meaningful for lossless files (flac/wav/aiff).

## Visualizers & plugins

### Architecture

```
<audio>  ─►  MediaElementSource  ─►  AnalyserNode  ─►  GainNode  ─►  destination
                                        │
                                        └── getByte*Data every rAF ─► AudioFrame bus
                                                                           │
                                                                           ▼
                        ┌─────────────────────────────────────────────────────────┐
                        │  VisualizerHost (canvas)                                │
                        │    loads one backend at a time:                         │
                        │      builtin   →  src/visualizer/backends/builtin.ts    │
                        │      milkdrop  →  butterchurn (WebGL)                   │
                        │      avs       →  (stub)                                │
                        │      native-winamp  →  (stub, Windows-only bridge)      │
                        └─────────────────────────────────────────────────────────┘
```

Every backend implements the same `VisualizerBackend` interface (see `src/visualizer/plugin-api.ts`) and receives an `AudioFrame` each animation frame. That frame already contains FFT bins, waveform, bass/mid/treble energies, a `beat` flag with `beatIntensity`, and a running `bpm` — so plugins can sync to the beat without running their own DSP.

### Winamp plugin reality

Classic Winamp visualization plugins (`vis_*.dll`) are Windows-native C/C++ binaries built against the Winamp SDK. They can't be loaded by Electron/React directly, and they don't work on macOS or Linux at all. The practical path is:

- **Milkdrop presets (`.milk`)** — *the* iconic Winamp visualizer format — **are supported cross-platform** via [butterchurn](https://github.com/jberg/butterchurn), a WebGL port of Milkdrop 2. Drop `.milk` files in any folder listed under Settings → Visualizer → Plugin folders.
- **AVS presets** — possible via a JS port; backend not implemented yet.
- **Native `vis_*.dll`** — the app *lists* them (so you can see they're present) but marks them unloadable. A future Windows-only bridge using `node-ffi-napi` could call into the Winamp vis API; the `native-winamp` backend kind is reserved for that.

### Built-ins

`Spectrum Bars`, `Mirror Bars`, `Oscilloscope`, `Radial Spectrum`, `Beat Particles` — all Canvas2D, no external assets.

### Bundled sample Milkdrop presets

20 classic Milkdrop presets ship as test plugins out of the box (Martin, Flexi, Geiss, Aderrasi, Fishbrane, Rovastar, Zylot, …). They're resolved from the `butterchurn-presets` npm package at runtime.

## Project layout

```
electron/          Main process
  main.ts          Window, protocol, IPC registration
  preload.ts       contextBridge → window.mp
  services/
    db.ts          better-sqlite3 schema
    settings-store.ts
  ipc/
    library.ts     tracks/albums/artists/search/sort/delete
    scan.ts        recursive walk + music-metadata
    metadata.ts    provider list + test endpoints
    playlists.ts   playlists + likes
    settings.ts    get/set
    visualizer.ts  plugin discovery (built-in + bundled Milkdrop + user folders)
shared/
  types.ts         shared TypeScript types + IPC channel names
src/
  audio/
    AudioEngine.ts single engine instance (AnalyserNode + beat/BPM)
  visualizer/
    plugin-api.ts  backend contract + registry
    host.ts        VisualizerHost (canvas lifecycle + rAF loop)
    backends/
      builtin.ts   Canvas2D built-ins
      milkdrop.ts  butterchurn wrapper
  store/           Zustand stores (player, library)
  components/      Sidebar, TopBar, NowPlayingBar, TrackRow, FirstRun, SortHeader
  views/           Home, Library, Albums, Artists, Playlist, Visualizer
    settings/      LibrarySettings, ScanSettings, VisualizerSettings, PlaybackSettings
```

## Roadmap / obvious next steps

- Wire the metadata providers into the scan pipeline (interfaces exist; HTTP calls are stubbed).
- Drag-and-drop playlist reordering (the IPC is ready).
- Album detail view with play-all.
- MPRIS bridge for KDE Plasma media controls; `MediaSession` API for macOS Now Playing.
- Fingerprint-based track identification via Chromaprint.
- AccurateRip / CTDB verification panel on album detail view.
- Optional Windows-only `node-ffi-napi` bridge for native `vis_*.dll` plugins.
