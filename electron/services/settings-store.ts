import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AppSettings } from '../../shared/types';

let settingsPath = '';
let cache: AppSettings | null = null;

function defaults(): AppSettings {
  const userData = app.getPath('userData');
  return {
    firstRunComplete: false,
    conversion: {
      enabled: true,
      quality: 'V0',
      minSavingsPercent: 5,
      moveOriginalsToTrash: true,
    },
    playlistExport: {
      enabled: true,
      folder: '',                 // empty → auto-resolve at write time
      pathStyle: 'absolute',
      exportLiked: true,
    },
    update: {
      enabled: true,
      checkOnStartup: true,
      repoSlug: 'SixOfFive/musicplayer',
      branch: 'main',
    },
    debug: {
      openDevToolsOnStartup: false,
      logRendererToMain: false,
    },
    lastfm: {
      apiKey: '',
      apiSecret: '',
      sessionKey: '',
      username: '',
      scrobbleEnabled: true,
      minScrobbleSec: 30,
    },
    library: {
      directories: [],
      databasePath: path.join(userData, 'library.db'),
      coverArtCachePath: path.join(userData, 'coverart'),
      coverArtStorage: 'cache',
      coverArtFilename: 'cover',
      allowFileDeletion: false,
    },
    scan: {
      providers: ['musicbrainz', 'coverartarchive'],
      apiKeys: {},
      incremental: true,
      fetchCoverArt: true,
      writeBackTags: false,
      extensions: ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma'],
    },
    visualizer: {
      activePluginId: 'builtin:bars',
      fps: 60,
      sensitivity: 0.7,
      smoothing: 0.6,
      fullscreenOnPlay: false,
      pluginSearchPaths: [path.join(userData, 'plugins', 'visualizers')],
    },
    playback: {
      crossfadeMs: 0,
      replayGain: 'off',
      outputDevice: null,
      volume: 0.8,
      eqEnabled: false,
      eqGainsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      eqPreamp: 0,
    },
  };
}

function merge<T>(base: T, patch: Partial<T>): T {
  if (!patch || typeof patch !== 'object') return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const k of Object.keys(patch)) {
    const pv: any = (patch as any)[k];
    const bv: any = (base as any)[k];
    out[k] =
      pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object'
        ? merge(bv, pv)
        : pv;
  }
  return out;
}

export async function initSettings(): Promise<void> {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    cache = merge(defaults(), JSON.parse(raw));
  } catch {
    cache = defaults();
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(cache, null, 2));
  }
  // Ensure derived dirs exist.
  await fs.mkdir(cache.library.coverArtCachePath, { recursive: true });
  for (const p of cache.visualizer.pluginSearchPaths) {
    await fs.mkdir(p, { recursive: true });
  }
}

export function getSettings(): AppSettings {
  if (!cache) throw new Error('Settings not initialized');
  return cache;
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  cache = merge(getSettings(), patch);
  await fs.writeFile(settingsPath, JSON.stringify(cache, null, 2));
  return cache;
}
