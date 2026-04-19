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

/**
 * Look in a folder for a cover art file placed by another tool / another
 * machine. The priority order matches the de-facto convention that Jellyfin,
 * Plex, MusicBee, foobar2000, kid3 and friends all use:
 *
 *     {userPreferred}.ext  → configurable in Settings → Library (default 'cover')
 *     cover.ext            → most common
 *     folder.ext           → Windows / older Windows Media Player convention
 *     front.ext            → MusicBrainz Picard's default export
 *     album.ext            → rarer, but some rippers use it
 *
 * Extensions checked in order: jpg, jpeg, png, webp.
 *
 * Returns the first matching absolute path, or null if none of them exist.
 * Case-insensitive lookup so "Cover.JPG" works on case-sensitive filesystems.
 */
export async function findFolderCover(folder: string, preferredBaseName?: string): Promise<string | null> {
  const preferred = (preferredBaseName || 'cover').toLowerCase();
  // De-dup in case the user's preferred name is one of the fallbacks.
  const baseNames = Array.from(new Set([preferred, 'cover', 'folder', 'front', 'album']));
  const exts = ['.jpg', '.jpeg', '.png', '.webp'];

  let entries: string[];
  try { entries = await fs.readdir(folder); }
  catch { return null; } // folder unreachable / permission / path doesn't exist

  // Build a lowercase-name → original-name map so we can look up without
  // iterating repeatedly. This matters on libraries with huge albums
  // (hundreds of entries per folder).
  const lookup = new Map<string, string>();
  for (const e of entries) lookup.set(e.toLowerCase(), e);

  for (const base of baseNames) {
    for (const ext of exts) {
      const orig = lookup.get(`${base}${ext}`);
      if (orig) return path.join(folder, orig);
    }
  }
  return null;
}

/**
 * Scan every album with no cover_art_path and probe its folder for an
 * existing cover.* / folder.* / etc. file. Update the DB when one is found.
 *
 * The use case this was written for: shared music filesystem (NAS, synced
 * cloud folder, SMB share) where one machine has downloaded covers into the
 * album folders and the OTHER machine's DB still has NULL cover_art_path
 * because ITS scan happened before the covers arrived. Without this, the
 * second machine would queue all those albums for online fetch on startup,
 * duplicating work that already happened on disk.
 *
 * Runs at startup before resumeArtFetchOnStartup so the online fetcher
 * doesn't waste time re-downloading art that's already on disk. Also called
 * manually from the Settings button if the user wants to kick it off later.
 *
 * Returns { scanned, reclaimed } — scanned is the number of NULL-art albums
 * we looked at, reclaimed is how many had existing folder covers we picked
 * up.
 */
export async function reclaimFolderCovers(): Promise<{ scanned: number; reclaimed: number }> {
  const db = getDb();
  const settings = getSettings();
  const rows = db.prepare(`
    SELECT id FROM albums
    WHERE cover_art_path IS NULL OR cover_art_path = ''
  `).all() as Array<{ id: number }>;

  const updateStmt = db.prepare('UPDATE albums SET cover_art_path = ?, art_lookup_failed = 0 WHERE id = ?');

  let reclaimed = 0;
  for (const row of rows) {
    const folder = await resolveAlbumFolder(row.id);
    if (!folder) continue;
    const found = await findFolderCover(folder, settings.library.coverArtFilename);
    if (found) {
      updateStmt.run(found, row.id);
      reclaimed++;
    }
  }
  return { scanned: rows.length, reclaimed };
}
