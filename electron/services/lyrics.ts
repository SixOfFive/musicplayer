import path from 'node:path';
import fs from 'node:fs/promises';
import { net } from 'electron';
import { getDb } from './db';
import { getSettings } from './settings-store';

/**
 * Lyrics service — provider + cache for time-synced song lyrics.
 *
 * Strategy:
 *   1. Local .lrc next to the audio file (<basename>.lrc) — zero network,
 *      respects whatever the user has manually placed there. Other apps
 *      (foobar2000, MusicBee, Plex) read this file too, so it's the
 *      lowest-friction sharing format.
 *   2. LRCLib (lrclib.net) — free, no API key, no rate limit. Queried by
 *      artist + title + album + duration; returns plain + synced bodies
 *      independently.
 *   3. SQLite cache (track_lyrics table) so subsequent plays of the same
 *      track skip both checks.
 *
 * Cache is keyed by track_id, so retag/rename of the file invalidates
 * implicitly via the FK CASCADE on tracks delete + a manual `clear` IPC
 * for the user to force a re-fetch.
 *
 * No on-disk write of fetched .lrc files by default. Settings expose a
 * `writeLrcAlongsideAudio` toggle that flips that behaviour for users who
 * want the lyrics to travel with the collection.
 */

export type LyricsSource = 'local-lrc' | 'lrclib' | 'manual' | 'none';

export interface LyricLine {
  /** Seconds from track start. */
  time: number;
  text: string;
}

export interface LyricsResult {
  source: LyricsSource;
  /** Parsed timed lines. Empty when only plain text is available, or
   *  when source === 'none'. */
  lines: LyricLine[];
  /** Plain (untimestamped) fallback. Always populated when synced is —
   *  derived from synced by stripping timestamps. Empty when source ===
   *  'none'. */
  plainText: string;
  /** Raw LRC body (kept so the renderer can show "save .lrc to disk"
   *  or copy-to-clipboard). Empty when source === 'none' or source ===
   *  'manual' with no synced lines. */
  syncedText: string;
  /** Whether this came out of the SQLite cache (true) or a fresh
   *  network/disk load (false). Cosmetic — the renderer uses it for
   *  the "cached" / "fetched" badge. */
  fromCache: boolean;
  /** Track id this lyric is bound to. Echoed back so the renderer can
   *  ignore stragglers when the user navigates between tracks rapidly. */
  trackId: number;
}

// ---------------------------------------------------------------------------
// LRC parser
// ---------------------------------------------------------------------------
//
// LRC format (informal but ubiquitous):
//   [ti:Title]
//   [ar:Artist]
//   [length:03:42]
//   [00:12.34]Line one
//   [00:18.10][01:42.55]Repeated chorus line
//   [00:24.000]Line three (3-decimal precision)
//
// We accept 2- or 3-decimal fractions, allow multiple timestamps per
// line (= same lyric repeated at multiple times — produce one LyricLine
// per timestamp), and skip metadata tags ([ti:], [ar:], etc.). Empty
// lyric text is preserved as a beat marker — many LRC files use blank
// timed lines to mark instrumental breaks.

const TS_RE = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_RE = /^\[(ti|ar|al|au|by|length|offset|re|tool|ve|id|tags?):/i;

export function parseLrc(raw: string): { lines: LyricLine[]; plainText: string } {
  const out: LyricLine[] = [];
  const plainParts: string[] = [];
  // Normalise CRLF → LF, strip BOM, then split.
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (const lineRaw of text.split('\n')) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (META_RE.test(line)) continue;

    // Collect every timestamp at the start of the line.
    const stamps: number[] = [];
    let lastIdx = 0;
    TS_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TS_RE.exec(line)) != null) {
      // Only honour timestamps that are at the beginning, not embedded
      // mid-line (those are rare but we'd misinterpret them).
      if (m.index !== lastIdx) break;
      const mm = parseInt(m[1], 10);
      const ss = parseInt(m[2], 10);
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) / 1000 : 0;
      stamps.push(mm * 60 + ss + frac);
      lastIdx = TS_RE.lastIndex;
    }
    if (stamps.length === 0) continue;
    const text2 = line.slice(lastIdx).trim();
    for (const t of stamps) {
      out.push({ time: t, text: text2 });
    }
    plainParts.push(text2);
  }
  out.sort((a, b) => a.time - b.time);
  return { lines: out, plainText: plainParts.join('\n') };
}

// ---------------------------------------------------------------------------
// LRCLib fetcher
// ---------------------------------------------------------------------------
//
// API contract (https://lrclib.net/docs):
//   GET /api/get?artist_name=...&track_name=...&album_name=...&duration=NNN
//   200 OK: {
//     id, trackName, artistName, albumName, duration,
//     instrumental: bool, plainLyrics: string|null, syncedLyrics: string|null
//   }
//   404 Not Found: { ... } (no match for given params)
//
// We use the `duration` field as a fuzzy match — within ±2 seconds is
// considered the same recording. Skip the param entirely if we don't
// know our own duration.
//
// Why electron's `net` module instead of `fetch`? Better proxy support
// + no CORS quirks (we're in main, not renderer, but `net.fetch` honours
// the OS proxy + Electron's own networking customisations).

const LRCLIB_BASE = 'https://lrclib.net/api/get';
const FETCH_TIMEOUT_MS = 8000;

async function fetchUrl(url: string): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: { status: number; body: string } | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      const req = net.request({ method: 'GET', url });
      req.setHeader('User-Agent', 'MusicPlayer/0.2 (https://github.com/SixOfFive/musicplayer)');
      req.setHeader('Accept', 'application/json');
      const timer = setTimeout(() => {
        try { req.abort(); } catch { /* noop */ }
        finish(null);
      }, FETCH_TIMEOUT_MS);
      req.on('response', (resp) => {
        const chunks: Buffer[] = [];
        resp.on('data', (c: Buffer) => chunks.push(c));
        resp.on('end', () => {
          clearTimeout(timer);
          finish({ status: resp.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        resp.on('error', () => { clearTimeout(timer); finish(null); });
      });
      req.on('error', () => { clearTimeout(timer); finish(null); });
      req.end();
    } catch {
      finish(null);
    }
  });
}

export async function fetchFromLrclib(opts: {
  artist: string;
  title: string;
  album: string | null;
  durationSec: number | null;
}): Promise<{ syncedText: string; plainText: string } | null> {
  const params = new URLSearchParams();
  params.set('artist_name', opts.artist);
  params.set('track_name', opts.title);
  if (opts.album) params.set('album_name', opts.album);
  if (opts.durationSec && Number.isFinite(opts.durationSec)) {
    params.set('duration', String(Math.round(opts.durationSec)));
  }
  const url = `${LRCLIB_BASE}?${params.toString()}`;
  process.stdout.write(`[lyrics] LRCLib GET ${url}\n`);
  const r = await fetchUrl(url);
  if (!r) {
    process.stdout.write('[lyrics] LRCLib request failed (network/timeout)\n');
    return null;
  }
  if (r.status === 404) {
    process.stdout.write('[lyrics] LRCLib 404 — no match\n');
    return null;
  }
  if (r.status < 200 || r.status >= 300) {
    process.stdout.write(`[lyrics] LRCLib ${r.status} — ${r.body.slice(0, 120)}\n`);
    return null;
  }
  let parsed: any;
  try { parsed = JSON.parse(r.body); }
  catch {
    process.stdout.write('[lyrics] LRCLib response was not JSON\n');
    return null;
  }
  if (parsed?.instrumental) {
    process.stdout.write('[lyrics] LRCLib reports instrumental — caching as none\n');
    return { syncedText: '', plainText: '' };
  }
  const syncedText = typeof parsed?.syncedLyrics === 'string' ? parsed.syncedLyrics : '';
  const plainText  = typeof parsed?.plainLyrics === 'string'  ? parsed.plainLyrics  : '';
  if (!syncedText && !plainText) {
    process.stdout.write('[lyrics] LRCLib returned empty bodies\n');
    return null;
  }
  return { syncedText, plainText };
}

// ---------------------------------------------------------------------------
// Local .lrc file lookup
// ---------------------------------------------------------------------------

export async function getLocalLrcText(audioPath: string): Promise<string | null> {
  // Try <basename>.lrc next to the audio file. Common convention,
  // case-insensitive on Windows but we do a strict match first then
  // fall back to a directory scan to catch case-drifted matches.
  const dir = path.dirname(audioPath);
  const base = path.basename(audioPath, path.extname(audioPath));
  const candidate = path.join(dir, `${base}.lrc`);
  try {
    const buf = await fs.readFile(candidate, 'utf8');
    return buf;
  } catch { /* fall through */ }
  // Case-drift fallback (e.g. SMB share with mismatched case).
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const targetLower = `${base.toLowerCase()}.lrc`;
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase() === targetLower) {
        return await fs.readFile(path.join(dir, e.name), 'utf8');
      }
    }
  } catch { /* dir not accessible — fine, just no local lyrics */ }
  return null;
}

/**
 * Write LRC body as <basename>.lrc next to the audio file. Gated by
 * the `lyrics.writeLrcAlongsideAudio` setting and a strict
 * "do-not-overwrite-existing-files" guard — if a .lrc is already
 * there, we treat it as the user's canonical copy and bail.
 *
 * Failure modes we silently ignore:
 *   - EACCES / EPERM    : read-only SMB / NTFS permissions
 *   - EROFS             : read-only filesystem
 *   - ENOENT (parent)   : audio file's directory vanished mid-flight
 *
 * All other errors get logged but don't propagate — caching to disk
 * is purely a quality-of-life feature, never something that should
 * fail a successful network fetch.
 *
 * Returns true on a real write, false if skipped (setting off, file
 * already exists, write failed).
 */
async function writeLrcSideBySide(audioPath: string, lrcBody: string): Promise<boolean> {
  if (!lrcBody || !lrcBody.trim()) return false;
  let allowWrite = true;
  try { allowWrite = getSettings().lyrics?.writeLrcAlongsideAudio !== false; }
  catch { /* settings not initialised — default to skipping */ allowWrite = false; }
  if (!allowWrite) return false;

  const dir = path.dirname(audioPath);
  const base = path.basename(audioPath, path.extname(audioPath));
  const target = path.join(dir, `${base}.lrc`);

  // Don't clobber existing .lrc — it might be the user's hand-curated
  // version. Even a case-drift match counts.
  try {
    const existing = await getLocalLrcText(audioPath);
    if (existing && existing.trim()) {
      process.stdout.write(`[lyrics] skip side-by-side write: existing .lrc found near ${path.basename(audioPath)}\n`);
      return false;
    }
  } catch { /* if we can't even read the dir, the write below will also fail and we'll log it */ }

  try {
    await fs.writeFile(target, lrcBody, 'utf8');
    process.stdout.write(`[lyrics] wrote side-by-side ${path.basename(target)}\n`);
    return true;
  } catch (err: any) {
    const code = err?.code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'ENOENT') {
      process.stdout.write(`[lyrics] side-by-side write skipped (${code}) for ${path.basename(target)}\n`);
    } else {
      process.stdout.write(`[lyrics] side-by-side write failed: ${err?.message ?? err}\n`);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cache + orchestrator
// ---------------------------------------------------------------------------

interface CacheRow {
  track_id: number;
  source: LyricsSource;
  synced_text: string | null;
  plain_text: string | null;
  fetched_at: number;
}

function readCache(trackId: number): CacheRow | null {
  const db = getDb();
  const r = db.prepare(`
    SELECT track_id, source, synced_text, plain_text, fetched_at
    FROM track_lyrics WHERE track_id = ?
  `).get(trackId) as CacheRow | undefined;
  return r ?? null;
}

function writeCache(trackId: number, source: LyricsSource, syncedText: string, plainText: string): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO track_lyrics (track_id, source, synced_text, plain_text, fetched_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(trackId, source, syncedText || null, plainText || null, Date.now());
}

function clearCacheRow(trackId: number): void {
  const db = getDb();
  db.prepare('DELETE FROM track_lyrics WHERE track_id = ?').run(trackId);
}

function rowToResult(row: CacheRow, fromCache: boolean): LyricsResult {
  const synced = row.synced_text ?? '';
  const plain  = row.plain_text  ?? '';
  if (row.source === 'none') {
    return {
      source: 'none', lines: [], plainText: '', syncedText: '',
      fromCache, trackId: row.track_id,
    };
  }
  if (synced) {
    const { lines, plainText } = parseLrc(synced);
    return {
      source: row.source,
      lines,
      plainText: plain || plainText,
      syncedText: synced,
      fromCache,
      trackId: row.track_id,
    };
  }
  return {
    source: row.source,
    lines: [],
    plainText: plain,
    syncedText: '',
    fromCache,
    trackId: row.track_id,
  };
}

interface TrackInfo {
  id: number;
  path: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
}

function readTrackInfo(trackId: number): TrackInfo | null {
  const db = getDb();
  const r = db.prepare(`
    SELECT t.id, t.path, t.title, t.duration_sec AS durationSec,
           a.name AS artist, al.title AS album
    FROM tracks t
    LEFT JOIN artists a ON a.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
    WHERE t.id = ?
  `).get(trackId) as any;
  if (!r) return null;
  return {
    id: r.id,
    path: r.path,
    title: r.title,
    artist: r.artist ?? null,
    album: r.album ?? null,
    durationSec: typeof r.durationSec === 'number' ? r.durationSec : null,
  };
}

/**
 * Resolve lyrics for a track. The standard read path:
 *   - cache hit → return immediately (fromCache=true)
 *   - cache miss + force=false → look on disk, then LRCLib, cache the
 *     result (or 'none' if both miss), return.
 *   - force=true → bypass the cache, re-run the disk + network probe,
 *     overwrite the cache row.
 *
 * The 'none' sentinel is important: without it we'd hit LRCLib every
 * single time the user re-opens the panel for a track that has no
 * lyrics, which is wasteful and rude to LRCLib's free service.
 */
export async function getLyricsForTrack(trackId: number, force = false): Promise<LyricsResult> {
  if (!force) {
    const cached = readCache(trackId);
    if (cached) return rowToResult(cached, true);
  }

  const info = readTrackInfo(trackId);
  if (!info) {
    return {
      source: 'none', lines: [], plainText: '', syncedText: '',
      fromCache: false, trackId,
    };
  }

  // Step 1: local .lrc next to the audio file.
  try {
    const localRaw = await getLocalLrcText(info.path);
    if (localRaw && localRaw.trim()) {
      const { plainText } = parseLrc(localRaw);
      writeCache(trackId, 'local-lrc', localRaw, plainText);
      return rowToResult({
        track_id: trackId, source: 'local-lrc',
        synced_text: localRaw, plain_text: plainText, fetched_at: Date.now(),
      }, false);
    }
  } catch (err: any) {
    process.stdout.write(`[lyrics] local .lrc check failed: ${err?.message ?? err}\n`);
  }

  // Step 2: LRCLib.
  if (!info.artist) {
    // No artist tag → can't query LRCLib. Cache as 'none' so we don't
    // re-attempt every play, but with empty bodies so the user sees
    // the not-found state.
    writeCache(trackId, 'none', '', '');
    return {
      source: 'none', lines: [], plainText: '', syncedText: '',
      fromCache: false, trackId,
    };
  }
  try {
    const r = await fetchFromLrclib({
      artist: info.artist,
      title: info.title,
      album: info.album,
      durationSec: info.durationSec,
    });
    if (r) {
      // Empty (instrumental) → cache as 'none' so we don't re-poll.
      if (!r.syncedText && !r.plainText) {
        writeCache(trackId, 'none', '', '');
        return {
          source: 'none', lines: [], plainText: '', syncedText: '',
          fromCache: false, trackId,
        };
      }
      writeCache(trackId, 'lrclib', r.syncedText, r.plainText);
      // Side-by-side disk write so the lyrics travel with the music
      // collection. Synced body preferred (more useful to other apps);
      // fall back to plain when synced isn't available. Write is
      // best-effort — failure here doesn't affect the cache or the
      // returned result.
      void writeLrcSideBySide(info.path, r.syncedText || r.plainText);
      return rowToResult({
        track_id: trackId, source: 'lrclib',
        synced_text: r.syncedText || null,
        plain_text: r.plainText || null,
        fetched_at: Date.now(),
      }, false);
    }
  } catch (err: any) {
    process.stdout.write(`[lyrics] LRCLib query failed: ${err?.message ?? err}\n`);
  }

  // Step 3: nothing found. Cache 'none' so we don't keep polling.
  writeCache(trackId, 'none', '', '');
  return {
    source: 'none', lines: [], plainText: '', syncedText: '',
    fromCache: false, trackId,
  };
}

/**
 * Cheap availability check. Used by the NowPlayingBar to tint the
 * lyrics icon green when the current track already has lyrics, grey
 * when it doesn't. NEVER fires a network request — only consults:
 *
 *   1. SQLite cache row (any source other than 'none' is a hit)
 *   2. Disk: <basename>.lrc next to the audio file
 *
 * Hitting LRCLib here would round-trip on every track change, which
 * is rude to the free service AND expensive. The full lookup happens
 * only when the user actively opens the panel.
 *
 * Returns:
 *   'cached'   — cache row exists with real lyrics (will display
 *                instantly when panel opens)
 *   'disk'     — .lrc file present alongside audio (will be picked
 *                up + cached on first panel open)
 *   'none'     — nothing on disk, no positive cache. The cache
 *                might hold a 'none' sentinel from a previous
 *                LRCLib miss; we treat that as "user could still
 *                paste manually" and report none.
 */
export async function peekLyricsAvailable(trackId: number): Promise<'cached' | 'disk' | 'none'> {
  const cached = readCache(trackId);
  if (cached && cached.source !== 'none') {
    if ((cached.synced_text && cached.synced_text.trim()) ||
        (cached.plain_text  && cached.plain_text.trim())) {
      return 'cached';
    }
  }
  const info = readTrackInfo(trackId);
  if (!info) return 'none';
  try {
    const local = await getLocalLrcText(info.path);
    if (local && local.trim()) return 'disk';
  } catch { /* dir unreachable — treat as none */ }
  return 'none';
}

/** User clicked "Set lyrics manually" — store whatever they pasted as
 *  source='manual'. Accepts either an LRC body (with timestamps) or a
 *  plain block of text; we run it through parseLrc and use any timed
 *  lines we get out, falling back to the raw input as plainText.
 *
 *  Also fires the side-by-side disk write so the user's manual paste
 *  becomes the canonical .lrc on disk. Runs in the background — the
 *  result is returned synchronously from the cache write. */
export async function setManualLyrics(trackId: number, raw: string): Promise<LyricsResult> {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    writeCache(trackId, 'none', '', '');
    return {
      source: 'none', lines: [], plainText: '', syncedText: '',
      fromCache: false, trackId,
    };
  }
  const { plainText } = parseLrc(trimmed);
  // If we got at least one timed line, treat the input as synced. Else
  // store as plain only.
  const looksSynced = TS_RE.test(trimmed);
  TS_RE.lastIndex = 0;
  // Resolve the on-disk audio path (if any) so we can mirror the
  // paste to a side-by-side .lrc. Look-up is best-effort; if the
  // track row vanished or path is unreadable we just skip the write.
  const info = readTrackInfo(trackId);
  if (looksSynced) {
    writeCache(trackId, 'manual', trimmed, plainText);
    if (info) void writeLrcSideBySide(info.path, trimmed);
    return rowToResult({
      track_id: trackId, source: 'manual',
      synced_text: trimmed, plain_text: plainText, fetched_at: Date.now(),
    }, false);
  }
  writeCache(trackId, 'manual', '', trimmed);
  if (info) void writeLrcSideBySide(info.path, trimmed);
  return rowToResult({
    track_id: trackId, source: 'manual',
    synced_text: null, plain_text: trimmed, fetched_at: Date.now(),
  }, false);
}

/** User clicked "Clear lyrics" — drop the cache row entirely so the
 *  next open re-runs the disk + network probe. */
export function clearLyricsForTrack(trackId: number): void {
  clearCacheRow(trackId);
}
