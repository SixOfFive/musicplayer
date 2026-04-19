import path from 'node:path';
import fs from 'node:fs/promises';
import { getSettings } from './settings-store';
import { getDb } from './db';

/**
 * Save album cover art to disk, obeying the user's `coverArtStorage` setting.
 *
 * Two strategies:
 *  - 'cache'        → write to coverArtCachePath/album_<id>.<ext>
 *  - 'album-folder' → write alongside the audio files as <coverArtFilename>.<ext>
 *                     (e.g. /Music/Radiohead/OK Computer/cover.jpg).
 *                     Falls back to 'cache' if we can't determine the folder or
 *                     the write fails (permissions, read-only network share, etc.).
 *
 * Returns the absolute path to the written file, or null on failure.
 * Also updates `albums.cover_art_path` so the renderer can display it.
 */
export async function saveAlbumArt(
  albumId: number,
  bytes: Uint8Array,
  mimeType: string,
): Promise<string | null> {
  const settings = getSettings();
  const ext = normaliseExt(mimeType);
  const db = getDb();
  const buf = Buffer.from(bytes);

  // Strategy 1: album folder.
  if (settings.library.coverArtStorage === 'album-folder') {
    const folder = await resolveAlbumFolder(albumId);
    if (folder) {
      const filename = `${settings.library.coverArtFilename || 'cover'}.${ext}`;
      const target = path.join(folder, filename);
      try {
        await fs.writeFile(target, buf);
        db.prepare('UPDATE albums SET cover_art_path = ? WHERE id = ?').run(target, albumId);
        return target;
      } catch (err) {
        // Fall through to cache on any write error (permission, disk full, etc.).
        console.warn(`[cover-art] failed to write ${target}, falling back to cache:`, err);
      }
    }
  }

  // Strategy 2: cache dir (also used as fallback).
  try {
    await fs.mkdir(settings.library.coverArtCachePath, { recursive: true });
    const target = path.join(settings.library.coverArtCachePath, `album_${albumId}.${ext}`);
    await fs.writeFile(target, buf);
    db.prepare('UPDATE albums SET cover_art_path = ? WHERE id = ?').run(target, albumId);
    return target;
  } catch (err) {
    console.error(`[cover-art] cache write failed for album ${albumId}:`, err);
    return null;
  }
}

/**
 * Compute the album's "folder" by looking at one of its tracks' paths.
 * For a typical /Music/Artist/Album/track.flac layout this is the album dir.
 * Returns null if the album has no tracks or the directory is unreachable.
 */
async function resolveAlbumFolder(albumId: number): Promise<string | null> {
  const row = getDb()
    .prepare('SELECT path FROM tracks WHERE album_id = ? LIMIT 1')
    .get(albumId) as { path: string } | undefined;
  if (!row) return null;
  const dir = path.dirname(row.path);
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return null;
    return dir;
  } catch {
    return null;
  }
}

function normaliseExt(mime: string): string {
  const sub = (mime.split('/')[1] ?? 'jpg').toLowerCase();
  // Map exotic mime subtypes back to common extensions.
  if (sub === 'jpeg') return 'jpg';
  // Strip any non-alnum just in case (e.g. "jpeg; charset=binary").
  const clean = sub.replace(/[^a-z0-9]/g, '');
  return clean || 'jpg';
}

export interface MigrateArtSummary {
  total: number;          // albums considered (had cover art in cache)
  moved: number;          // successfully relocated
  skippedExisting: number; // album folder already had a cover.* — left DB pointing there
  skippedNoFolder: number; // couldn't resolve album folder (missing tracks, unreachable path)
  failed: number;          // write/copy errors
  errors: string[];        // one line per failure, capped at 20
}

/**
 * Migrate every cover art file that currently lives in the app cache folder
 * INTO each album's music folder (as `<coverArtFilename>.<ext>`), and point
 * the DB at the new location. Also deletes the original cache copy on
 * success — the whole idea is to consolidate so there's exactly one canonical
 * cover per album, owned by the music collection.
 *
 * Called from Settings → Library ("Move cover art to album folders") and
 * auto-triggered when the user flips the `coverArtStorage` setting from
 * 'cache' to 'album-folder'. Safe to re-run — albums already stored in their
 * folder are skipped.
 *
 * Does NOT touch playlists, audio files, or any non-cover-art data.
 * Does NOT overwrite an existing cover.* in the album folder (if one is
 * already there, we update the DB to point at it and delete our orphaned
 * cache copy; never clobber the user's own file).
 */
export async function migrateCoverArtToAlbumFolders(): Promise<MigrateArtSummary> {
  const settings = getSettings();
  const cacheDir = path.resolve(settings.library.coverArtCachePath);
  const coverBaseName = settings.library.coverArtFilename || 'cover';
  const db = getDb();

  const summary: MigrateArtSummary = {
    total: 0, moved: 0, skippedExisting: 0, skippedNoFolder: 0, failed: 0, errors: [],
  };

  // Only consider albums whose art currently lives inside the cache dir —
  // anything already in an album folder is exactly where we want it.
  const rows = db.prepare(`
    SELECT id, cover_art_path AS coverArtPath
    FROM albums
    WHERE cover_art_path IS NOT NULL AND cover_art_path != ''
  `).all() as Array<{ id: number; coverArtPath: string }>;

  const updateStmt = db.prepare('UPDATE albums SET cover_art_path = ? WHERE id = ?');

  for (const row of rows) {
    const src = path.resolve(row.coverArtPath);
    // Skip anything that isn't in the cache dir (already in album folder, or
    // a user-placed cover outside our control).
    if (!isInside(src, cacheDir)) continue;
    summary.total++;

    const folder = await resolveAlbumFolder(row.id);
    if (!folder) { summary.skippedNoFolder++; continue; }

    const ext = path.extname(src).replace(/^\./, '').toLowerCase() || 'jpg';
    const target = path.join(folder, `${coverBaseName}.${ext}`);

    // If the album folder already has a cover.<ext> that ISN'T ours, respect
    // it: point the DB at the user's file and remove our orphaned cache copy.
    if (await fileExists(target) && path.resolve(target) !== src) {
      try {
        updateStmt.run(target, row.id);
        await fs.unlink(src).catch(() => { /* best effort */ });
        summary.skippedExisting++;
        continue;
      } catch (err: any) {
        summary.failed++;
        if (summary.errors.length < 20) summary.errors.push(`album ${row.id}: ${err?.message ?? err}`);
        continue;
      }
    }

    try {
      // `fs.rename` is atomic on the same volume but fails cross-volume
      // (cache on C:, music on M:) — so copy-then-unlink as a fallback.
      try {
        await fs.rename(src, target);
      } catch (renameErr: any) {
        if (renameErr?.code === 'EXDEV' || renameErr?.code === 'EPERM' || renameErr?.code === 'ENOTSUP') {
          await fs.copyFile(src, target);
          await fs.unlink(src).catch(() => { /* ok if we can't delete cache copy */ });
        } else {
          throw renameErr;
        }
      }
      updateStmt.run(target, row.id);
      summary.moved++;
    } catch (err: any) {
      summary.failed++;
      if (summary.errors.length < 20) summary.errors.push(`album ${row.id}: ${err?.message ?? err}`);
    }
  }

  return summary;
}

/** Portable "is `child` a descendant of `parent`?" check. */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}
