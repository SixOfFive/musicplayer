import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getDb } from './db';
import { getSettings, updateSettings } from './settings-store';
import { LIKED_PLAYLIST_ID } from '../../shared/types';

const LIKED_FILENAME = 'Liked Songs';

/**
 * Resolve the directory where playlists should be written.
 *
 *   1. settings.playlistExport.folder if set — used AS-IS, no subfolder
 *      appending. Whatever absolute path the user picked is what gets
 *      written to. This used to silently append "/Playlists" under some
 *      paths which looked like the app was second-guessing the pick;
 *      it no longer does.
 *   2. <userData>/Playlists — auto-fallback only when folder is blank.
 *      Lives inside the app's own data directory (%APPDATA%\musicplayer\
 *      on Windows) so it's never inside the user's music tree and can't
 *      be mistaken for something we added on top of their pick.
 *
 * Falls back between candidates on any write failure. Always creates
 * the directory if it doesn't exist.
 */
async function resolveExportDir(): Promise<string> {
  const settings = getSettings();
  const explicit = settings.playlistExport?.folder?.trim();

  if (explicit) {
    // Explicit pick — use it LITERALLY. No subfolder append, no
    // silent fallback to userData when the share is briefly
    // unreachable. Previous behaviour probe-wrote a throwaway file
    // before every export + quietly redirected to userData/Playlists
    // on failure, which on a slow SMB share meant: (a) two extra
    // round-trips per export that the user could feel as UI lag, and
    // (b) writes ending up in two different locations without the
    // user noticing. Now: mkdir the folder (idempotent), return, and
    // let the actual fs.writeFile in exportPlaylist throw if the
    // share is down. That error bubbles up to the UI where the user
    // can act on it.
    try {
      await fs.mkdir(explicit, { recursive: true });
      return explicit;
    } catch (err: any) {
      throw new Error(`Playlist export folder "${explicit}" isn't writable: ${err?.message ?? err}`);
    }
  }

  // No explicit folder — use the app's private data dir. This is
  // the ONLY fallback path, and only applies when the user never
  // picked a folder. Never used as a "safety net" when an explicit
  // pick fails.
  const fallback = path.join(app.getPath('userData'), 'Playlists');
  await fs.mkdir(fallback, { recursive: true });
  return fallback;
}

/**
 * Returns whatever path the app is CURRENTLY writing playlist files
 * to, without touching the filesystem. Surfaced in the settings UI so
 * the user can see where their exports actually go — especially
 * useful if their explicit share is unreachable and writes are
 * erroring out. Returns null on config error (never throws).
 */
export function getEffectiveExportDir(): string | null {
  try {
    const explicit = getSettings().playlistExport?.folder?.trim();
    if (explicit) return explicit;
    return path.join(app.getPath('userData'), 'Playlists');
  } catch {
    return null;
  }
}

/**
 * Sanitize a playlist name so it becomes a legal filename on every OS.
 * Replaces Windows-forbidden chars, trims, caps length.
 */
function sanitizeFilename(name: string): string {
  // Windows: <>:"/\|?*  +  ASCII control chars.  Also strip trailing dots/spaces.
  let out = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  out = out.replace(/[.\s]+$/, '');
  if (!out) out = 'Playlist';
  if (out.length > 120) out = out.slice(0, 120);
  return out;
}

function formatPath(absolutePath: string, playlistDir: string): string {
  const settings = getSettings();
  const style = settings.playlistExport?.pathStyle ?? 'absolute';
  if (style === 'absolute') return absolutePath;
  // Relative path from the .m3u8's directory to the track.
  const rel = path.relative(playlistDir, absolutePath);
  // M3U convention: forward slashes. Most players cope with either on Windows,
  // but forward slashes are more portable across platforms.
  return rel.split(path.sep).join('/');
}

/**
 * Render an array of track paths (+ optional durations / titles) to M3U8.
 * The `#EXTM3U` + `#EXTINF:<sec>,<title>` extensions are the same ones used
 * by Winamp, VLC, foobar2000, MusicBee, Jellyfin, Plex, Navidrome, etc.
 */
function renderM3U(
  tracks: Array<{ path: string; durationSec: number | null; title: string; artist: string | null }>,
  playlistDir: string,
  description: string | null,
): string {
  const lines: string[] = ['#EXTM3U'];
  if (description) lines.push(`#PLAYLIST:${description}`);
  for (const t of tracks) {
    const dur = t.durationSec ? Math.round(t.durationSec) : -1;
    const label = t.artist ? `${t.artist} - ${t.title}` : t.title;
    lines.push(`#EXTINF:${dur},${label}`);
    lines.push(formatPath(t.path, playlistDir));
  }
  // M3U8 = UTF-8 encoded M3U; file extension alone is the signal to players.
  // Trailing newline makes it well-formed on all parsers.
  return lines.join('\n') + '\n';
}

function getPlaylistRows(playlistId: number): {
  name: string;
  description: string | null;
  tracks: Array<{ path: string; durationSec: number | null; title: string; artist: string | null }>;
} | null {
  const db = getDb();
  if (playlistId === LIKED_PLAYLIST_ID) {
    const rows = db.prepare(`
      SELECT t.path, t.duration_sec AS durationSec, t.title, ar.name AS artist
      FROM track_likes tl
      JOIN tracks t ON t.id = tl.track_id
      LEFT JOIN artists ar ON ar.id = t.artist_id
      ORDER BY tl.liked_at DESC
    `).all() as any[];
    return { name: LIKED_FILENAME, description: 'Every track you liked', tracks: rows };
  }
  const pl = db.prepare('SELECT name, description FROM playlists WHERE id = ?').get(playlistId) as
    { name: string; description: string | null } | undefined;
  if (!pl) return null;
  const rows = db.prepare(`
    SELECT t.path, t.duration_sec AS durationSec, t.title, ar.name AS artist
    FROM playlist_tracks pt
    JOIN tracks t ON t.id = pt.track_id
    LEFT JOIN artists ar ON ar.id = t.artist_id
    WHERE pt.playlist_id = ?
    ORDER BY pt.position ASC
  `).all(playlistId) as any[];
  return { name: pl.name, description: pl.description, tracks: rows };
}

/** Last error encountered while trying to export a playlist. Surfaced
 *  to the renderer via the schedule-status IPC so the settings panel
 *  can display an alert when a flaky network share is dropping writes.
 *  Cleared on the first successful export. */
let lastExportError: { message: string; at: number; path: string | null } | null = null;

/**
 * mtime of `Liked Songs.m3u8` the last time WE wrote or read it. Used
 * by `reconcileLikedIfDiskChanged` to detect cross-machine edits: if
 * the file's current mtime differs from this (bigger gap than fs
 * mtime resolution), another machine wrote to it since we last saw
 * it, so we pull in any new likes from disk before the next write
 * clobbers them. In-memory only — first like of each session always
 * triggers a reconcile check, which is cheap (one stat + maybe one
 * readFile).
 */
let likedKnownMtimeMs: number | null = null;

/** Read-only accessor used by the IPC layer. */
export function getLastExportError(): { message: string; at: number; path: string | null } | null {
  return lastExportError;
}
export function clearLastExportError(): void { lastExportError = null; }

/**
 * Write a single playlist's .m3u8 file. Whole file written in one
 * fs.writeFile call — no line-by-line streaming, no probe-write
 * before. On a slow network share that alone shaves round-trips.
 *
 * Errors are caught so an otherwise-successful DB op doesn't reject
 * to the renderer, but they're STORED in `lastExportError` so the
 * UI can alert. Previous behaviour silently swallowed the error
 * which hid "your share just disconnected" from the user.
 */
export async function exportPlaylist(playlistId: number, _oldNameIfRenamed?: string | null): Promise<void> {
  const settings = getSettings();
  if (!settings.playlistExport?.enabled) return;
  if (playlistId === LIKED_PLAYLIST_ID && !settings.playlistExport.exportLiked) return;

  const data = getPlaylistRows(playlistId);
  if (!data) return;

  let target: string | null = null;
  try {
    const dir = await resolveExportDir();
    const filename = sanitizeFilename(data.name) + '.m3u8';
    target = path.join(dir, filename);
    const contents = renderM3U(data.tracks, dir, data.description);
    // Single fs.writeFile. The whole .m3u8 (header + EXTINF + path
    // lines) is built in memory first and handed over in one call —
    // on SMB this is dramatically faster than any append-style
    // approach because the OS can short-circuit the transfer into
    // one SMB2 WRITE.
    await fs.writeFile(target, contents, 'utf8');
    // Success — clear any stale error so the UI banner goes away.
    if (lastExportError) lastExportError = null;
    // Remember our own write's mtime for the Liked file so the next
    // like-toggle reconcile doesn't re-read a file we just wrote.
    if (playlistId === LIKED_PLAYLIST_ID) {
      try {
        const st = await fs.stat(target);
        likedKnownMtimeMs = st.mtimeMs;
      } catch { /* non-fatal — next like will re-stat */ }
    }
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error('[playlist-export] write failed', message);
    lastExportError = { message, at: Date.now(), path: target };
  }
}

/**
 * Called when a playlist was renamed or deleted so the old file is removed.
 */
export async function removeExportedPlaylist(name: string): Promise<void> {
  try {
    const settings = getSettings();
    if (!settings.playlistExport?.enabled) return;
    const dir = await resolveExportDir();
    const target = path.join(dir, sanitizeFilename(name) + '.m3u8');
    await fs.unlink(target).catch(() => {});
  } catch (err: any) {
    console.error('[playlist-export] unlink failed', err?.message ?? err);
  }
}

/**
 * Parse a .m3u8 file into a list of absolute paths + optional metadata lines.
 * Handles both `#EXTINF:` extended form and plain-path form. Returns paths as
 * absolute — relative entries are resolved against the file's directory.
 */
interface ParsedM3U {
  paths: string[];
  /** Best-guess name: embeddedName if we found a #PLAYLIST: directive,
   *  otherwise the filename (minus .m3u8 extension). */
  playlistName: string;
  /** The raw #PLAYLIST: value if present, else null. Surfaced
   *  separately so the import UI can show "Filename: X, Embedded: Y"
   *  before the user confirms a name. */
  embeddedName: string | null;
  /** Non-fatal parsing issues we skipped past — e.g. a line that looks
   *  like a path but pointed nowhere we could resolve, UTF-8 decode
   *  failures on a single row, or an orphan `#EXTINF:` without a
   *  following path. Not fatal to the import; surfaced so the UI can
   *  offer to rewrite the playlist with only the good entries. */
  skipped: Array<{ lineNo: number; raw: string; reason: string }>;
}

/**
 * Parse a .m3u8 on a best-effort basis. Malformed lines are collected
 * into `skipped` and the parse continues; only a file-read failure or
 * a catastrophically-unreadable file (e.g. binary with no text lines)
 * throws.
 */
async function parseM3U(filePath: string): Promise<ParsedM3U> {
  const raw = await fs.readFile(filePath, 'utf8');
  // Strip a leading BOM — some Windows tools add EF BB BF to the front
  // of utf8 files and the first line would otherwise come through
  // as "\uFEFF#EXTM3U" which blows up the # detector.
  const cleaned = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  const lines = cleaned.split(/\r?\n/);
  const dir = path.dirname(filePath);
  const paths: string[] = [];
  const skipped: ParsedM3U['skipped'] = [];
  // Default to the filename (sans .m3u8) as the playlist name, then
  // promote to any embedded `#PLAYLIST:<title>` directive we encounter
  // — that's the extended-M3U convention some tools (Winamp,
  // foobar2000) write. Exposing both lets the import UI pre-fill the
  // name field with the richer value while still letting the user
  // edit it to whatever they want.
  let playlistName = path.basename(filePath, '.m3u8');
  let embeddedName: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Directive lines — #EXTM3U header, #EXTINF:<dur>,<title>, #PLAYLIST: …
    // etc. Silently skip directives; if the line starts with # but
    // doesn't look like one of ours, still skip (other tools embed
    // custom extensions like #EXTGRP, #EXTVLCOPT, etc.).
    if (trimmed.startsWith('#')) {
      // Capture #PLAYLIST: title if present. Case-insensitive match
      // since some tools write #Playlist: or similar.
      const m = /^#PLAYLIST\s*:\s*(.+)$/i.exec(trimmed);
      if (m && m[1]) {
        const name = m[1].trim();
        if (name) { embeddedName = name; playlistName = name; }
      }
      continue;
    }

    // Ban absurdly-long "paths" (> 4 KB) and anything containing
    // non-printable junk — these are the giveaway that a file got
    // mangled (e.g. saved as UTF-16 then copy-pasted to UTF-8).
    if (trimmed.length > 4096) {
      skipped.push({ lineNo: i + 1, raw: trimmed.slice(0, 120) + '…', reason: 'line too long (>4 KB) — likely binary garbage' });
      continue;
    }
    if (/[\u0000-\u0008\u000E-\u001F]/.test(trimmed)) {
      skipped.push({ lineNo: i + 1, raw: trimmed.slice(0, 120), reason: 'contains control characters' });
      continue;
    }

    // Try to resolve the path. Anything that throws on normalize (very
    // rare — usually a poison path like NUL char in-band) gets captured.
    try {
      const isAbs = path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed);
      const full = isAbs ? trimmed : path.resolve(dir, trimmed);
      paths.push(path.normalize(full));
    } catch (err: any) {
      skipped.push({ lineNo: i + 1, raw: trimmed, reason: `path resolution failed: ${err?.message ?? err}` });
    }
  }
  return { paths, playlistName, embeddedName, skipped };
}

/**
 * Import .m3u8 files from the export folder as playlists in the DB — but only
 * for playlists that don't already exist (matched by name). Existing DB
 * playlists are never overwritten from disk; the app is source of truth once
 * a playlist exists here.
 *
 * Tracks are matched by file path. Unknown paths (files not yet in `tracks`)
 * are silently dropped — they'll be pickable up next time if the user scans
 * the containing folder.
 */
export interface ImportCorruption {
  /** Filename within the export dir, e.g. "Old mixtape.m3u8" */
  file: string;
  /** Absolute path — handed to fixCorruptPlaylistFiles() if the user
   *  opts in to a rewrite. */
  absPath: string;
  /** Issue summary for the UI. Either "parseFailed" (couldn't read
   *  the file at all) or "partial" (read N lines, M of them bad). */
  kind: 'parseFailed' | 'partial';
  /** Human-readable note for display. */
  message: string;
  /** Raw per-line skip reasons for the disclosure UI. Empty for
   *  parseFailed. */
  skippedLines: Array<{ lineNo: number; raw: string; reason: string }>;
  /** Total lines scanned + how many good paths survived. Null on
   *  parseFailed. */
  scanned: number | null;
  kept: number | null;
}

export interface ImportResult {
  imported: number;
  dir: string;
  corruptions: ImportCorruption[];
}

export async function importPlaylistsFromFolder(): Promise<ImportResult> {
  const settings = getSettings();
  if (!settings.playlistExport?.enabled) return { imported: 0, dir: '', corruptions: [] };
  let dir: string;
  try { dir = await resolveExportDir(); } catch { return { imported: 0, dir: '', corruptions: [] }; }

  let entries: string[] = [];
  try {
    entries = (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.m3u8'));
  } catch {
    return { imported: 0, dir, corruptions: [] };
  }

  const db = getDb();
  const existingNames = new Set(
    (db.prepare('SELECT name FROM playlists').all() as Array<{ name: string }>).map((r) => r.name.toLowerCase()),
  );
  // "Liked Songs" is represented by the track_likes table — don't import it as a real playlist.
  existingNames.add('liked songs');

  let imported = 0;
  const corruptions: ImportCorruption[] = [];
  for (const entry of entries) {
    const absPath = path.join(dir, entry);
    const baseName = path.basename(entry, '.m3u8');
    if (existingNames.has(baseName.toLowerCase())) continue;

    // Parse — best-effort. Only a truly unreadable file (disk error,
    // permissions, totally non-utf8) throws; malformed lines are
    // surfaced via `skipped`.
    let parsed: ParsedM3U;
    try {
      parsed = await parseM3U(absPath);
    } catch (err: any) {
      console.error('[playlist-export] import failed for', entry, err?.message ?? err);
      corruptions.push({
        file: entry,
        absPath,
        kind: 'parseFailed',
        message: `Couldn't read the file: ${err?.message ?? err}`,
        skippedLines: [],
        scanned: null,
        kept: null,
      });
      continue;
    }

    if (parsed.skipped.length > 0) {
      corruptions.push({
        file: entry,
        absPath,
        kind: 'partial',
        message: `Skipped ${parsed.skipped.length} malformed line${parsed.skipped.length === 1 ? '' : 's'} while importing.`,
        skippedLines: parsed.skipped,
        scanned: parsed.skipped.length + parsed.paths.length,
        kept: parsed.paths.length,
      });
    }

    if (parsed.paths.length === 0) {
      // Nothing usable left after skipping — still surfaces in
      // corruptions above so the user sees the file. Don't create an
      // empty playlist row.
      continue;
    }

    // Look up each path in the DB. Case-insensitive on Windows is nice but
    // tracks.path is stored with OS-native casing, so match directly first
    // and fall back to case-insensitive if needed.
    const findStmt = db.prepare('SELECT id FROM tracks WHERE path = ?');
    const findCi   = db.prepare('SELECT id FROM tracks WHERE LOWER(path) = LOWER(?)');
    const trackIds: number[] = [];
    for (const p of parsed.paths) {
      const row = (findStmt.get(p) as { id: number } | undefined) ?? (findCi.get(p) as { id: number } | undefined);
      if (row) trackIds.push(row.id);
    }
    if (trackIds.length === 0) continue;

    try {
      const now = Date.now();
      const info = db.prepare(
        'INSERT INTO playlists (name, description, kind, created_at, updated_at) VALUES (?, ?, \'manual\', ?, ?)',
      ).run(baseName, null, now, now);
      const newId = info.lastInsertRowid as number;
      const ptStmt = db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)');
      const tx = db.transaction(() => {
        trackIds.forEach((tid, i) => ptStmt.run(newId, tid, i, now));
      });
      tx();
      existingNames.add(baseName.toLowerCase());
      imported++;
    } catch (err: any) {
      console.error('[playlist-export] DB insert failed for', entry, err?.message ?? err);
    }
  }
  return { imported, dir, corruptions };
}

/**
 * Rewrite corrupt .m3u8 files in place — keeping only the successfully-
 * parsed paths, dropping the malformed lines. Takes a list of absolute
 * file paths so the caller can cherry-pick which ones to fix. Returns
 * how many files were rewritten and any failures.
 *
 * For 'parseFailed' corruptions there's nothing salvageable; we don't
 * attempt to rewrite those (caller filters by `kind === 'partial'`).
 */
export async function fixCorruptPlaylistFiles(absPaths: string[]): Promise<{ fixed: number; errors: Array<{ path: string; error: string }> }> {
  const errors: Array<{ path: string; error: string }> = [];
  let fixed = 0;
  for (const p of absPaths) {
    try {
      const parsed = await parseM3U(p);
      if (parsed.paths.length === 0) {
        errors.push({ path: p, error: 'nothing salvageable — refusing to overwrite with an empty file' });
        continue;
      }
      const dir = path.dirname(p);
      // Rewrite uses the same renderer as a DB-sourced export so the
      // format + #EXTM3U / #EXTINF metadata match what we'd emit
      // normally. We don't have duration info for imported tracks,
      // so EXTINF lines will get `-1` which M3U parsers treat as
      // unknown.
      const lines: string[] = ['#EXTM3U'];
      for (const abs of parsed.paths) {
        lines.push(`#EXTINF:-1,${path.basename(abs, path.extname(abs))}`);
        // Preserve the original absolute paths since we don't know
        // what pathStyle the original was written in.
        lines.push(abs);
      }
      const tmpPath = p + '.fixtmp';
      await fs.writeFile(tmpPath, lines.join('\n') + '\n', 'utf8');
      await fs.rename(tmpPath, p);
      fixed++;
      process.stdout.write(`[playlist-export] fixed corrupt playlist ${path.basename(p)} — kept ${parsed.paths.length}, dropped ${parsed.skipped.length}\n`);
    } catch (err: any) {
      errors.push({ path: p, error: err?.message ?? String(err) });
    }
  }
  return { fixed, errors };
}

// ----------------------------------------------------------------------------
// Scheduler: immediate vs on-close vs auto
// ----------------------------------------------------------------------------
//
// Every playlist-edit IPC handler used to await exportPlaylist() directly,
// which means a slow write (big playlist on SMB, cold disk) froze the UI
// for the duration of the write. `scheduleExportPlaylist` wraps that:
//
//   immediate  — call exportPlaylist now, time it. If > threshold, latch
//                autoDetectedMode to 'on-close' (only affects 'auto' mode;
//                explicit 'immediate' stays immediate).
//   on-close   — add to the dirty set, return synchronously. Exported
//                during app quit via flushDirtyPlaylists().
//   auto       — inspect settings.playlistExport.autoDetectedMode to pick
//                between the two paths above.
//
// Deletes follow the same scheduling. A playlist that's been renamed
// gets both a delete-of-old-name AND an export-of-new-name; when on-
// close is active, we queue the delete by old name too.

/** Latch threshold. A single export taking longer than this flips
 *  autoDetectedMode from 'immediate' to 'on-close'. 1 second is the
 *  user-perceptible boundary where UI lag starts feeling noticeable. */
const SLOW_SAVE_THRESHOLD_MS = 1000;

/** Dirty state — pending writes and deletions waiting for flush. Keyed
 *  by playlist id for writes (so rapid edits to the same playlist
 *  coalesce into one write at flush). Deletes are keyed by sanitised
 *  filename since the playlist row is already gone. */
const dirtyWriteIds = new Set<number>();
const dirtyDeleteNames = new Set<string>();

function currentEffectiveMode(): 'immediate' | 'on-close' {
  const s = getSettings().playlistExport;
  if (!s) return 'immediate';
  if (s.saveMode === 'immediate') return 'immediate';
  if (s.saveMode === 'on-close')  return 'on-close';
  // 'auto': trust what the scheduler has latched onto.
  return s.autoDetectedMode ?? 'immediate';
}

/** Latch the auto-detected mode to 'on-close' after observing a slow
 *  write. No-op if the user has explicitly set saveMode to something
 *  else — the auto flag only drives behaviour when saveMode='auto'. */
async function latchSlowMode(elapsedMs: number): Promise<void> {
  const s = getSettings().playlistExport;
  if (!s) return;
  if (s.autoDetectedMode === 'on-close') return; // already latched
  process.stdout.write(`[playlist-export] write took ${elapsedMs}ms — latching autoDetectedMode to 'on-close'\n`);
  await updateSettings({ playlistExport: { autoDetectedMode: 'on-close' } } as any);
}

/**
 * Schedule a playlist export. Fire-and-forget from the caller's POV:
 * IPC handlers can `void scheduleExportPlaylist(id)` after their DB
 * write and never block on it. Errors are logged, never thrown.
 */
export async function scheduleExportPlaylist(playlistId: number, _oldNameIfRenamed?: string | null): Promise<void> {
  const mode = currentEffectiveMode();
  if (mode === 'on-close') {
    dirtyWriteIds.add(playlistId);
    return;
  }
  const t0 = Date.now();
  await exportPlaylist(playlistId, _oldNameIfRenamed);
  const dt = Date.now() - t0;
  if (dt > SLOW_SAVE_THRESHOLD_MS) {
    // Slow write detected. Flip to on-close for subsequent edits.
    // This edit has already landed on disk, so no dirty queueing
    // needed for it specifically.
    await latchSlowMode(dt);
  }
}

/** Schedule a delete of an exported file by playlist name. Same
 *  immediate/on-close split as scheduleExportPlaylist. */
export async function scheduleRemoveExportedPlaylist(name: string): Promise<void> {
  const mode = currentEffectiveMode();
  if (mode === 'on-close') {
    dirtyDeleteNames.add(name);
    return;
  }
  const t0 = Date.now();
  await removeExportedPlaylist(name);
  const dt = Date.now() - t0;
  if (dt > SLOW_SAVE_THRESHOLD_MS) await latchSlowMode(dt);
}

/**
 * Flush every queued write and delete. Called from main.ts's
 * before-quit handler. Resolves when all I/O is complete. Also
 * callable via IPC for a manual "save now" button if we ever add
 * one — idempotent if nothing's dirty. */
export async function flushDirtyPlaylists(): Promise<{ wrote: number; deleted: number; errors: number }> {
  let wrote = 0, deleted = 0, errors = 0;
  // Snapshot + clear so newly-queued writes during flush (unlikely but
  // possible if IPC handlers land mid-quit) are captured by a second
  // flush call rather than silently dropped.
  const writes = Array.from(dirtyWriteIds);
  const deletes = Array.from(dirtyDeleteNames);
  dirtyWriteIds.clear();
  dirtyDeleteNames.clear();

  for (const name of deletes) {
    try { await removeExportedPlaylist(name); deleted++; }
    catch (err: any) {
      errors++;
      process.stdout.write(`[playlist-export] flush delete "${name}" failed: ${err?.message ?? err}\n`);
    }
  }
  for (const id of writes) {
    try { await exportPlaylist(id); wrote++; }
    catch (err: any) {
      errors++;
      process.stdout.write(`[playlist-export] flush write id=${id} failed: ${err?.message ?? err}\n`);
    }
  }
  if (wrote > 0 || deleted > 0) {
    process.stdout.write(`[playlist-export] flushed ${wrote} write${wrote === 1 ? '' : 's'}, ${deleted} delete${deleted === 1 ? '' : 's'} before quit\n`);
  }
  return { wrote, deleted, errors };
}

/** Whether any dirty playlist writes are pending. Used by the settings
 *  panel to show a "N pending" indicator when on-close mode is active. */
export function dirtyPlaylistCount(): number {
  return dirtyWriteIds.size + dirtyDeleteNames.size;
}

// ----------------------------------------------------------------------------
// Manual Save Now / Load Now — single-playlist variants
// ----------------------------------------------------------------------------
//
// Regular export/import works on the WHOLE folder of playlists. The
// PlaylistView "Save Now" / "Load Now" buttons drive this narrower
// surface: one playlist at a time, with explicit merge-or-overwrite
// semantics instead of the "skip existing" default of the folder
// importer. Liked Songs is treated like any other playlist here —
// its file is `Liked Songs.m3u8`, and tracks round-trip through the
// track_likes table instead of playlist_tracks.

/**
 * Peek at where a playlist's file WOULD be written and whether it
 * already exists. Used by the UI to decide whether to prompt the
 * user for a merge/overwrite decision before calling savePlaylistNow.
 * Never throws — on config error returns `{ exists: false, path: '' }`.
 */
export async function peekPlaylistFile(playlistId: number): Promise<{
  exists: boolean;
  path: string;
  existingTrackCount: number | null;
}> {
  try {
    const data = getPlaylistRows(playlistId);
    if (!data) return { exists: false, path: '', existingTrackCount: null };
    const dir = await resolveExportDir();
    const filePath = path.join(dir, sanitizeFilename(data.name) + '.m3u8');
    try {
      await fs.access(filePath);
    } catch {
      return { exists: false, path: filePath, existingTrackCount: null };
    }
    // File is there — read it and count salvageable paths so the UI
    // can show "merge with 42 tracks on disk" or similar.
    try {
      const parsed = await parseM3U(filePath);
      return { exists: true, path: filePath, existingTrackCount: parsed.paths.length };
    } catch {
      return { exists: true, path: filePath, existingTrackCount: null };
    }
  } catch (err: any) {
    process.stdout.write(`[playlist-export] peek failed: ${err?.message ?? err}\n`);
    return { exists: false, path: '', existingTrackCount: null };
  }
}

/**
 * Force-write a single playlist to disk, bypassing the scheduler.
 *
 *   mode = 'overwrite'  — same as regular export: DB → file, clobber.
 *   mode = 'merge'      — read the existing file, union its paths
 *                          with the current DB track list, de-dupe by
 *                          normalized path, write the result back.
 *                          Order: DB tracks first (in their DB order),
 *                          then any extra paths from the file that
 *                          weren't already in the DB playlist.
 *
 * For manual playlists, merge also INSERTS any disk-only tracks back
 * into the DB playlist so in-app state matches what's on disk after
 * the merge. For Liked Songs, disk-only tracks get a fresh row in
 * track_likes.
 *
 * Returns counts so the UI can show "merged 27 tracks + 5 from disk → 32 saved".
 */
export async function savePlaylistNow(
  playlistId: number,
  mode: 'overwrite' | 'merge',
): Promise<{ ok: boolean; written: number; addedFromDisk: number; path: string; message: string }> {
  const data = getPlaylistRows(playlistId);
  if (!data) return { ok: false, written: 0, addedFromDisk: 0, path: '', message: 'Playlist not found.' };

  let target = '';
  try {
    const dir = await resolveExportDir();
    target = path.join(dir, sanitizeFilename(data.name) + '.m3u8');

    let finalTracks = data.tracks;
    let addedFromDisk = 0;

    if (mode === 'merge') {
      // Read the on-disk file (if any), union with DB tracks, de-dupe.
      try {
        await fs.access(target);
        const parsed = await parseM3U(target);
        const knownPaths = new Set(data.tracks.map((t) => path.normalize(t.path).toLowerCase()));
        const extraPaths: string[] = [];
        for (const p of parsed.paths) {
          const norm = path.normalize(p).toLowerCase();
          if (!knownPaths.has(norm)) {
            knownPaths.add(norm);
            extraPaths.push(p);
          }
        }
        if (extraPaths.length > 0) {
          // Look up the DB row for each extra path so we can both
          // render them into the .m3u8 with proper EXTINF lines AND
          // add them to the DB playlist (or track_likes) for consistency.
          const db = getDb();
          const findStmt = db.prepare(`
            SELECT t.id, t.path, t.duration_sec AS durationSec, t.title, ar.name AS artist
            FROM tracks t
            LEFT JOIN artists ar ON ar.id = t.artist_id
            WHERE t.path = ? OR LOWER(t.path) = LOWER(?)
            LIMIT 1
          `);
          const extraRows: Array<{ id: number; path: string; durationSec: number | null; title: string; artist: string | null }> = [];
          for (const p of extraPaths) {
            const row = findStmt.get(p, p) as any;
            if (row) extraRows.push(row);
          }

          if (extraRows.length > 0) {
            // Add to DB playlist / likes so UI reflects the merged state.
            if (playlistId === LIKED_PLAYLIST_ID) {
              const now = Date.now();
              const ins = db.prepare('INSERT OR IGNORE INTO track_likes (track_id, liked_at) VALUES (?, ?)');
              const tx = db.transaction((ids: number[]) => { for (const tid of ids) ins.run(tid, now); });
              tx(extraRows.map((r) => r.id));
            } else {
              const now = Date.now();
              const maxRow = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM playlist_tracks WHERE playlist_id = ?')
                .get(playlistId) as { m: number };
              let pos = maxRow.m + 1;
              const ins = db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)');
              const tx = db.transaction(() => {
                for (const r of extraRows) ins.run(playlistId, r.id, pos++, now);
                db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, playlistId);
              });
              tx();
            }
            addedFromDisk = extraRows.length;
            finalTracks = [
              ...data.tracks,
              ...extraRows.map((r) => ({ path: r.path, durationSec: r.durationSec, title: r.title, artist: r.artist })),
            ];
          }
        }
      } catch { /* file doesn't exist — merge degrades to overwrite */ }
    }

    const contents = renderM3U(finalTracks, path.dirname(target), data.description);
    await fs.writeFile(target, contents, 'utf8');
    if (lastExportError) lastExportError = null;
    return {
      ok: true,
      written: finalTracks.length,
      addedFromDisk,
      path: target,
      message: mode === 'merge' && addedFromDisk > 0
        ? `Merged ${data.tracks.length} + ${addedFromDisk} from disk → ${finalTracks.length} tracks saved.`
        : `Saved ${finalTracks.length} tracks.`,
    };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    lastExportError = { message, at: Date.now(), path: target || null };
    return { ok: false, written: 0, addedFromDisk: 0, path: target, message: `Save failed: ${message}` };
  }
}

/**
 * Force-load a single playlist FROM disk into the DB, de-duped against
 * what's already in the DB. Opposite direction of savePlaylistNow.
 *
 * Use case: user edited the .m3u8 in another tool (MusicBee on another
 * machine, hand-edit in a text editor), wants those additions reflected
 * here without waiting for startup auto-import.
 *
 * De-dupe: a track already in the DB playlist is skipped (not
 * re-added). A path whose DB track row doesn't exist (file not in the
 * library) is counted as `missing` and reported back so the UI can
 * show "3 paths skipped — files not in your library yet".
 */
export async function loadPlaylistNow(playlistId: number): Promise<{
  ok: boolean;
  added: number;
  skipped: number;
  missing: number;
  path: string;
  message: string;
}> {
  const data = getPlaylistRows(playlistId);
  if (!data) return { ok: false, added: 0, skipped: 0, missing: 0, path: '', message: 'Playlist not found.' };

  let target = '';
  try {
    const dir = await resolveExportDir();
    target = path.join(dir, sanitizeFilename(data.name) + '.m3u8');
    try { await fs.access(target); }
    catch {
      return { ok: false, added: 0, skipped: 0, missing: 0, path: target, message: `No file on disk at ${target}` };
    }

    const parsed = await parseM3U(target);
    if (parsed.paths.length === 0) {
      return { ok: true, added: 0, skipped: 0, missing: 0, path: target, message: 'File on disk has no valid tracks.' };
    }

    const db = getDb();
    // Build the set of track IDs already in this playlist so we skip them.
    const existingIds = new Set<number>();
    if (playlistId === LIKED_PLAYLIST_ID) {
      (db.prepare('SELECT track_id FROM track_likes').all() as Array<{ track_id: number }>)
        .forEach((r) => existingIds.add(r.track_id));
    } else {
      (db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ?').all(playlistId) as Array<{ track_id: number }>)
        .forEach((r) => existingIds.add(r.track_id));
    }

    const findStmt = db.prepare('SELECT id FROM tracks WHERE path = ?');
    const findCi = db.prepare('SELECT id FROM tracks WHERE LOWER(path) = LOWER(?)');
    const toAdd: number[] = [];
    let skipped = 0;
    let missing = 0;
    for (const p of parsed.paths) {
      const row = (findStmt.get(p) as { id: number } | undefined) ?? (findCi.get(p) as { id: number } | undefined);
      if (!row) { missing++; continue; }
      if (existingIds.has(row.id)) { skipped++; continue; }
      existingIds.add(row.id);
      toAdd.push(row.id);
    }

    if (toAdd.length > 0) {
      const now = Date.now();
      if (playlistId === LIKED_PLAYLIST_ID) {
        const ins = db.prepare('INSERT OR IGNORE INTO track_likes (track_id, liked_at) VALUES (?, ?)');
        const tx = db.transaction((ids: number[]) => { for (const tid of ids) ins.run(tid, now); });
        tx(toAdd);
      } else {
        const maxRow = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM playlist_tracks WHERE playlist_id = ?')
          .get(playlistId) as { m: number };
        let pos = maxRow.m + 1;
        const ins = db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)');
        const tx = db.transaction(() => {
          for (const tid of toAdd) ins.run(playlistId, tid, pos++, now);
          db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, playlistId);
        });
        tx();
      }
    }

    const msgParts: string[] = [`Added ${toAdd.length}`];
    if (skipped > 0) msgParts.push(`skipped ${skipped} already in playlist`);
    if (missing > 0) msgParts.push(`${missing} path${missing === 1 ? '' : 's'} not in library`);
    return {
      ok: true,
      added: toAdd.length,
      skipped,
      missing,
      path: target,
      message: msgParts.join(', ') + '.',
    };
  } catch (err: any) {
    return { ok: false, added: 0, skipped: 0, missing: 0, path: target, message: `Load failed: ${err?.message ?? err}` };
  }
}

/**
 * Cross-machine safety net for the Like button. If the on-disk
 * `Liked Songs.m3u8` has been modified since we last wrote or read
 * it (e.g. another machine sharing the same export folder added a
 * like), pull those new likes into our DB before the calling code
 * proceeds with its own like-write. Otherwise the next export would
 * clobber the other machine's additions.
 *
 * Called from the LIKE_TOGGLE IPC handler at the top of every toggle.
 * Also cheap to skip — we compare mtime first, only read the file
 * if it changed. On SMB this is one RTT in the common "no change"
 * case, two more (readFile + parseM3U) when it did change.
 *
 * Limitation we accept: this only reconciles ADDS. If another
 * machine UNLIKED a song that we still have liked, we won't
 * remove our row — the next save will push the song back onto
 * disk. Resolving that properly needs per-track timestamps which
 * the .m3u8 format doesn't carry. Rare in practice; worth calling
 * out.
 */
export async function reconcileLikedIfDiskChanged(): Promise<{
  reconciled: boolean;
  added: number;
  skipped: number;
  missing: number;
  reason: string;
}> {
  const settings = getSettings();
  if (!settings.playlistExport?.enabled || !settings.playlistExport.exportLiked) {
    return { reconciled: false, added: 0, skipped: 0, missing: 0, reason: 'disabled' };
  }
  let filePath: string;
  try {
    const dir = await resolveExportDir();
    filePath = path.join(dir, sanitizeFilename(LIKED_FILENAME) + '.m3u8');
  } catch {
    // Export folder unreachable — skip. Don't throw; user's click on
    // the heart icon shouldn't fail just because a share is down.
    return { reconciled: false, added: 0, skipped: 0, missing: 0, reason: 'no-export-dir' };
  }
  let mtimeMs: number;
  try {
    const st = await fs.stat(filePath);
    mtimeMs = st.mtimeMs;
  } catch {
    // File doesn't exist yet — first like ever, or someone deleted
    // the file. Either way, nothing to reconcile from.
    return { reconciled: false, added: 0, skipped: 0, missing: 0, reason: 'no-file' };
  }
  // mtimeMs from fs.stat is a float. Using strict equality is fine
  // for "same underlying FS event" but we guard with a 1ms tolerance
  // for platforms / filesystems with low-resolution mtimes (FAT32
  // rounds to 2-second chunks). Any bigger gap → someone else wrote.
  if (likedKnownMtimeMs != null && Math.abs(mtimeMs - likedKnownMtimeMs) < 1) {
    return { reconciled: false, added: 0, skipped: 0, missing: 0, reason: 'unchanged' };
  }
  // File differs from what we last wrote/saw. Pull anything new into
  // the DB. loadPlaylistNow is additive (de-dupes against existing
  // track_likes), which is exactly what we want here.
  const result = await loadPlaylistNow(LIKED_PLAYLIST_ID);
  // Remember the mtime we just observed so the next toggle's stat
  // compares against this version, not the pre-reconcile state.
  likedKnownMtimeMs = mtimeMs;
  return {
    reconciled: true,
    added: result.added,
    skipped: result.skipped,
    missing: result.missing,
    reason: 'disk-changed',
  };
}

/** Export every playlist + liked. Used on settings change and manual "re-export all". */
export async function exportAllPlaylists(): Promise<{ count: number; dir: string }> {
  const settings = getSettings();
  if (!settings.playlistExport?.enabled) return { count: 0, dir: '' };
  const dir = await resolveExportDir();
  const db = getDb();
  const ids = (db.prepare('SELECT id FROM playlists').all() as Array<{ id: number }>).map((r) => r.id);
  let count = 0;
  for (const id of ids) {
    await exportPlaylist(id);
    count++;
  }
  if (settings.playlistExport.exportLiked) {
    await exportPlaylist(LIKED_PLAYLIST_ID);
    count++;
  }
  return { count, dir };
}
