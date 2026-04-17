import { app, BrowserWindow, ipcMain, dialog, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerSettingsIpc } from './ipc/settings';
import { registerLibraryIpc } from './ipc/library';
import { registerScanIpc } from './ipc/scan';
import { registerVisualizerIpc } from './ipc/visualizer';
import { registerMetadataIpc } from './ipc/metadata';
import { registerPlaylistsIpc } from './ipc/playlists';
import { initDatabase } from './services/db';
import { initSettings } from './services/settings-store';

const isDev = !app.isPackaged;

// Must be called BEFORE app.ready. Marks our media protocol as standard so
// ranged requests work (required for large audio files to seek/scrub).
protocol.registerSchemesAsPrivileged([
  { scheme: 'mp-media', privileges: { standard: true, secure: true, stream: true, bypassCSP: true, supportFetchAPI: true } },
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
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // __dirname at runtime is dist-electron/electron — the Vite bundle lives at ../../dist.
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Register a custom protocol so we can serve music files + cover art to the renderer
// without exposing raw filesystem paths to the web context.
function registerMediaProtocol() {
  protocol.handle('mp-media', async (req) => {
    const url = new URL(req.url);
    const filePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    try {
      const fileUrl = pathToFileURL(filePath);
      return fetch(fileUrl.toString());
    } catch (err) {
      return new Response('Not found', { status: 404 });
    }
  });
}

app.whenReady().then(async () => {
  await initSettings();
  await initDatabase();

  registerMediaProtocol();

  registerSettingsIpc(ipcMain);
  registerLibraryIpc(ipcMain, () => mainWindow);
  registerScanIpc(ipcMain, () => mainWindow);
  registerVisualizerIpc(ipcMain);
  registerMetadataIpc(ipcMain);
  registerPlaylistsIpc(ipcMain);

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
