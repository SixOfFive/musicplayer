import type { IpcMain } from 'electron';
import { shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { IPC, type VisualizerPlugin } from '../../shared/types';
import { getSettings } from '../services/settings-store';

// Built-in visualizers that ship with the app (no external files required).
const BUILTINS: VisualizerPlugin[] = [
  { id: 'builtin:bars', name: 'Spectrum Bars', kind: 'builtin', source: 'bars', builtin: true, enabled: true, author: 'MusicPlayer' },
  { id: 'builtin:bars-mirror', name: 'Mirror Bars', kind: 'builtin', source: 'bars-mirror', builtin: true, enabled: true, author: 'MusicPlayer' },
  { id: 'builtin:wave', name: 'Oscilloscope', kind: 'builtin', source: 'wave', builtin: true, enabled: true, author: 'MusicPlayer' },
  { id: 'builtin:radial', name: 'Radial Spectrum', kind: 'builtin', source: 'radial', builtin: true, enabled: true, author: 'MusicPlayer' },
  { id: 'builtin:particles', name: 'Beat Particles', kind: 'builtin', source: 'particles', builtin: true, enabled: true, author: 'MusicPlayer' },
];

// Bundled Milkdrop presets come from the `butterchurn-presets` package — but
// that's an ESM browser module, so we can't require() it here in the CJS main
// process. The renderer enumerates them itself (see src/visualizer/preset-list.ts)
// and merges the list with what this IPC returns.

async function scanUserPluginDirs(dirs: string[]): Promise<VisualizerPlugin[]> {
  const out: VisualizerPlugin[] = [];
  for (const dir of dirs) {
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const full = path.join(dir, e.name);
      const lower = e.name.toLowerCase();
      if (lower.endsWith('.milk')) {
        out.push({
          id: `milkdrop:file:${full}`,
          name: path.basename(e.name, '.milk'),
          kind: 'milkdrop',
          source: full,
          builtin: false,
          enabled: true,
        });
      } else if (lower.endsWith('.dll')) {
        // Winamp vis_*.dll — registered but not loadable cross-platform.
        // A future Windows-only bridge could handle these.
        out.push({
          id: `native-winamp:${full}`,
          name: path.basename(e.name, '.dll'),
          kind: 'native-winamp',
          source: full,
          builtin: false,
          enabled: false,
        });
      }
    }
  }
  return out;
}

export function registerVisualizerIpc(ipcMain: IpcMain) {
  ipcMain.handle(IPC.VIS_LIST, async () => {
    const settings = getSettings();
    const user = await scanUserPluginDirs(settings.visualizer.pluginSearchPaths);
    return [...BUILTINS, ...user];
  });

  ipcMain.handle(IPC.VIS_SCAN_DIRS, async (_e, dirs: string[]) => {
    return scanUserPluginDirs(dirs);
  });

  ipcMain.handle(IPC.VIS_READ_PRESET, async (_e, src: string) => {
    // Only used for user-supplied .milk files; built-ins/sample presets are resolved in the renderer.
    try {
      const buf = await fs.readFile(src, 'utf8');
      return { ok: true, content: buf };
    } catch (err: any) {
      return { ok: false, error: err?.message };
    }
  });

  ipcMain.handle(IPC.VIS_OPEN_DIR, async (_e, dir: string) => {
    await shell.openPath(dir);
  });
}
