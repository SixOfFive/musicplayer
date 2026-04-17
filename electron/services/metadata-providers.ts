// Metadata provider implementations.
//
// Currently wired:
//   - MusicBrainz        (free, no key, 1 req/sec rate limit)
//   - Cover Art Archive  (free, no key, redirects to actual image)
//   - Deezer             (free, no key, fast album art fallback)
//
// Stubbed (need API keys or external binaries — settings UI surfaces the
// key fields, but actual calls aren't implemented yet):
//   - Last.fm (key)
//   - Discogs (token)
//   - AcoustID/Chromaprint (key + fpcalc binary)
//   - AccurateRip / CUETools DB (lossless-only rip verification)

import { saveAlbumArt } from './cover-art';
import type { MetadataProviderId } from '../../shared/types';

const USER_AGENT = 'MusicPlayer/0.1 (personal; +https://github.com/sixoffive/musicplayer)';

// --- Rate limiter ------------------------------------------------------------

/**
 * MusicBrainz requires <=1 request per second per IP, with a meaningful UA.
 * This is a minimal serial queue that enforces the gap between outgoing requests.
 */
class SerialRateLimiter {
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private minGapMs: number) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const wait = Math.max(0, this.minGapMs - (Date.now() - this.last));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        this.last = Date.now();
      }
    });
    this.chain = next.catch(() => {});
    return next as Promise<T>;
  }
}

// Per-provider rate limits. Values reflect each service's published policy,
// with a 10%-ish safety margin. All active providers go through these queues
// so the scan never bursts. Tune in one place.
const limiters: Record<MetadataProviderId, SerialRateLimiter> = {
  none:           new SerialRateLimiter(0),
  musicbrainz:    new SerialRateLimiter(1100),  // hard 1 req/sec
  coverartarchive:new SerialRateLimiter(250),   // no stated limit; be polite
  deezer:         new SerialRateLimiter(250),   // ~50 / 5 sec
  lastfm:         new SerialRateLimiter(220),   // ~5 / sec
  discogs:        new SerialRateLimiter(1100),  // 60/min authenticated
  acoustid:       new SerialRateLimiter(350),   // 3/sec
  accuraterip:    new SerialRateLimiter(500),   // no stated limit; be polite
  cuetoolsdb:     new SerialRateLimiter(500),   // no stated limit; be polite
};
// Aliases used throughout this file for readability.
const mbLimiter = limiters.musicbrainz;
const deezerLimiter = limiters.deezer;

// --- Types -------------------------------------------------------------------

export interface ReleaseMatch {
  mbid: string;                  // MusicBrainz release MBID
  releaseGroupMbid: string | null;
  title: string;
  artist: string;
  year: number | null;
  trackCount: number | null;
  score: number;                 // 0..100 from MB
}

export interface ArtFetchResult {
  provider: MetadataProviderId;
  bytes: Uint8Array;
  mimeType: string;
  sourceUrl: string;
}

// --- MusicBrainz -------------------------------------------------------------

export async function mbSearchRelease(artist: string, album: string): Promise<ReleaseMatch | null> {
  if (!artist || !album) return null;
  return mbLimiter.run(async () => {
    // Lucene-style query: escape quotes in inputs.
    const esc = (s: string) => s.replace(/["\\]/g, '\\$&');
    const q = `release:"${esc(album)}" AND artist:"${esc(artist)}"`;
    const url = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(q)}&fmt=json&limit=5`;
    const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (!r.ok) return null;
    const json: any = await r.json();
    const first = json?.releases?.[0];
    if (!first) return null;
    return {
      mbid: first.id,
      releaseGroupMbid: first['release-group']?.id ?? null,
      title: first.title,
      artist: first['artist-credit']?.[0]?.name ?? artist,
      year: first.date ? parseInt(String(first.date).slice(0, 4), 10) || null : null,
      trackCount: first['track-count'] ?? null,
      score: first.score ?? 0,
    };
  });
}

// --- Cover Art Archive -------------------------------------------------------

export async function caaFetchFront(releaseMbid: string, releaseGroupMbid?: string | null): Promise<ArtFetchResult | null> {
  // Prefer release-group front (tends to be canonical), fall back to release-specific.
  const urls = [
    releaseGroupMbid ? `https://coverartarchive.org/release-group/${releaseGroupMbid}/front` : null,
    `https://coverartarchive.org/release/${releaseMbid}/front`,
  ].filter(Boolean) as string[];

  for (const u of urls) {
    try {
      const r = await fetch(u, { redirect: 'follow' });
      if (!r.ok) continue;
      const buf = new Uint8Array(await r.arrayBuffer());
      const mime = r.headers.get('content-type') ?? 'image/jpeg';
      if (buf.byteLength < 500) continue; // likely 1x1 placeholder
      return { provider: 'coverartarchive', bytes: buf, mimeType: mime, sourceUrl: u };
    } catch {
      /* try next */
    }
  }
  return null;
}

// --- Deezer ------------------------------------------------------------------

export async function deezerFetchAlbumArt(artist: string, album: string): Promise<ArtFetchResult | null> {
  if (!artist || !album) return null;
  return deezerLimiter.run(async () => {
    try {
      const q = `artist:"${artist}" album:"${album}"`;
      const searchUrl = `https://api.deezer.com/search/album?q=${encodeURIComponent(q)}&limit=1`;
      const r = await fetch(searchUrl, { headers: { Accept: 'application/json' } });
      if (!r.ok) return null;
      const json: any = await r.json();
      const first = json?.data?.[0];
      const imgUrl: string | undefined = first?.cover_xl ?? first?.cover_big ?? first?.cover_medium;
      if (!imgUrl) return null;
      const img = await fetch(imgUrl);
      if (!img.ok) return null;
      const bytes = new Uint8Array(await img.arrayBuffer());
      return { provider: 'deezer', bytes, mimeType: img.headers.get('content-type') ?? 'image/jpeg', sourceUrl: imgUrl };
    } catch {
      return null;
    }
  });
}

// --- Orchestrator ------------------------------------------------------------

/**
 * Try each enabled provider in the order the user specified in Settings.
 * Returns the first image we can fetch, or null.
 */
export async function fetchAlbumArt(
  artist: string | null,
  album: string | null,
  enabledProviders: MetadataProviderId[],
): Promise<ArtFetchResult | null> {
  if (!artist || !album) return null;
  for (const p of enabledProviders) {
    try {
      if (p === 'musicbrainz' || p === 'coverartarchive') {
        // These pair up: MB gives us the MBID, CAA fetches by MBID.
        if (!enabledProviders.includes('coverartarchive')) continue; // no point
        const match = await mbSearchRelease(artist, album);
        if (!match) continue;
        const art = await caaFetchFront(match.mbid, match.releaseGroupMbid);
        if (art) return art;
      } else if (p === 'deezer') {
        const art = await deezerFetchAlbumArt(artist, album);
        if (art) return art;
      }
      // Last.fm / Discogs / AcoustID are stubbed — skip silently.
    } catch {
      /* try next provider */
    }
  }
  return null;
}

/**
 * Best-effort release-level metadata lookup (MusicBrainz). Fills in year.
 * Returns null if no enabled provider supports this.
 */
export async function enrichReleaseMetadata(
  artist: string | null,
  album: string | null,
  enabledProviders: MetadataProviderId[],
): Promise<{ year: number | null; mbid: string | null } | null> {
  if (!artist || !album) return null;
  if (!enabledProviders.includes('musicbrainz')) return null;
  const match = await mbSearchRelease(artist, album);
  if (!match) return null;
  return { year: match.year, mbid: match.mbid };
}

/**
 * Save fetched art to disk (cache dir or alongside the audio, per user setting)
 * and update the album row. Thin wrapper — logic lives in services/cover-art.ts.
 */
export async function persistAlbumArt(albumId: number, art: ArtFetchResult): Promise<string | null> {
  return saveAlbumArt(albumId, art.bytes, art.mimeType);
}

// --- Test endpoints (used by Settings "Test connection" button) --------------

export async function testProvider(id: MetadataProviderId): Promise<{ ok: boolean; status: number; message?: string }> {
  try {
    if (id === 'musicbrainz') {
      const m = await mbSearchRelease('Radiohead', 'OK Computer');
      return m ? { ok: true, status: 200, message: `Matched "${m.title}" (score ${m.score})` }
               : { ok: false, status: 0, message: 'No match returned' };
    }
    if (id === 'coverartarchive') {
      // Known good MBID (Radiohead - OK Computer release group).
      const art = await caaFetchFront('b1392450-e666-3926-a536-22c65f834433', 'b1392450-e666-3926-a536-22c65f834433');
      return art ? { ok: true, status: 200, message: `Fetched ${art.bytes.byteLength} bytes` }
                 : { ok: false, status: 0, message: 'No art returned' };
    }
    if (id === 'deezer') {
      const art = await deezerFetchAlbumArt('Radiohead', 'OK Computer');
      return art ? { ok: true, status: 200, message: `Fetched ${art.bytes.byteLength} bytes` }
                 : { ok: false, status: 0, message: 'No art returned' };
    }
    return { ok: false, status: 0, message: 'Test not implemented for this provider yet. Provider stub only.' };
  } catch (err: any) {
    return { ok: false, status: 0, message: err?.message ?? 'Network error' };
  }
}
