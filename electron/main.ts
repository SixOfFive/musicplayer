import { app, BrowserWindow, ipcMain, dialog, protocol, net, session } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { registerSettingsIpc } from './ipc/settings';
import { registerLibraryIpc } from './ipc/library';
import { registerScanIpc, setProgressWindow, resumeArtFetchOnStartup } from './ipc/scan';
import { registerVisualizerIpc } from './ipc/visualizer';
import { registerMetadataIpc } from './ipc/metadata';
import { registerPlaylistsIpc } from './ipc/playlists';
import { registerStatsIpc } from './ipc/stats';
import { registerConvertIpc } from './ipc/convert';
import { registerUpdateIpc } from './ipc/update';
import { registerRadioIpc } from './ipc/radio';
import { registerLastFmIpc } from './ipc/lastfm';
import { setAutoUpdaterWindow } from './services/updater';
import { importPlaylistsFromFolder } from './services/playlist-export';
import { initDatabase } from './services/db';
import { initSettings, getSettings } from './services/settings-store';

const isDev = !app.isPackaged;

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

/**
 * Stat a file path, falling back to a parent-directory listing if the OS
 * returns ENOENT. This works around a real bug we saw reproducing across
 * both Windows and Linux SMB clients:
 *
 * User's library contains a Kesha track literally titled "Yippee-Ki-Yay."
 * (trailing period), producing the filename "Yippee-Ki-Yay..flac" — two
 * dots in a row before the extension. On a freshly-mounted SMB share,
 * `fs.stat` against that path succeeds normally. After the share is
 * heavily exercised (cover art scrolls, other tracks played), Windows'
 * SMB client name-resolution cache + Win32 path-canonicalization
 * intermittently desync: `fs.stat` returns ENOENT for the exact same
 * path that worked minutes earlier, and the underlying file still
 * exists. The same disconnect happens on the Linux SMB/CIFS side for
 * the same file.
 *
 * The renderer sees a DEMUXER_ERROR_COULD_NOT_OPEN, the audio element
 * freezes mid-play, and the user thinks the app is broken even though
 * the file is literally there on disk. Auto-skipping was added in the
 * player store for the "file genuinely missing" case, but that's
 * heavy-handed when the file IS present — we should play it.
 *
 * Fallback tiers, tried in order:
 *   1. Exact match (shouldn't reach here — stat missed — but harmless)
 *   2. Case-insensitive match (SMB shares sometimes report case
 *      differently than how the DB stored it during scan)
 *   3. Dot-normalized match on the basename stem — strips trailing
 *      dots from the part before the final extension. Catches the
 *      Yippee-Ki-Yay..flac ↔ Yippee-Ki-Yay.flac class of mismatches
 *      in either direction.
 *
 * `readdir` is less aggressively cached than `stat` on most SMB clients,
 * so it tends to see the real, uncanonicalized filename even when stat
 * is "lying".
 *
 * Returns the resolved absolute path + its stat; throws the original
 * ENOENT if no fallback matched.
 */
async function statWithFallback(requested: string): Promise<{ path: string; stat: import('node:fs').Stats }> {
  try {
    const st = await fs.stat(requested);
    return { path: requested, stat: st };
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;

    const dir = path.dirname(requested);
    const targetName = path.basename(requested);
    let entries: string[];
    try { entries = await fs.readdir(dir); }
    catch { throw err; /* folder itself unreachable — surface the original ENOENT */ }

    // Tier 1: exact
    let hit = entries.find((e) => e === targetName);
    // Tier 2: case-insensitive
    if (!hit) hit = entries.find((e) => e.toLowerCase() === targetName.toLowerCase());
    // Tier 3: dot-normalized (strip trailing dots from the stem before ext)
    if (!hit) {
      const normalize = (name: string) => {
        const ext = path.extname(name);
        const stem = ext ? name.slice(0, -ext.length) : name;
        return (stem.replace(/\.+$/, '') + ext).toLowerCase();
      };
      const normalizedTarget = normalize(targetName);
      hit = entries.find((e) => normalize(e) === normalizedTarget);
    }
    if (!hit) throw err;

    const resolved = path.join(dir, hit);
    const st = await fs.stat(resolved);
    process.stdout.write(`[mp-media] fallback resolved "${targetName}" → "${hit}" in ${dir}\n`);
    return { path: resolved, stat: st };
  }
}

// Content-type lookup for the file extensions we serve. Browsers match on
// `audio/*` / `image/*` to pick a decoder; mismatched MIME can silently
// disable playback or cause Range requests to be skipped.
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

app.whenReady().then(async () => {
  await initSettings();
  await initDatabase();

  enableUniversalCors();
  registerMediaProtocol();

  registerSettingsIpc(ipcMain);
  registerLibraryIpc(ipcMain, () => mainWindow);
  registerScanIpc(ipcMain, () => mainWindow);
  setProgressWindow(() => mainWindow);
  registerVisualizerIpc(ipcMain);
  registerMetadataIpc(ipcMain);
  registerPlaylistsIpc(ipcMain);
  registerStatsIpc(ipcMain);
  registerConvertIpc(ipcMain, () => mainWindow);
  registerUpdateIpc(ipcMain);
  registerRadioIpc(ipcMain, () => mainWindow);
  registerLastFmIpc(ipcMain);
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
