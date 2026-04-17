import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getDb } from './db';
import { getSettings } from './settings-store';
import { LIKED_PLAYLIST_ID } from '../../shared/types';

const LIKED_FILENAME = 'Liked Songs';

/**
 * Resolve the directory where playlists should be written.
 *   1. settings.playlistExport.folder if set
 *   2. <first music dir>/Playlists
 *   3. userData/Playlists (always writable fallback)
 *
 * Falls back on any permission error. Always creates the directory.
 */
async function resolveExportDir(): Promise<string> {
  const settings = getSettings();
  const explicit = settings.playlistExport?.folder?.trim();
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);

  const firstMusicDir = (getDb()
    .prepare('SELECT path FROM directories WHERE enabled = 1 ORDER BY id LIMIT 1')
    .get() as { path: string } | undefined)?.path;
  if (firstMusicDir) candidates.push(path.join(firstMusicDir, 'Playlists'));

  candidates.push(path.join(app.getPath('userData'), 'Playlists'));

  for (const dir of candidates) {
    try {
      await fs.mkdir(dir, { recursive: true });
      // Probe writability.
      const probe = path.join(dir, '.mp-write-probe');
      await fs.writeFile(probe, '');
      await fs.unlink(probe);
      return dir;
    } catch {
      /* try next */
    }
  }
  throw new Error('No writable playlist export directory found');
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

/**
 * Write (or delete) a single playlist's .m3u8 file.
 * Safe to call from any IPC handler. Failures are logged, not thrown — we
 * never want a disk-write error to break an otherwise-successful DB op.
 */
export async function exportPlaylist(playlistId: number, _oldNameIfRenamed?: string | null): Promise<void> {
  try {
    const settings = getSettings();
    if (!settings.playlistExport?.enabled) return;
    if (playlistId === LIKED_PLAYLIST_ID && !settings.playlistExport.exportLiked) return;

    const data = getPlaylistRows(playlistId);
    if (!data) return;

    const dir = await resolveExportDir();
    const filename = sanitizeFilename(data.name) + '.m3u8';
    const target = path.join(dir, filename);
    const contents = renderM3U(data.tracks, dir, data.description);
    await fs.writeFile(target, contents, 'utf8');
  } catch (err: any) {
    console.error('[playlist-export] write failed', err?.message ?? err);
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
async function parseM3U(filePath: string): Promise<{ paths: string[]; playlistName: string }> {
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const dir = path.dirname(filePath);
  const paths: string[] = [];
  let playlistName = path.basename(filePath, '.m3u8');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#PLAYLIST:')) {
      // Some players write a title here; we prefer the filename, but keep it for name fallback.
      continue;
    }
    if (trimmed.startsWith('#')) continue;
    // Absolute vs relative resolution.
    const isAbs = path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed);
    const full = isAbs ? trimmed : path.resolve(dir, trimmed);
    // Normalize slashes for the current OS (m3u often uses forward slashes on Windows).
    paths.push(path.normalize(full));
  }
  return { paths, playlistName };
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
export async function importPlaylistsFromFolder(): Promise<{ imported: number; dir: string }> {
  const settings = getSettings();
  if (!settings.playlistExport?.enabled) return { imported: 0, dir: '' };
  let dir: string;
  try { dir = await resolveExportDir(); } catch { return { imported: 0, dir: '' }; }

  let entries: string[] = [];
  try {
    entries = (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.m3u8'));
  } catch {
    return { imported: 0, dir };
  }

  const db = getDb();
  const existingNames = new Set(
    (db.prepare('SELECT name FROM playlists').all() as Array<{ name: string }>).map((r) => r.name.toLowerCase()),
  );
  // "Liked Songs" is represented by the track_likes table — don't import it as a real playlist.
  existingNames.add('liked songs');

  let imported = 0;
  for (const entry of entries) {
    const baseName = path.basename(entry, '.m3u8');
    if (existingNames.has(baseName.toLowerCase())) continue;

    try {
      const { paths } = await parseM3U(path.join(dir, entry));
      if (paths.length === 0) continue;

      // Look up each path in the DB. Case-insensitive on Windows is nice but
      // tracks.path is stored with OS-native casing, so match directly first
      // and fall back to case-insensitive if needed.
      const findStmt = db.prepare('SELECT id FROM tracks WHERE path = ?');
      const findCi   = db.prepare('SELECT id FROM tracks WHERE LOWER(path) = LOWER(?)');
      const trackIds: number[] = [];
      for (const p of paths) {
        const row = (findStmt.get(p) as { id: number } | undefined) ?? (findCi.get(p) as { id: number } | undefined);
        if (row) trackIds.push(row.id);
      }
      if (trackIds.length === 0) continue;

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
      console.error('[playlist-export] import failed for', entry, err?.message ?? err);
    }
  }
  return { imported, dir };
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
