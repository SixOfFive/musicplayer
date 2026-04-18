// Radio-Browser client. The public community-maintained directory at
//   https://www.radio-browser.info/
// exposes a JSON HTTP API listing ~40,000 online radio streams worldwide.
// No API key required. Aggregated from community contributions; stations
// carry metadata + a direct stream URL.
//
// Results are cached on disk with a 24-hour TTL so repeated browsing of
// the Radio tab doesn't hammer the community servers. Cache file lives
// in the Electron userData dir and survives restarts.

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';

const USER_AGENT = 'MusicPlayer/0.1 (personal; +https://github.com/SixOfFive/musicplayer)';
const FALLBACK_HOST = 'de1.api.radio-browser.info';

// ---- Persistent 24h TTL cache ---------------------------------------------
// Cache key is the fully-qualified URL (mirror host + path + query). Mirror
// may differ across sessions but the query identifies the result set, so we
// normalise by stripping the host and keying on path+query only.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
interface CacheEntry { fetchedAt: number; data: any }
let cacheMap: Map<string, CacheEntry> | null = null;
let cachePath = '';
let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function loadCache(): Promise<Map<string, CacheEntry>> {
  if (cacheMap) return cacheMap;
  try { cachePath = path.join(app.getPath('userData'), 'radio-cache.json'); }
  catch { cachePath = ''; }
  cacheMap = new Map();
  if (!cachePath) return cacheMap;
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    const obj = JSON.parse(raw) as Record<string, CacheEntry>;
    for (const [k, v] of Object.entries(obj)) {
      // Drop already-expired entries at load time so the file doesn't bloat.
      if (v && typeof v.fetchedAt === 'number' && Date.now() - v.fetchedAt < CACHE_TTL_MS) {
        cacheMap.set(k, v);
      }
    }
  } catch { /* file missing or corrupt — start empty */ }
  return cacheMap;
}

/**
 * Debounced cache write — burst of queries when the user opens the Radio
 * tab would otherwise cause a writeFile per call.
 */
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!cacheMap || !cachePath) return;
    try {
      const obj: Record<string, CacheEntry> = {};
      for (const [k, v] of cacheMap) obj[k] = v;
      await fs.writeFile(cachePath, JSON.stringify(obj), 'utf8');
    } catch { /* best-effort */ }
  }, 2000);
}

/** Evict oldest entries when over cap. */
function enforceCap() {
  if (!cacheMap || cacheMap.size <= CACHE_MAX_ENTRIES) return;
  const entries = [...cacheMap.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
  const drop = entries.slice(0, cacheMap.size - CACHE_MAX_ENTRIES);
  for (const [k] of drop) cacheMap.delete(k);
}

/**
 * Fetch JSON with the 24h cache. `cacheKey` is the path+query portion of the
 * URL so that picks of different mirrors across sessions still share cache
 * entries. `fetchUrl` is the full URL including mirror host.
 */
async function cachedFetch(cacheKey: string, fetchUrl: string): Promise<any> {
  const cache = await loadCache();
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.data;
  const r = await fetch(fetchUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Radio-Browser HTTP ${r.status}`);
  const json = await r.json();
  cache.set(cacheKey, { fetchedAt: Date.now(), data: json });
  enforceCap();
  scheduleSave();
  return json;
}

let resolvedBase: string | null = null;

async function base(): Promise<string> {
  if (resolvedBase) return resolvedBase;
  try {
    // Returns JSON array of mirror records; pick one randomly.
    const r = await fetch('https://all.api.radio-browser.info/json/servers', {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (r.ok) {
      const servers: any[] = await r.json();
      if (Array.isArray(servers) && servers.length > 0) {
        const pick = servers[Math.floor(Math.random() * servers.length)];
        const host = pick?.name ?? FALLBACK_HOST;
        resolvedBase = `https://${host}`;
        return resolvedBase;
      }
    }
  } catch {
    /* fall through */
  }
  resolvedBase = `https://${FALLBACK_HOST}`;
  return resolvedBase;
}

export interface RadioStation {
  stationuuid: string;
  name: string;
  url: string;           // original stream URL (may be a .pls/.m3u)
  url_resolved: string;  // dereferenced direct stream URL — use this
  homepage: string;
  favicon: string;
  tags: string;          // comma-separated genre tags
  country: string;
  countrycode: string;
  language: string;
  codec: string;         // MP3 / AAC / OGG / FLAC / etc.
  bitrate: number;       // kbps, 0 = unknown
  votes: number;
  clickcount: number;
  lastcheckok: 0 | 1;    // 1 = last health check succeeded
}

async function call(pathAndQuery: string): Promise<RadioStation[]> {
  const b = await base();
  const json = await cachedFetch(pathAndQuery, `${b}${pathAndQuery}`);
  return Array.isArray(json) ? json : [];
}

/** Top-voted stations (global default list). */
export async function topStations(limit = 50): Promise<RadioStation[]> {
  return call(`/json/stations/topvote?limit=${limit}&hidebroken=true`);
}

/** Recently-clicked popular stations (different signal than topvote). */
export async function trendingStations(limit = 50): Promise<RadioStation[]> {
  return call(`/json/stations/topclick?limit=${limit}&hidebroken=true`);
}

/**
 * Free-text search across name/tags. Limit 100 to keep responses snappy.
 */
export async function searchStations(query: string, limit = 100): Promise<RadioStation[]> {
  const q = encodeURIComponent(query);
  return call(`/json/stations/search?name=${q}&limit=${limit}&hidebroken=true&order=votes&reverse=true`);
}

/** Stations with a specific genre tag (e.g. "jazz", "synthwave", "classical"). */
export async function stationsByTag(tag: string, limit = 100): Promise<RadioStation[]> {
  const t = encodeURIComponent(tag);
  return call(`/json/stations/bytag/${t}?limit=${limit}&hidebroken=true&order=votes&reverse=true`);
}

/** Stations from a country, matched by ISO-3166 code (e.g. "US", "GB"). */
export async function stationsByCountry(code: string, limit = 100): Promise<RadioStation[]> {
  const c = encodeURIComponent(code);
  return call(`/json/stations/bycountrycodeexact/${c}?limit=${limit}&hidebroken=true&order=votes&reverse=true`);
}

export interface RadioTag { name: string; stationcount: number; }

/** Popular genre tags, ordered by station count. */
export async function popularTags(limit = 100): Promise<RadioTag[]> {
  const b = await base();
  const key = `/json/tags?order=stationcount&reverse=true&limit=${limit}`;
  const json = await cachedFetch(key, `${b}${key}`);
  return Array.isArray(json) ? json.map((t: any) => ({ name: t.name, stationcount: Number(t.stationcount) || 0 })) : [];
}

/**
 * Record a "click" against a station. Radio-Browser uses this to build
 * its trending list; also reports a 1-second listen stat. Cheap to call
 * and polite to the directory maintainers.
 */
export async function registerClick(stationuuid: string): Promise<void> {
  try {
    const b = await base();
    await fetch(`${b}/json/url/${encodeURIComponent(stationuuid)}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
  } catch { /* best-effort, never throws */ }
}
