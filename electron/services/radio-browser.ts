// Radio-Browser client. The public community-maintained directory at
//   https://www.radio-browser.info/
// exposes a JSON HTTP API listing ~40,000 online radio streams worldwide.
// No API key required. Aggregated from community contributions; stations
// carry metadata + a direct stream URL.
//
// The service publishes a set of round-robin mirror hostnames under
//   https://all.api.radio-browser.info/
// We resolve one on first use via a SRV-style lookup and cache it per
// process, with a hard fallback on the known primary host.

const USER_AGENT = 'MusicPlayer/0.1 (personal; +https://github.com/SixOfFive/musicplayer)';
const FALLBACK_HOST = 'de1.api.radio-browser.info';

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
  const url = `${b}${pathAndQuery}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Radio-Browser HTTP ${r.status}`);
  const json: any = await r.json();
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
  const r = await fetch(`${b}/json/tags?order=stationcount&reverse=true&limit=${limit}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Radio-Browser HTTP ${r.status}`);
  const json: any = await r.json();
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
