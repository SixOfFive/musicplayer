import { app, BrowserWindow, ipcMain, dialog, protocol, net, session, nativeImage } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { statWithFallback } from './services/fs-fallback';
import { imageMemCache, isCacheableImage, type CachedImage, persistLoad as loadImageCache, persistSaveIfDirty as saveImageCache } from './services/image-cache';
import { registerSettingsIpc } from './ipc/settings';
import { registerLibraryIpc } from './ipc/library';
import { registerScanIpc, setProgressWindow, resumeArtFetchOnStartup } from './ipc/scan';
import { registerVisualizerIpc } from './ipc/visualizer';
import { registerMetadataIpc } from './ipc/metadata';
import { registerPlaylistsIpc } from './ipc/playlists';
import { registerCopyLikedIpc } from './ipc/copy-liked';
import { probeAllLibraryDirs, setLibrarySuspect } from './services/library-health';
import { shutdownCast } from './services/cast';
import { shutdownHomeAssistant } from './services/homeassistant';
import { killAllActiveFfmpeg } from './services/ffmpeg';
import { getShutdownExitCode } from './services/shutdown-state';
import { seedDefaultVisualizerPresets } from './services/default-presets';
import { registerStatsIpc } from './ipc/stats';
import { registerConvertIpc } from './ipc/convert';
import { registerUpdateIpc } from './ipc/update';
import { registerRadioIpc } from './ipc/radio';
import { registerLastFmIpc } from './ipc/lastfm';
import { registerCastIpc } from './ipc/cast';
import { registerHomeAssistantIpc } from './ipc/homeassistant';
import { registerDlnaIpc } from './ipc/dlna';
import { startDlnaDiscovery, startDlnaReceiver, shutdownDlna } from './services/dlna';
import { stopMediaServer } from './services/media-server';
import { unregisterMediaKeys } from './services/media-keys';
import { registerMediaKeys } from './services/media-keys';
import { registerSuggestionsIpc } from './ipc/suggestions';
import { registerTagAuditIpc } from './ipc/tag-audit';
import { setAutoUpdaterWindow } from './services/updater';
import { importPlaylistsFromFolder, flushDirtyPlaylists, dirtyPlaylistCount } from './services/playlist-export';
import { initDatabase } from './services/db';
import { initSettings, getSettings } from './services/settings-store';

const isDev = !app.isPackaged;

/**
 * Soft-fail wrapper for add-on initialisers. Every non-essential
 * subsystem (Cast, Home Assistant, DLNA sender, DLNA receiver) is
 * registered via this helper so a failure at register time — missing
 * native module, network binding refused, malformed settings — logs
 * and returns instead of throwing and aborting app startup.
 *
 * Essential services (DB, settings, IPC for the local library) stay
 * un-wrapped because if they fail there's no useful app to run anyway.
 */
function safeInit(label: string, fn: () => void): void {
  try { fn(); }
  catch (err: any) {
    process.stdout.write(`[soft-fail] ${label}: ${err?.message ?? err}\n${err?.stack ?? ''}\n`);
  }
}
function safeInitAsync(label: string, fn: () => Promise<unknown>): void {
  try {
    Promise.resolve(fn()).catch((err: any) => {
      process.stdout.write(`[soft-fail] ${label} (async): ${err?.message ?? err}\n${err?.stack ?? ''}\n`);
    });
  } catch (err: any) {
    process.stdout.write(`[soft-fail] ${label} (sync throw): ${err?.message ?? err}\n`);
  }
}

// Must be called BEFORE app.ready. `corsEnabled` + a real host in the URL is
// what stops Chromium's HTMLMediaElement from rejecting the source with
// "Media load rejected by URL safety check" — without it, the `<audio>`
// element treats the origin as opaque.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'mp-media',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      bypassCSP: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#121212',
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    // __dirname at runtime is dist-electron/electron — the Vite bundle lives at ../../dist.
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }

  // Respect the debug.openDevToolsOnStartup setting. Default off.
  try {
    const dbg = getSettings().debug;
    if (dbg?.openDevToolsOnStartup) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } catch { /* settings not initialised yet — ignore */ }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Forward renderer-side console messages to our main-process stdout so
  // they're visible in the terminal. Gated on the debug.logRendererToMain
  // setting so normal users aren't spammed.
  mainWindow.webContents.on('console-message', (_e, level, msg, line, src) => {
    try {
      if (!getSettings().debug?.logRendererToMain) return;
    } catch { return; }
    const tag = ['DEBUG', 'INFO', 'WARN', 'ERROR'][level] ?? 'LOG';
    process.stdout.write(`[renderer ${tag}] ${msg}  (${src}:${line})\n`);
  });
}

// Content-type lookup for the file extensions we serve. Browsers match on
// `audio/*` / `image/*` to pick a decoder; mismatched MIME can silently
// disable playback or cause Range requests to be skipped.
// Max dimension (in device-independent pixels) for cached cover art. Bigger
// than the largest visible placement in the UI — album detail is 224 px,
// 2× Retina puts that at 448 px, so 1024 leaves headroom while still
// dropping most "4000×4000 hi-res scan" covers to roughly their RAM weight.
const COVER_THUMB_MAX_DIM = 1024;

/**
 * Downscale an image buffer to `COVER_THUMB_MAX_DIM` on its longest side,
 * preserving aspect ratio and format. If the image is already within the
 * limit, returns the input unchanged (no re-encode, no quality loss). If
 * the buffer isn't a recognised image, returns it unchanged too — the
 * cache stores the raw bytes and the renderer falls back to the original.
 *
 * Uses Electron's built-in `nativeImage` so no extra native dep. Format
 * preservation matters: cover art is rarely an arbitrary JPEG, but
 * designed covers with transparency (PNG) shouldn't be silently flattened
 * to opaque JPEG.
 */
function thumbnailImage(raw: Buffer, contentType: string): { bytes: Buffer; contentType: string } {
  // GIFs can be animated — nativeImage would freeze them on the first
  // frame. Almost never the case for covers, but cheap to respect.
  if (contentType === 'image/gif') return { bytes: raw, contentType };

  let img;
  try { img = nativeImage.createFromBuffer(raw); }
  catch { return { bytes: raw, contentType }; }
  if (img.isEmpty()) return { bytes: raw, contentType };

  const { width, height } = img.getSize();
  if (width <= COVER_THUMB_MAX_DIM && height <= COVER_THUMB_MAX_DIM) {
    // Already small — no point re-encoding.
    return { bytes: raw, contentType };
  }
  const scale = COVER_THUMB_MAX_DIM / Math.max(width, height);
  const resized = img.resize({
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    quality: 'best',
  });

  // PNG preserves transparency. JPEG at quality 85 is the right balance
  // for photo-like covers; the default (unspecified) falls near 80 on
  // Chromium which is very slightly more artifact-prone.
  if (contentType === 'image/png' || contentType === 'image/webp') {
    return { bytes: resized.toPNG(), contentType: 'image/png' };
  }
  return { bytes: resized.toJPEG(85), contentType: 'image/jpeg' };
}

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * Register a custom protocol so we can serve music files + cover art to the
 * renderer without exposing raw filesystem paths to the web context.
 *
 * We implement HTTP Range semantics ourselves (reading the requested byte
 * slice off disk as a stream). Electron's `net.fetch` on `file://` URLs
 * does NOT honor `Range` — it always returns 200 with the full body — which
 * silently breaks seeking and progressive loading for large lossless files:
 * `HTMLMediaElement` sees 200-for-a-Range-request, tries to decode from the
 * wrong offset, and aborts with DEMUXER_ERROR_COULD_NOT_PARSE / "PTS is not
 * defined". For 24-bit FLACs specifically the first progressive chunk
 * request (bytes=65536-) hits this path and playback dies before the user
 * hears anything.
 */
function registerMediaProtocol() {
  protocol.handle('mp-media', async (req) => {
    try {
      const url = new URL(req.url);
      // URL format differs per OS:
      //   Windows path `M:\music\foo` → encoded as `mp-media://local/M:/music/foo`
      //     → pathname `/M:/music/foo` → strip ONE leading `/` → `M:/music/foo`
      //   Unix path   `/home/foo`      → encoded as `mp-media://local//home/foo`
      //     → pathname `//home/foo` → strip ONE leading `/` → `/home/foo`
      // A greedy `replace(/^\/+/, '')` would eat the Unix root slash.
      // Decode per-segment so `%` literals in filenames aren't double-decoded.
      const segments = url.pathname.replace(/^\//, '').split('/').map(decodeURIComponent);
      const filePath = segments.join(path.sep);
      const rangeHeader = req.headers.get('range');
      process.stdout.write(`[mp-media] req=${req.url}\n            file=${filePath}\n            range=${rangeHeader ?? 'none'}\n`);

      // statWithFallback lets us recover from SMB-client name-resolution
      // desyncs on edge-case filenames (trailing dots, case drift). If it
      // returns, `resolvedPath` is the actual on-disk path to open — we
      // must use THAT for the read stream below, not the renderer-supplied
      // path, which the OS has decided doesn't exist.
      const { path: resolvedPath, stat } = await statWithFallback(filePath);
      const size = stat.size;
      const ext = path.extname(resolvedPath).toLowerCase();
      const contentType = MIME_BY_EXT[ext] ?? 'application/octet-stream';

      // ---- Image fast-path: in-memory cache + resize on first load ----
      //
      // For cover art we bypass the streaming-range flow entirely: images
      // are small, never use Range, and get re-requested every time the
      // user scrolls back to a viewport they've already seen. Caching
      // them in main-process memory makes repeat renders instant AND
      // means we don't hammer the user's SMB share re-reading the same
      // cover.jpg hundreds of times per session.
      //
      // On the FIRST request we also thumbnail via Electron's built-in
      // nativeImage: the biggest visible cover in the UI is the album-
      // detail header at ~448 px on Retina, so anything above 1024 px
      // is wasted transfer + RAM. Typical 5 MB cover → 100-200 KB after
      // resize. Format is preserved (PNG stays PNG, JPEG stays JPEG)
      // so transparency on designed art is kept.
      if (!rangeHeader && isCacheableImage(ext)) {
        const cached = imageMemCache.get(resolvedPath);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
          process.stdout.write(`[mp-media] cache hit ${path.basename(resolvedPath)} (${cached.size} bytes in memory)\n`);
          // Response expects a Uint8Array-ish BodyInit. Node's Buffer IS
          // a Uint8Array at runtime but the TS types don't know that in
          // this tsconfig, so we hand back a plain view over the same
          // memory (no copy).
          // Cast to any — Node's Buffer is a Uint8Array at runtime but the
          // ArrayBufferLike vs ArrayBuffer generic mismatch trips TS 5.7+.
          // Response accepts this fine at runtime.
          return new Response(
            cached.bytes as any,
            {
              status: 200,
              headers: {
                'Content-Type': cached.contentType,
                'Content-Length': String(cached.size),
                // Browser can also cache short-term — helps during HMR cycles.
                'Cache-Control': 'private, max-age=3600',
              },
            }
          );
        }

        // Miss (or mtime changed) — load, thumbnail, cache.
        const raw = await fs.readFile(resolvedPath);
        const thumbnailed = thumbnailImage(raw, contentType);
        const entry: CachedImage = {
          bytes: thumbnailed.bytes,
          contentType: thumbnailed.contentType,
          size: thumbnailed.bytes.length,
          mtimeMs: stat.mtimeMs,
          lastAccess: Date.now(),
        };
        imageMemCache.set(resolvedPath, entry);
        const savings = raw.length - thumbnailed.bytes.length;
        process.stdout.write(`[mp-media] cached ${path.basename(resolvedPath)}: ${raw.length}→${thumbnailed.bytes.length} bytes${savings > 0 ? ` (−${Math.round((savings / raw.length) * 100)}%)` : ''}\n`);
        return new Response(
          entry.bytes as any,
          {
            status: 200,
            headers: {
              'Content-Type': entry.contentType,
              'Content-Length': String(entry.size),
              'Cache-Control': 'private, max-age=3600',
            },
          }
        );
      }

      // Parse `Range: bytes=<start>-<end>` (either end may be missing):
      //   bytes=0-         → start=0, end=size-1   (Chromium probes this first)
      //   bytes=65536-     → start=65536, end=size-1
      //   bytes=100-200    → start=100, end=200
      //   bytes=-500       → suffix; last 500 bytes of file
      let start = 0;
      let end = size - 1;
      let isPartial = false;
      if (rangeHeader) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
        if (m) {
          const s = m[1];
          const e = m[2];
          if (s === '' && e !== '') {
            // Suffix form: "bytes=-500" → the last 500 bytes.
            const suffix = Math.min(size, parseInt(e, 10));
            start = size - suffix;
            end = size - 1;
          } else {
            start = s === '' ? 0 : parseInt(s, 10);
            end = e === '' ? size - 1 : Math.min(parseInt(e, 10), size - 1);
          }
          // Only mark partial when the range is a real sub-slice. Some
          // browsers send `bytes=0-` as a probe for Range support; returning
          // 206 for that is also fine and more informative (tells the
          // browser the server understands ranges), but classical 200 also
          // works. We return 206 when the client explicitly asked for Range.
          isPartial = true;
          // Validate.
          if (start < 0 || end < start || end >= size) {
            process.stdout.write(`[mp-media] → 416 Range Not Satisfiable (${start}-${end} of ${size})\n`);
            return new Response('Range Not Satisfiable', {
              status: 416,
              headers: { 'Content-Range': `bytes */${size}` },
            });
          }
        }
      }

      const length = end - start + 1;
      // createReadStream's `end` is INCLUSIVE (same as Content-Range), so
      // no off-by-one correction needed here.
      const nodeStream = createReadStream(resolvedPath, { start, end });
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

      const headers = new Headers({
        'Content-Type': contentType,
        'Content-Length': String(length),
        'Accept-Ranges': 'bytes',
        // No-cache on seeks so the browser always asks us for fresh ranges
        // rather than stitching from a stale cached response.
        'Cache-Control': 'no-cache',
      });
      if (isPartial) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);

      const status = isPartial ? 206 : 200;
      process.stdout.write(`[mp-media] → status=${status} type=${contentType} length=${length}${isPartial ? ` range=${start}-${end}/${size}` : ''}\n`);
      return new Response(webStream, { status, headers });
    } catch (err: any) {
      console.error('[mp-media] error', err?.message ?? err);
      const code = err?.code === 'ENOENT' ? 404 : 500;
      return new Response(err?.message ?? 'Error', { status: code });
    }
  });
}

/**
 * Universal CORS unlocker for radio streams.
 *
 * Problem: internet radio servers (Icecast, Shoutcast) almost never send the
 * `Access-Control-Allow-Origin` response header. Without it the renderer's
 * Web Audio `MediaElementAudioSourceNode` refuses to pass audio samples
 * (Chromium mutes tainted cross-origin streams). Result: no audio AND no
 * visualizer even though the HTTP fetch succeeds.
 *
 * Fix: intercept every response in the default session and prepend
 * `Access-Control-Allow-Origin: *`. The browser then sees a CORS-approved
 * response and Web Audio lets the samples through. Since this app has a
 * single trusted origin (the local renderer), rewriting CORS on inbound
 * traffic is safe — there are no other browser contexts that could be
 * tricked into reading cross-origin data they shouldn't.
 *
 * Skips mp-media:// (local file protocol) which already has its own CORS
 * handling, and anything on localhost/127.0.0.1 (dev server / local mirrors).
 */
/**
 * Auto-grant the one permission the app legitimately needs: `media` /
 * `microphone`. We never record; the permission unlocks
 * `navigator.mediaDevices.enumerateDevices()` returning device *labels*
 * instead of generic "Audio output 1 / 2 / 3". Without labels the output-
 * device picker in the player bar can't show names the user recognises
 * (Speakers, Headphones, USB DAC, HDMI Display, etc.). Prompting the
 * user for microphone access in a music player feels wrong, so we
 * silently allow it up-front.
 *
 * Every other permission is explicitly denied.
 */
function autoGrantLocalMediaPermission() {
  const allowList = new Set(['media', 'audioCapture']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowList.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return allowList.has(permission);
  });
}

function enableUniversalCors() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    try {
      const u = details.url;
      if (u.startsWith('mp-media:') || u.startsWith('file:') || /^https?:\/\/(localhost|127\.0\.0\.1)/.test(u)) {
        callback({});
        return;
      }
      const headers = { ...(details.responseHeaders ?? {}) };
      // Drop any existing CORS header (regardless of casing) so we don't end
      // up with duplicates or a restrictive policy the server tried to set.
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'access-control-allow-origin' ||
            k.toLowerCase() === 'access-control-allow-credentials') {
          delete headers[k];
        }
      }
      headers['Access-Control-Allow-Origin'] = ['*'];
      callback({ responseHeaders: headers });
    } catch {
      // Never block the response on a failure in our header rewriter.
      callback({});
    }
  });
}

// Where the on-disk image cache lives — computed once app is ready (we
// can't call app.getPath() until then). Nullable for the pre-ready window
// but populated before any mp-media request can fire.
let imageCacheDir: string | null = null;

app.whenReady().then(async () => {
  await initSettings();
  await initDatabase();

  // ----- Library health safeguard -------------------------------------
  //
  // Probe every enabled library dir. If any is missing or empty, pop
  // a modal before we even create the main window. User choice:
  //
  //   Quit     → app.exit(0). Their mount will be back next time.
  //   Continue → set the session-wide suspect flag. We still let the
  //              app launch (music they've played recently may be in
  //              the image cache and scrobble/Last.fm still works),
  //              but every auto-cleanup path consults this flag and
  //              refuses to delete DB rows. Nothing vanishes while
  //              the share is down.
  //
  // Runs BEFORE createWindow() so the user isn't staring at a half-
  // rendered UI while the dialog fires. Uses showMessageBoxSync so
  // the startup sequence pauses until they answer.
  try {
    const healths = await probeAllLibraryDirs();
    const bad = healths.filter((h) => !h.exists || !h.nonEmpty);
    if (bad.length > 0) {
      const lines = bad.map((h) => {
        if (!h.exists) return `  • ${h.path}  — UNREACHABLE (mount down?)`;
        return `  • ${h.path}  — EMPTY (mount swapped?)`;
      });
      process.stdout.write(`[library-health] suspect dirs at startup:\n${lines.join('\n')}\n`);
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        title: 'Music library looks wrong',
        message: bad.length === 1
          ? `Your music library folder isn't available or is empty.`
          : `${bad.length} of your music library folders are unavailable or empty.`,
        detail:
          lines.join('\n') +
          `\n\nThis usually means a network drive / SMB share is offline, or a USB drive isn't plugged in.` +
          `\n\nChoose Continue to launch anyway — nothing will be automatically removed from your library while the folders look bad. Choose Quit to close the app so you can fix the mount and try again.`,
        buttons: ['Continue anyway', 'Quit'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (choice === 1) {
        process.stdout.write('[library-health] user chose Quit at startup\n');
        app.exit(0);
        return;
      }
      setLibrarySuspect(true);
      process.stdout.write('[library-health] user chose Continue — auto-cleanup DISABLED for this session\n');
    }
  } catch (err: any) {
    // If the probe itself throws (shouldn't — probeLibraryDir is
    // already try/catch'd), don't block startup. Just log it and
    // proceed. Suspect flag stays off so auto-cleanup is live;
    // per-probe healthy check will still guard deletes because it
    // re-stats the dir at delete time.
    process.stdout.write(`[library-health] startup probe failed: ${err?.message ?? err}\n`);
  }

  // Rehydrate the cover-art cache from disk before we register the media
  // protocol so the very first render can hit warm memory instead of the
  // SMB share. loadImageCache is forgiving: missing index.json, corrupt
  // blobs, anything — it just loads what it can and reports the rest.
  imageCacheDir = path.join(app.getPath('userData'), 'image-cache');
  try {
    const r = await loadImageCache(imageCacheDir);
    if (r.wiped) {
      process.stdout.write(`[image-cache] cache was corrupt — wiped; will rebuild on first render\n`);
    } else if (r.loaded > 0 || r.skipped > 0) {
      process.stdout.write(`[image-cache] restored ${r.loaded} cover${r.loaded === 1 ? '' : 's'} from disk${r.skipped > 0 ? ` (${r.skipped} skipped)` : ''}\n`);
    }
  } catch (err: any) {
    // Any uncaught exception here is treated as a hard cache failure —
    // wipe the dir so next startup gets a clean slate instead of looping
    // on the same error forever.
    process.stdout.write(`[image-cache] load threw (${err?.message ?? err}) — wiping cache dir\n`);
    try { await (await import('node:fs/promises')).rm(imageCacheDir, { recursive: true, force: true }); }
    catch { /* ignore */ }
  }

  autoGrantLocalMediaPermission();
  enableUniversalCors();
  registerMediaProtocol();

  registerSettingsIpc(ipcMain);
  registerLibraryIpc(ipcMain, () => mainWindow);
  registerScanIpc(ipcMain, () => mainWindow);
  setProgressWindow(() => mainWindow);
  registerVisualizerIpc(ipcMain);
  registerMetadataIpc(ipcMain);
  registerPlaylistsIpc(ipcMain);
  // "Copy Liked to folder" — separate IPC bundle because it uses an
  // interactive request/response protocol (conflict + error prompts)
  // that doesn't fit the invoke/reply pattern of the regular playlist
  // handlers. Soft-failed because it's a non-essential utility.
  safeInit('copy-liked-ipc',     () => registerCopyLikedIpc(ipcMain, () => mainWindow));
  registerStatsIpc(ipcMain);
  registerConvertIpc(ipcMain, () => mainWindow);
  registerUpdateIpc(ipcMain);
  registerRadioIpc(ipcMain, () => mainWindow);
  registerLastFmIpc(ipcMain);
  // Remote-sink add-ons (Cast / Home Assistant / DLNA). Each one is
  // registered behind a soft-fail guard so a broken add-on can't take
  // the whole app down. If chromecast-api fails to load on a weird
  // platform, or HA's IPC throws at register time, or node-ssdp can't
  // bind the multicast socket because a corporate firewall has closed
  // UDP 1900 — the user still gets a working local-playback app.
  safeInit('cast-ipc',           () => registerCastIpc(ipcMain, () => mainWindow));
  safeInit('homeassistant-ipc',  () => registerHomeAssistantIpc(ipcMain, () => mainWindow));
  safeInit('dlna-ipc',           () => registerDlnaIpc(ipcMain, () => mainWindow));
  // Kick off DLNA discovery + advertise this app as a renderer. Both
  // are fire-and-forget from main's perspective; the IPC listeners
  // above are already wired to relay state/progress as it arrives.
  safeInit('dlna-discovery',     () => startDlnaDiscovery());
  safeInitAsync('dlna-receiver', () => startDlnaReceiver(`MusicPlayer on ${require('node:os').hostname()}`));
  // Bind OS-level hardware media keys (Play/Pause, Next, Prev, Stop)
  // so keyboards / Bluetooth headsets / remotes can drive playback
  // even when the window isn't focused. Soft-fail because on some
  // Linux WMs without an XF86Audio* keymap this can legitimately
  // return false for every accelerator, and that's fine — the
  // navigator.mediaSession side still works via MPRIS.
  safeInit('media-keys',         () => registerMediaKeys(() => mainWindow));
  // Local recommendation engine. Pure SQL aggregates — no network, no
  // ML, no third-party APIs. Zero cost at register time; scoring only
  // runs when the renderer asks via suggestions:get.
  safeInit('suggestions-ipc',    () => registerSuggestionsIpc(ipcMain));
  safeInit('tag-audit-ipc',      () => registerTagAuditIpc(ipcMain, () => mainWindow));
  setAutoUpdaterWindow(() => mainWindow);

  // Debug: toggle DevTools on demand (used by Settings → About & Updates).
  ipcMain.handle('debug:toggle-devtools', () => {
    if (!mainWindow) return false;
    if (mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.closeDevTools();
      return false;
    }
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    return true;
  });

  // Simple directory picker wired directly here so the renderer doesn't need dialog access.
  ipcMain.handle('library:pick-dir', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a music folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Seed bundled visualizer presets into the user's folder before the
  // window opens — ensures the picker already has them on first boot.
  // Non-destructive (skips files that already exist), so re-running
  // never clobbers user tweaks.
  safeInitAsync('default-presets-seed', () => seedDefaultVisualizerPresets());

  createWindow();

  // Resume any art fetch that was interrupted by a previous session's exit.
  // Waits for the window to show its first paint so the status strip is ready
  // to receive events — otherwise the renderer might miss the initial emit.
  mainWindow?.webContents.once('did-finish-load', () => {
    setTimeout(() => { void resumeArtFetchOnStartup(); }, 1500);
    // Also one-time import any .m3u8 files already on disk (from other apps,
    // or leftover from a prior install). Non-destructive: only creates
    // playlists whose name isn't already in the DB.
    setTimeout(() => { void importPlaylistsFromFolder().catch(() => {}); }, 2000);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Flush pending work on quit. `before-quit` fires before windows start
// closing, which is the latest reliable hook for async work in
// Electron — any later and `app.exit()` can fire while writeFile is
// still pending. We explicitly event.preventDefault() and re-quit
// after the saves so the process truly waits for the flush.
//
// Two things we flush here:
//   1. Image cache — 256 MB LRU of cover thumbnails, only written if
//      it's dirty.
//   2. Pending playlist exports — when the save-mode scheduler latched
//      onto 'on-close' (or the user chose it explicitly), edits pile
//      up in an in-memory queue and only hit disk at quit time.
//      Deferring means the UI stays snappy on big-playlist edits, so
//      quit-time is when the user pays the 3-second write cost — but
//      only once for the whole session instead of on every edit.
let quitInProgress = false;

app.on('before-quit', (event) => {
  if (quitInProgress) return;
  event.preventDefault();
  quitInProgress = true;

  // HARD WATCHDOG. If anything below wedges (a stuck socket, a
  // spawned child refusing SIGTERM, a slow playlist flush on a
  // disconnected share), we still die within 3 seconds. process.exit
  // bypasses Electron + Node's event loops entirely; it's the one
  // call that's guaranteed to take effect. Tightened from 5s to 3s
  // because users were complaining about Ctrl-C waits and orphan
  // receivers showing up in LAN scans — faster watchdog means the
  // OS cleans up our sockets + helper processes sooner.
  const hardKill = setTimeout(() => {
    process.stdout.write(`[shutdown] watchdog fired — forcing process.exit(${getShutdownExitCode()})\n`);
    hardKillAllChildrenAndExit(getShutdownExitCode());
  }, 3000);
  hardKill.unref?.();

  const imageDirty = !!(imageCacheDir && imageMemCache.isDirty());
  const plDirty = dirtyPlaylistCount() > 0;

  // Per-step timeout wrapper. `Promise.race` against a hard ceiling
  // so a slow-persist never eats the whole watchdog budget.
  const withTimeout = <T,>(label: string, ms: number, p: Promise<T>): Promise<T | 'timeout'> =>
    Promise.race([
      p,
      new Promise<'timeout'>((r) => setTimeout(() => {
        process.stdout.write(`[shutdown] ${label} timed out after ${ms}ms\n`);
        r('timeout');
      }, ms)),
    ]);

  (async () => {
    process.stdout.write(`[shutdown] begin — target exit code ${getShutdownExitCode()}\n`);

    // --- 1. Persist user data first ---
    //
    // Data loss is the worst-case outcome. Playlist edits + image
    // cache go before anything else so if the watchdog eats part
    // of the shutdown, we lose sockets (recoverable) not data.
    if (plDirty) {
      try {
        const r = await withTimeout('playlist flush', 1500, flushDirtyPlaylists());
        if (r !== 'timeout' && r.errors > 0) {
          process.stdout.write(`[shutdown] ${r.errors} playlist flush error(s)\n`);
        }
      } catch (err: any) {
        process.stdout.write(`[shutdown] playlist flush FAILED: ${err?.message ?? err}\n`);
      }
    }
    if (imageDirty) {
      try { await withTimeout('image cache', 1000, saveImageCache(imageCacheDir!)); }
      catch (err: any) { process.stdout.write(`[shutdown] image cache FAILED: ${err?.message ?? err}\n`); }
    }

    // --- 2. Kill spawned child processes ---
    //
    // ffmpeg conversions MUST die with us — otherwise a Shrink-album
    // run spawned minutes ago keeps encoding in the background
    // after the user closes the window and re-opens, which then
    // corrupts the file that the OLD ffmpeg is about to rename over.
    try { killAllActiveFfmpeg(); } catch { /* noop */ }

    // --- 3. Stop every long-lived service in parallel ---
    //
    // Each of these owns sockets, timers, or mDNS bindings. Running
    // them in parallel means the whole socket+timer teardown can
    // finish within one wall-clock second even when several are
    // slow (e.g. DLNA sending SSDP byebye packets).
    await Promise.all([
      withTimeout('dlna',         1500, shutdownDlna()).catch((e) => process.stdout.write(`[shutdown] dlna err: ${e?.message ?? e}\n`)),
      withTimeout('media-server', 1500, stopMediaServer()).catch((e) => process.stdout.write(`[shutdown] media-server err: ${e?.message ?? e}\n`)),
      withTimeout('cast',         1000, shutdownCast()).catch((e) => process.stdout.write(`[shutdown] cast err: ${e?.message ?? e}\n`)),
      // HA + media-keys are sync; wrap to keep the Promise.all shape.
      Promise.resolve().then(() => {
        try { shutdownHomeAssistant(); } catch { /* noop */ }
        try { unregisterMediaKeys(); } catch { /* noop */ }
      }),
    ]);

    // --- 4. Force-kill Chromium helper processes (Linux) ---
    //
    // Electron's app.exit SHOULD kill all child processes but on
    // Linux there are edge cases where the zygote or a utility
    // process survives. Kill our whole process group to be sure,
    // BEFORE we exit ourselves — otherwise the children become
    // orphans adopted by PID 1 and linger. -pid = process group.
    // Only on Linux/macOS; Windows uses different semantics (the
    // NSIS taskkill in installer.nsh handles the Windows side).
    if (process.platform !== 'win32') {
      try {
        process.stdout.write(`[shutdown] killing process group ${process.pid}\n`);
        process.kill(-process.pid, 'SIGTERM');
      } catch { /* we might not be a group leader, fine */ }
    }

    // --- 5. Done. Terminate hard. ---
    clearTimeout(hardKill);
    process.stdout.write(`[shutdown] clean — exit(${getShutdownExitCode()})\n`);
    hardKillAllChildrenAndExit(getShutdownExitCode());
  })();
});

/**
 * Final termination. Called from both the clean-exit path and the
 * watchdog path. Nukes any remaining spawned children, then calls
 * process.exit with the target code. process.exit is synchronous
 * and bypasses the Node event loop — even if a broken service has
 * a ref'd handle we don't know about, we still die. app.exit is
 * Electron's softer cousin that can get stuck on misbehaving
 * native modules; we don't trust it for the last-mile termination.
 */
function hardKillAllChildrenAndExit(code: number): never {
  try { killAllActiveFfmpeg(); } catch { /* noop */ }
  // Kill the process group as a final sweep on POSIX. SIGKILL is
  // un-ignorable so any child that refused SIGTERM above dies here.
  if (process.platform !== 'win32') {
    try { process.kill(-process.pid, 'SIGKILL'); } catch { /* noop */ }
  }
  process.exit(code);
}
