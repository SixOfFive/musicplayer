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
