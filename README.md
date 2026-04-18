# MusicPlayer

A personal, local-first music player with a Spotify-style interface — Electron + React + TypeScript desktop app for Windows, macOS and Linux (including KDE Plasma).

## Easiest: download the installer

No Node.js, Git, or terminal needed — just download and run.

1. Go to **https://github.com/SixOfFive/musicplayer/releases/latest**
2. Grab the installer for your OS:
   - **Windows** — `MusicPlayer-Setup-X.Y.Z.exe`
   - **macOS** — `MusicPlayer-X.Y.Z.dmg` *(not code-signed yet — see note below)*
   - **Linux** — `MusicPlayer-X.Y.Z.AppImage`
3. **Windows:** double-click the `.exe`, pick an install folder, done. **macOS:** mount the `.dmg`, drag to Applications. **Linux:** `chmod +x MusicPlayer-*.AppImage` and run it.
4. Launch from your Start Menu / Launchpad / application menu.

The installer bundles everything: the app, Electron runtime, SQLite, FFmpeg for FLAC→MP3 conversion, butterchurn visualizer with 100 Milkdrop presets, all metadata providers. It's about **~170 MB** on disk after install.

**First launch Windows warnings (one-time):**
- **SmartScreen** ("Windows protected your PC") → **More info** → **Run anyway**. The installer isn't code-signed yet (costs ~$200/year for a cert).
- **Antivirus** may quarantine the bundled `ffmpeg.exe`. Whitelist that file if it does.

**macOS note:** without a Developer ID cert, Gatekeeper will block the DMG on first open. Control-click the `.app` → **Open** → **Open**. Only needed once.

### Updating a packaged install

**Automatic.** When a newer release is on GitHub, the installer version of the app detects it on startup and downloads the new installer in the background. You'll see a blue progress bar in the banner at the top; when it finishes it flips green ("Update ready — restart to install") and one click applies the update + relaunches. Your library, settings, and liked songs are preserved.

If auto-update can't reach GitHub (offline / firewall / corporate proxy), just download the new `.exe` from the Releases page and run it manually — it upgrades in place.

---

## Cutting a new release (maintainer notes)

Version tag and `package.json.version` must match exactly, or CI aborts with a clear error. To keep them in sync automatically, use:

```bash
npm run release:patch    # 0.1.0 → 0.1.1
npm run release:minor    # 0.1.0 → 0.2.0
npm run release:major    # 0.1.0 → 1.0.0
```

Each script runs `npm version <level>`, which:
1. Bumps `package.json` + `package-lock.json`
2. Creates a git commit `Release v0.X.Y`
3. Tags that commit `v0.X.Y`
4. Pushes the commit + tag

The tag push triggers the `build` workflow with `--publish always`, which creates a GitHub Release and uploads the Windows `.exe`, macOS `.dmg`, Linux `.deb`/`.rpm`/`.tar.gz`, plus the `latest.yml` metadata files `electron-updater` reads. A few minutes later, every installed user gets the blue banner.

---

## Installing on Windows from source — step by step

Use this path if you want the latest `main` branch, plan to hack on the code, or want in-app `git pull`-style updates. This walkthrough assumes no prior terminal experience.

### What you need before you start

- **Windows 10** (21H2+) or **Windows 11**. 64-bit only.
- An internet connection (for downloading Node.js and the app's dependencies).
- About **2 GB of free disk space** after dependencies are installed.
- A folder somewhere on your drive(s) that actually contains music files (`.mp3`, `.flac`, `.wav`, `.m4a`, etc.). Can be a network share / mapped drive — the app handles both.

### Step 1 — Install Node.js (LTS)

Node.js is the JavaScript runtime the app is built on. Electron itself is bundled inside the project's dependencies, but **Node.js needs to be installed system-wide** before you can install those dependencies.

1. Go to **https://nodejs.org**
2. On the home page you'll see two big green buttons. Click the one labeled **"LTS"** (Long-Term Support). It'll say something like *"Recommended For Most Users"*. As of writing, the LTS version is 22.x; anything **≥ 18** works.
3. Download the **Windows Installer (.msi)** — `node-vXX.XX.X-x64.msi` (the 64-bit version).
4. Double-click the downloaded installer.
5. Click **Next** through the wizard. You can keep every default — do NOT uncheck anything. In particular, leave these checked:
   - **Add to PATH**  *(critical — this lets our `run.bat` find `node` and `npm`)*
   - **Automatically install the necessary tools** *(optional — skip if you want; we don't need native compilers)*
6. Click **Install**. It takes a minute.
7. Click **Finish** when done.

**Verify Node is installed.** Press `Win+R`, type `cmd`, press Enter. In the black window that opens, type:

```
node -v
npm -v
```

Each should print a version number (e.g. `v22.11.0` and `10.9.0`). If you get *"'node' is not recognized…"*, close the cmd window, open a new one (the PATH change doesn't apply to already-open terminals), and try again. If it still fails, reboot and try once more.

### Step 2 — Install Git (recommended)

Git lets you clone the repository AND lets the app's built-in updater fetch new versions. **Strongly recommended** — without Git the updater can still check for updates but can't apply them automatically.

1. Go to **https://git-scm.com/download/win** — the 64-bit standalone installer downloads automatically.
2. Double-click the installer.
3. Accept defaults through every screen (there are many — just hit **Next** repeatedly). The important defaults are:
   - *"Git from the command line and also from 3rd-party software"* — yes.
   - *"Use bundled OpenSSH"* — yes.
   - *"Checkout as-is, commit Unix-style line endings"* — fine.
4. Click **Install** and wait.

Verify: new `cmd` window → `git --version` → should print a version.

### Step 3 — Get the code

You have two options:

**Option A — Clone with Git (recommended, lets the app self-update).** In a `cmd` window:

```
cd %USERPROFILE%\Documents
git clone https://github.com/SixOfFive/musicplayer.git
cd musicplayer
```

This puts the code in `Documents\musicplayer`.

**Option B — Download a zip (simpler, but no in-app updates).**

1. Open https://github.com/SixOfFive/musicplayer in a browser.
2. Click the green **Code** button → **Download ZIP**.
3. Move the downloaded zip somewhere permanent (e.g. `Documents\`).
4. Right-click the zip → **Extract All…** → pick a destination (e.g. `Documents\musicplayer`).

### Step 4 — Launch the app

Open the `musicplayer` folder in File Explorer. Find **`run.bat`** (it has a little gear icon).

**Double-click `run.bat`.**

What happens the first time:

1. A black terminal window appears.
2. It detects Node.js on your PATH. If not found, it tells you clearly and exits — go back to Step 1.
3. It runs `npm install`, which downloads ~500 MB of dependencies (Electron, React, butterchurn, ffmpeg-static, etc.). This takes **5–10 minutes** on a decent connection and is only this slow the *first* time. You'll see a lot of progress spinners and warnings — warnings are normal and harmless.
4. It re-links native modules (better-sqlite3) against Electron's Node ABI — another 30 seconds.
5. Verifies the bundled `ffmpeg.exe` is present (used for the "shrink album" FLAC→MP3 feature). If it got truncated during download, the script auto-runs `npm rebuild ffmpeg-static` to re-fetch it.
6. Finally, it launches both **Vite** (the dev server) and **Electron** (the actual window). The MusicPlayer window opens.

On subsequent launches, steps 3–5 are skipped unless something changed (the script compares `package.json` mtime against the last-install marker). Startup drops to ~10 seconds.

**If Windows SmartScreen warns you** about `run.bat` or `npm`, click **More info** → **Run anyway**. (The scripts are plain text; you can read them in Notepad before running.)

**If your antivirus quarantines `node_modules\ffmpeg-static\ffmpeg.exe`**, whitelist that path. It's the bundled FFmpeg binary from the official `ffmpeg-static` npm package — benign but some AV engines flag any unsigned ffmpeg build.

### Step 5 — First-run setup inside the app

When the MusicPlayer window first opens you'll see a welcome dialog asking for your music folder:

1. The path shown is the default picked by Windows (`C:\Users\<you>\Music`). If that's where your music lives, just click **Start scanning**.
2. Otherwise click **Choose folder…** and browse to where it actually is (a drive letter like `M:\` or a full path to a shared folder works fine).
3. Click **Start scanning**. The scan panel takes over the Home view showing progress. Small libraries (<1000 files) finish in seconds; large libraries (tens of thousands of FLACs) can take 5–15 minutes.
4. While the tag scan runs, a **background cover-art fetch** also runs in parallel. A purple strip at the bottom of the window shows its progress. Online art comes from MusicBrainz + Cover Art Archive + Deezer (no keys needed).
5. As albums fill in with covers, the Home, Albums, and Artists views update live — you don't need to reload.

### Step 6 — Day-to-day use

- To **launch** after the first install: just double-click `run.bat` again.
- To **update** the app: the yellow banner at the top announces new commits. Click **Update now** → it runs `git pull --ff-only` → click **Reload now**. If `package.json` changed, the next full `run.bat` restart auto-reinstalls dependencies.
- To **close**: close the window or press `Ctrl+C` in the terminal.

### Troubleshooting Windows

- **"node is not recognized"** → Node.js wasn't installed or PATH didn't update. Reinstall with *"Add to PATH"* checked, reboot.
- **run.bat closes instantly** → Open `cmd`, `cd` to the project folder, run `run.bat` from there so you can read any error.
- **"repository not found" during update** → you downloaded the zip instead of cloning. Reinstall via Option A above.
- **Blank window after launch** → open DevTools (**F12**) and check the console. Report the first red line.
- **ffmpeg missing after install** → `npm rebuild ffmpeg-static` in the project folder, or just re-run `run.bat`.

---

## Other platforms (brief)

**macOS / Linux:**

```bash
# one-time: install Node.js LTS via your preferred method
#   macOS:   brew install node
#   Debian:  sudo apt install nodejs npm
#   Fedora:  sudo dnf install nodejs npm
#   Arch:    sudo pacman -S nodejs npm

# then:
git clone https://github.com/SixOfFive/musicplayer.git
cd musicplayer
./run.sh
```

`run.sh` mirrors `run.bat` — checks Node + npm, warns about missing GTK/alsa/nss libs on Linux, installs deps, verifies the bundled ffmpeg, launches.

**Manual commands** (any platform):

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
