import type { BrowserWindow, IpcMain } from 'electron';
import { app, shell } from 'electron';
import fs from 'node:fs/promises';
import { IPC, type TrackQuery, type AlbumQuery, type TrackSort, type AlbumSort } from '../../shared/types';
import { getDb } from '../services/db';
import { getSettings } from '../services/settings-store';

const TRACK_SORT_COL: Record<TrackSort, string> = {
  title: 't.title',
  artist: 'ar.name',
  album: 'al.title',
  year: 't.year',
  genre: 't.genre',
  duration: 't.duration_sec',
  date_added: 't.date_added',
  track_no: 't.track_no',
};
const ALBUM_SORT_COL: Record<AlbumSort, string> = {
  title: 'al.title',
  artist: 'ar.name',
  year: 'al.year',
  genre: 'al.genre',
  track_count: 'track_count',
};

export function registerLibraryIpc(ipcMain: IpcMain, _getWin: () => BrowserWindow | null) {
  ipcMain.handle(IPC.LIBRARY_LIST_DIRS, () => {
    const rows = getDb()
      .prepare('SELECT id, path, enabled, last_scanned_at FROM directories ORDER BY id')
      .all() as Array<{ id: number; path: string; enabled: number; last_scanned_at: number | null }>;
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      enabled: !!r.enabled,
      lastScannedAt: r.last_scanned_at,
    }));
  });

  ipcMain.handle(IPC.LIBRARY_ADD_DIR, (_e, p: string) => {
    getDb().prepare('INSERT OR IGNORE INTO directories (path) VALUES (?)').run(p);
    return true;
  });

  ipcMain.handle(IPC.LIBRARY_REMOVE_DIR, (_e, id: number) => {
    getDb().prepare('DELETE FROM directories WHERE id = ?').run(id);
    return true;
  });

  ipcMain.handle(IPC.LIBRARY_TRACKS, (_e, opts: TrackQuery) => {
    const limit = Math.min(opts.limit ?? 500, 5000);
    const offset = opts.offset ?? 0;
    const sortCol = TRACK_SORT_COL[opts.sortBy ?? 'date_added'] ?? 't.date_added';
    const sortDir = opts.sortDir === 'asc' ? 'ASC' : 'DESC';
    const where = opts.query ? `WHERE t.title LIKE @q OR ar.name LIKE @q OR al.title LIKE @q` : '';
    const q = opts.query ? `%${opts.query}%` : undefined;
    return getDb()
      .prepare(`
        SELECT t.*, ar.name AS artist, al.title AS album, al.cover_art_path AS cover_art_path
        FROM tracks t
        LEFT JOIN artists ar ON ar.id = t.artist_id
        LEFT JOIN albums al ON al.id = t.album_id
        ${where}
        ORDER BY ${sortCol} ${sortDir}
        LIMIT @limit OFFSET @offset
      `)
      .all({ limit, offset, q });
  });

  ipcMain.handle(IPC.LIBRARY_ALBUMS, (_e, opts: AlbumQuery) => {
    const limit = Math.min(opts.limit ?? 500, 5000);
    const offset = opts.offset ?? 0;
    const sortCol = ALBUM_SORT_COL[opts.sortBy ?? 'title'] ?? 'al.title';
    const sortDir = opts.sortDir === 'desc' ? 'DESC' : 'ASC';
    const whereParts: string[] = [];
    if (opts.query) whereParts.push(`(al.title LIKE @q OR ar.name LIKE @q)`);
    if (opts.genre) whereParts.push(`al.genre = @genre`);
    const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const q = opts.query ? `%${opts.query}%` : undefined;
    return getDb()
      .prepare(`
        SELECT al.id, al.title, al.year, al.genre, al.cover_art_path, ar.name AS artist,
               (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS track_count
        FROM albums al
        LEFT JOIN artists ar ON ar.id = al.artist_id
        ${where}
        ORDER BY ${sortCol} ${sortDir}
        LIMIT @limit OFFSET @offset
      `)
      .all({ limit, offset, q, genre: opts.genre });
  });

  ipcMain.handle(IPC.LIBRARY_ARTISTS, () => {
    return getDb()
      .prepare(`
        SELECT ar.id, ar.name,
               (SELECT COUNT(DISTINCT al.id) FROM albums al WHERE al.artist_id = ar.id) AS album_count,
               (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = ar.id) AS track_count
        FROM artists ar
        ORDER BY ar.name
      `)
      .all();
  });

  ipcMain.handle(IPC.LIBRARY_ALBUM, (_e, id: number) => {
    const album = getDb()
      .prepare(`
        SELECT al.*, ar.name AS artist
        FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id
        WHERE al.id = ?
      `)
      .get(id);
    const tracks = getDb()
      .prepare(`
        SELECT t.*, ar.name AS artist
        FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id
        WHERE t.album_id = ?
        ORDER BY disc_no, track_no
      `)
      .all(id);
    return { album, tracks };
  });

  ipcMain.handle(IPC.LIBRARY_SEARCH, (_e, q: string) => {
    const like = `%${q}%`;
    return {
      tracks: getDb()
        .prepare(`
          SELECT t.id, t.title, ar.name AS artist, al.title AS album
          FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id
          LEFT JOIN albums al ON al.id = t.album_id
          WHERE t.title LIKE ? LIMIT 50
        `)
        .all(like),
      albums: getDb()
        .prepare(`SELECT id, title FROM albums WHERE title LIKE ? LIMIT 25`)
        .all(like),
      artists: getDb()
        .prepare(`SELECT id, name FROM artists WHERE name LIKE ? LIMIT 25`)
        .all(like),
    };
  });

  ipcMain.handle(IPC.PLAYBACK_FILE_URL, (_e, p: string) => {
    // Use our custom protocol so the renderer never sees raw file:// URLs.
    return `mp-media:///${encodeURIComponent(p)}`;
  });

  // Default music directory following OS conventions (XDG 'MUSIC', macOS ~/Music,
  // Windows shell Music folder). Electron resolves these for us.
  ipcMain.handle(IPC.FIRST_RUN_DEFAULT_DIR, () => {
    try { return app.getPath('music'); } catch { return app.getPath('home'); }
  });

  // Delete a track. Always removes it from the DB; optionally deletes the file.
  ipcMain.handle(IPC.LIBRARY_DELETE_TRACK, async (_e, trackId: number, deleteFile = false) => {
    const settings = getSettings();
    const row = getDb().prepare('SELECT path FROM tracks WHERE id = ?').get(trackId) as { path: string } | undefined;
    if (!row) return { ok: false, error: 'Track not found' };
    if (deleteFile) {
      if (!settings.library.allowFileDeletion) {
        return { ok: false, error: 'File deletion is disabled in Settings' };
      }
      try {
        await shell.trashItem(row.path); // cross-platform move-to-trash
      } catch (err: any) {
        return { ok: false, error: err?.message ?? 'Failed to trash file' };
      }
    }
    getDb().prepare('DELETE FROM tracks WHERE id = ?').run(trackId);
    return { ok: true };
  });

  // Delete an album. Removes DB rows (and cascades via tracks). Optionally trashes all track files.
  ipcMain.handle(IPC.LIBRARY_DELETE_ALBUM, async (_e, albumId: number, deleteFiles = false) => {
    const settings = getSettings();
    const tracks = getDb().prepare('SELECT id, path FROM tracks WHERE album_id = ?').all(albumId) as Array<{ id: number; path: string }>;
    if (deleteFiles) {
      if (!settings.library.allowFileDeletion) {
        return { ok: false, error: 'File deletion is disabled in Settings' };
      }
      for (const t of tracks) {
        try { await shell.trashItem(t.path); } catch { /* continue */ }
      }
    }
    const tx = getDb().transaction(() => {
      getDb().prepare('DELETE FROM tracks WHERE album_id = ?').run(albumId);
      getDb().prepare('DELETE FROM albums WHERE id = ?').run(albumId);
    });
    tx();
    // Best-effort: remove cached cover art.
    const art = getDb().prepare('SELECT cover_art_path FROM albums WHERE id = ?').get(albumId) as { cover_art_path: string | null } | undefined;
    if (art?.cover_art_path) { try { await fs.unlink(art.cover_art_path); } catch { /* ignore */ } }
    return { ok: true, deleted: tracks.length };
  });
}

