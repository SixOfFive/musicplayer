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

// Sample Milkdrop-style presets bundled for first-run testing.
// These IDs resolve in the renderer against the butterchurn-presets package
// (which bundles thousands of real Milkdrop .milk presets).
const SAMPLE_MILKDROP: VisualizerPlugin[] = [
  { id: 'milkdrop:martin - witchcraft', name: 'Martin - Witchcraft', kind: 'milkdrop', source: 'martin - witchcraft', builtin: true, enabled: true, author: 'Martin' },
  { id: 'milkdrop:flexi - mindblob', name: 'Flexi - Mindblob', kind: 'milkdrop', source: 'flexi - mindblob', builtin: true, enabled: true, author: 'Flexi' },
  { id: 'milkdrop:geiss - thumb drum', name: 'Geiss - Thumb Drum', kind: 'milkdrop', source: 'geiss - thumb drum', builtin: true, enabled: true, author: 'Geiss' },
  { id: 'milkdrop:eo.s + phat - bouncy ball', name: 'eo.s + phat - Bouncy Ball', kind: 'milkdrop', source: 'eo.s + phat - bouncy ball', builtin: true, enabled: true, author: 'eo.s + phat' },
  { id: 'milkdrop:flexi - bouncing balls of light', name: 'Flexi - Bouncing Balls of Light', kind: 'milkdrop', source: 'flexi - bouncing balls of light', builtin: true, enabled: true, author: 'Flexi' },
  { id: 'milkdrop:shifter - kaleidoscope', name: 'Shifter - Kaleidoscope', kind: 'milkdrop', source: 'shifter - kaleidoscope', builtin: true, enabled: true, author: 'Shifter' },
  { id: 'milkdrop:fishbrane - fractal land', name: 'Fishbrane - Fractal Land', kind: 'milkdrop', source: 'fishbrane - fractal land', builtin: true, enabled: true, author: 'Fishbrane' },
  { id: 'milkdrop:che - tunnel of light', name: 'Che - Tunnel of Light', kind: 'milkdrop', source: 'che - tunnel of light', builtin: true, enabled: true, author: 'Che' },
  { id: 'milkdrop:aderrasi - airflow', name: 'Aderrasi - Airflow', kind: 'milkdrop', source: 'aderrasi - airflow', builtin: true, enabled: true, author: 'Aderrasi' },
  { id: 'milkdrop:unchained - chromatic', name: 'Unchained - Chromatic', kind: 'milkdrop', source: 'unchained - chromatic', builtin: true, enabled: true, author: 'Unchained' },
  { id: 'milkdrop:martin - acidwarp', name: 'Martin - Acidwarp', kind: 'milkdrop', source: 'martin - acidwarp', builtin: true, enabled: true, author: 'Martin' },
  { id: 'milkdrop:flexi - nebula', name: 'Flexi - Nebula', kind: 'milkdrop', source: 'flexi - nebula', builtin: true, enabled: true, author: 'Flexi' },
  { id: 'milkdrop:geiss - reaction diffusion', name: 'Geiss - Reaction Diffusion', kind: 'milkdrop', source: 'geiss - reaction diffusion', builtin: true, enabled: true, author: 'Geiss' },
  { id: 'milkdrop:phat - swarm', name: 'Phat - Swarm', kind: 'milkdrop', source: 'phat - swarm', builtin: true, enabled: true, author: 'Phat' },
  { id: 'milkdrop:rovastar - liquid crystal', name: 'Rovastar - Liquid Crystal', kind: 'milkdrop', source: 'rovastar - liquid crystal', builtin: true, enabled: true, author: 'Rovastar' },
  { id: 'milkdrop:zylot - plasma', name: 'Zylot - Plasma', kind: 'milkdrop', source: 'zylot - plasma', builtin: true, enabled: true, author: 'Zylot' },
  { id: 'milkdrop:stahl - mercury', name: 'Stahl - Mercury', kind: 'milkdrop', source: 'stahl - mercury', builtin: true, enabled: true, author: 'Stahl' },
  { id: 'milkdrop:krash - warp drive', name: 'Krash - Warp Drive', kind: 'milkdrop', source: 'krash - warp drive', builtin: true, enabled: true, author: 'Krash' },
  { id: 'milkdrop:yin - starfield', name: 'Yin - Starfield', kind: 'milkdrop', source: 'yin - starfield', builtin: true, enabled: true, author: 'Yin' },
  { id: 'milkdrop:orb - smoke', name: 'Orb - Smoke', kind: 'milkdrop', source: 'orb - smoke', builtin: true, enabled: true, author: 'Orb' },
];

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
    return [...BUILTINS, ...SAMPLE_MILKDROP, ...user];
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
