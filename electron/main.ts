import { app, BrowserWindow, ipcMain, dialog, protocol, net, session } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

// Register a custom protocol so we can serve music files + cover art to the
// renderer without exposing raw filesystem paths to the web context.
//
// We use Electron's `net.fetch` here (NOT Node's global fetch): Electron's
// implementation has first-class support for file:// URLs, including HTTP
// Range requests — required for <audio> scrubbing/seeking on large files.
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
      const fileUrl = pathToFileURL(filePath).toString();
      process.stdout.write(`[mp-media] req=${req.url}\n            file=${filePath}\n            range=${req.headers.get('range') ?? 'none'}\n`);
      const resp = await net.fetch(fileUrl);
      process.stdout.write(`[mp-media] → status=${resp.status} type=${resp.headers.get('content-type')}\n`);
      return resp;
    } catch (err: any) {
      console.error('[mp-media] error', err?.message ?? err);
      return new Response('Not found', { status: 404 });
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
