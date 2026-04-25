import type { BrowserWindow, IpcMain } from 'electron';
import { app, shell } from 'electron';
import fs from 'node:fs/promises';
import { IPC, type TrackQuery, type AlbumQuery, type TrackSort, type AlbumSort, MP3_SIZE_RATIO_VS_FLAC } from '../../shared/types';
import { getDb } from '../services/db';
import { getSettings } from '../services/settings-store';
import { migrateCoverArtToAlbumFolders } from '../services/cover-art';
import { statWithFallback } from '../services/fs-fallback';
import { isTrackLibraryDirHealthy, isLibrarySuspect } from '../services/library-health';
import { rescanAlbum } from './scan';

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
  date_added: 'date_added',
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
        SELECT t.*, ar.name AS artist, al.title AS album, al.cover_art_path AS cover_art_path,
               COALESCE(tps.play_count, 0) AS play_count
        FROM tracks t
        LEFT JOIN artists ar ON ar.id = t.artist_id
        LEFT JOIN albums al ON al.id = t.album_id
        LEFT JOIN track_plays_summary tps ON tps.track_id = t.id
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
               (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS track_count,
               (SELECT COALESCE(SUM(size), 0) FROM tracks t WHERE t.album_id = al.id) AS bytes,
               (SELECT COALESCE(SUM(duration_sec), 0) FROM tracks t WHERE t.album_id = al.id) AS duration_sec,
               (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id AND LOWER(t.path) LIKE '%.flac') AS flac_count,
               (SELECT COALESCE(SUM(size), 0) FROM tracks t WHERE t.album_id = al.id AND LOWER(t.path) LIKE '%.flac') AS flac_bytes,
               CAST(
                 (SELECT COALESCE(SUM(size), 0) FROM tracks t WHERE t.album_id = al.id AND LOWER(t.path) LIKE '%.flac')
                 * (1 - ${MP3_SIZE_RATIO_VS_FLAC})
                 AS INTEGER
               ) AS projected_mp3_savings,
               (SELECT MAX(date_added) FROM tracks t WHERE t.album_id = al.id) AS date_added
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

  ipcMain.handle(IPC.LIBRARY_ARTIST, (_e, id: number) => {
    const artist = getDb()
      .prepare(`
        SELECT ar.id, ar.name,
               (SELECT COUNT(DISTINCT al.id) FROM albums al WHERE al.artist_id = ar.id) AS album_count,
               (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = ar.id) AS track_count,
               (SELECT COALESCE(SUM(duration_sec), 0) FROM tracks t WHERE t.artist_id = ar.id) AS total_duration_sec
        FROM artists ar WHERE ar.id = ?
      `)
      .get(id) as { id: number; name: string; album_count: number; track_count: number; total_duration_sec: number } | undefined;
    if (!artist) return { artist: null, albums: [], tracks: [] };

    const albums = getDb()
      .prepare(`
        SELECT al.id, al.title, al.year, al.genre, al.cover_art_path,
               ar.name AS artist,
               (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS track_count,
               (SELECT COALESCE(SUM(size), 0) FROM tracks t WHERE t.album_id = al.id) AS bytes,
               (SELECT COALESCE(SUM(duration_sec), 0) FROM tracks t WHERE t.album_id = al.id) AS duration_sec
        FROM albums al
        LEFT JOIN artists ar ON ar.id = al.artist_id
        WHERE al.artist_id = ?
        ORDER BY al.year DESC NULLS LAST, al.title ASC
      `)
      .all(id) as Array<any>;

    const tracks = getDb()
      .prepare(`
        SELECT t.*, ar.name AS artist, al.title AS album, al.cover_art_path AS cover_art_path,
               COALESCE(tps.play_count, 0) AS play_count
        FROM tracks t
        LEFT JOIN artists ar ON ar.id = t.artist_id
        LEFT JOIN albums al ON al.id = t.album_id
        LEFT JOIN track_plays_summary tps ON tps.track_id = t.id
        WHERE t.artist_id = ?
        ORDER BY al.year DESC NULLS LAST, al.title ASC, t.disc_no, t.track_no, t.title
      `)
      .all(id);

    return { artist, albums, tracks };
  });

  ipcMain.handle(IPC.LIBRARY_ALBUM, (_e, id: number) => {
    const album = getDb()
      .prepare(`
        SELECT al.*, ar.name AS artist
        FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id
        WHERE al.id = ?
      `)
      .get(id);
    // Join the owning album so each track row carries `cover_art_path`.
    // Without this, the per-track thumbnail on the album view falls
    // through to the grey placeholder — every other tracklist view
    // (Playlist, Library, Artist, Search) already joins the album here
    // and renders real thumbs, so tracks on the album page looked
    // inconsistent by comparison.
    const tracks = getDb()
      .prepare(`
        SELECT t.*, ar.name AS artist, al.cover_art_path AS cover_art_path,
               COALESCE(tps.play_count, 0) AS play_count
        FROM tracks t
        LEFT JOIN artists ar ON ar.id = t.artist_id
        LEFT JOIN albums  al ON al.id = t.album_id
        LEFT JOIN track_plays_summary tps ON tps.track_id = t.id
        WHERE t.album_id = ?
        ORDER BY disc_no, track_no
      `)
      .all(id);
    return { album, tracks };
  });

  /**
   * Library-wide search. Tokenized: whitespace-separated terms are ANDed
   * together, each matched case-insensitively against any of title / artist /
   * album (for tracks & albums) or name (for artists). So "beatles help"
   * returns tracks where both "beatles" and "help" appear somewhere in the
   * track's title/artist/album — regardless of which field.
   *
   * Returns rich hit shapes (cover art, durations, counts, album sizes) so
   * the search view can render useful rows without extra round-trips.
   */
  ipcMain.handle(IPC.LIBRARY_SEARCH, (_e, q: string) => {
    const db = getDb();
    const tokens = String(q ?? '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return { tracks: [], albums: [], artists: [] };
    }

    // Build dynamic WHERE clauses — one AND-clause per token. Using LIKE
    // on LOWER(concat) keeps the query case-insensitive without requiring a
    // FTS index.
    const trackHaystack = `LOWER(t.title || ' ' || COALESCE(ar.name, '') || ' ' || COALESCE(al.title, ''))`;
    const albumHaystack = `LOWER(al.title || ' ' || COALESCE(ar.name, ''))`;
    const artistHaystack = `LOWER(ar.name)`;

    const tWhere = tokens.map(() => `${trackHaystack} LIKE ?`).join(' AND ');
    const alWhere = tokens.map(() => `${albumHaystack} LIKE ?`).join(' AND ');
    const arWhere = tokens.map(() => `${artistHaystack} LIKE ?`).join(' AND ');
    const params = tokens.map((t) => `%${t.toLowerCase()}%`);

    const tracks = db.prepare(`
      SELECT t.id, t.title, t.path, t.duration_sec AS durationSec,
             t.codec, t.bitrate, t.sample_rate AS sampleRate,
             ar.name AS artist, ar.id AS artistId,
             al.title AS album, al.id AS albumId, al.cover_art_path AS coverArtPath
      FROM tracks t
      LEFT JOIN artists ar ON ar.id = t.artist_id
      LEFT JOIN albums al ON al.id = t.album_id
      WHERE ${tWhere}
      ORDER BY t.title
      LIMIT 100
    `).all(...params);

    const albums = db.prepare(`
      SELECT al.id, al.title, al.year, al.genre, al.cover_art_path AS coverArtPath,
             ar.name AS artist,
             COUNT(t.id) AS trackCount,
             COALESCE(SUM(t.size), 0) AS bytes,
             COALESCE(SUM(t.duration_sec), 0) AS durationSec
      FROM albums al
      LEFT JOIN artists ar ON ar.id = al.artist_id
      LEFT JOIN tracks t ON t.album_id = al.id
      WHERE ${alWhere}
      GROUP BY al.id
      ORDER BY al.title
      LIMIT 50
    `).all(...params);

    const artists = db.prepare(`
      SELECT ar.id, ar.name,
             COUNT(DISTINCT t.id) AS trackCount,
             COUNT(DISTINCT al.id) AS albumCount
      FROM artists ar
      LEFT JOIN tracks t ON t.artist_id = ar.id
      LEFT JOIN albums al ON al.artist_id = ar.id
      WHERE ${arWhere}
      GROUP BY ar.id
      ORDER BY ar.name
      LIMIT 50
    `).all(...params);

    return { tracks, albums, artists };
  });

  /**
   * Top-N albums by total on-disk size, descending. Used by the Search view's
   * "largest albums" shortcut — gives the user a quick entry point to the
   * biggest (usually hi-res / multi-disc) albums in their library.
   */
  ipcMain.handle(IPC.LIBRARY_LARGEST_ALBUMS, (_e, limit: number = 25) => {
    const n = Math.max(1, Math.min(100, Math.floor(limit)));
    return getDb().prepare(`
      SELECT al.id, al.title, al.year, al.genre, al.cover_art_path AS coverArtPath,
             ar.name AS artist,
             COUNT(t.id) AS trackCount,
             COALESCE(SUM(t.size), 0) AS bytes,
             COALESCE(SUM(t.duration_sec), 0) AS durationSec
      FROM albums al
      LEFT JOIN artists ar ON ar.id = al.artist_id
      LEFT JOIN tracks t ON t.album_id = al.id
      GROUP BY al.id
      HAVING bytes > 0
      ORDER BY bytes DESC
      LIMIT ?
    `).all(n);
  });

  /**
   * One-shot migration: relocate every cover art file currently in the app
   * cache dir INTO the album's music folder, and update album rows to point
   * at the new location. Called either from a Settings button, or
   * automatically when the user flips coverArtStorage from 'cache' to
   * 'album-folder'. Idempotent — safe to run anytime.
   */
  ipcMain.handle(IPC.LIBRARY_MIGRATE_COVER_ART, async () => {
    return migrateCoverArtToAlbumFolders();
  });

  /**
   * Open the OS file manager focused on a path — like File Explorer's
   * "Show in folder" / Finder's "Reveal in Finder". Used by the album
   * cover click-through so users can jump from the player to the actual
   * files on disk.
   *
   * Electron's `shell.showItemInFolder` wants an ABSOLUTE path to a
   * FILE OR FOLDER. If the path happens not to exist (album metadata
   * stale, file moved), we fall back to `shell.openPath` on the parent
   * directory so the window still opens at a useful location instead
   * of failing silently.
   */
  ipcMain.handle(IPC.LIBRARY_REVEAL_IN_FOLDER, async (_e, targetPath: string) => {
    if (!targetPath) return { ok: false, error: 'No path provided' };
    try {
      const stat = await fs.stat(targetPath);
      // showItemInFolder takes a file OR folder; either works.
      shell.showItemInFolder(targetPath);
      return { ok: true, kind: stat.isDirectory() ? 'folder' : 'file' };
    } catch {
      // Path doesn't exist — open the parent so the user can see where
      // it USED to live and what's actually there now.
      const { dirname } = await import('node:path');
      const parent = dirname(targetPath);
      const err = await shell.openPath(parent);
      if (err) return { ok: false, error: err };
      return { ok: true, kind: 'parent-fallback' };
    }
  });

  ipcMain.handle(IPC.PLAYBACK_FILE_URL, (_e, p: string) => {
    // Encode the path segment-by-segment so each separator becomes a URL slash.
    // (A single encodeURIComponent would escape the slashes, leaving the URL
    // without a path hierarchy — technically fine for us, but a real-host URL
    // plays nicer with Chromium's media element origin checks.)
    const normalized = p.replace(/\\/g, '/');
    const encoded = normalized.split('/').map(encodeURIComponent).join('/');
    return `mp-media://local/${encoded}`;
  });

  // Default music directory following OS conventions (XDG 'MUSIC', macOS ~/Music,
  // Windows shell Music folder). Electron resolves these for us.
  ipcMain.handle(IPC.FIRST_RUN_DEFAULT_DIR, () => {
    try { return app.getPath('music'); } catch { return app.getPath('home'); }
  });

  // Library stats for the Home view. Single IPC, a few small aggregate queries.
  ipcMain.handle(IPC.LIBRARY_STATS, () => {
    const db = getDb();
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM tracks) AS track_count,
        (SELECT COUNT(*) FROM albums) AS album_count,
        (SELECT COUNT(*) FROM artists) AS artist_count,
        (SELECT COUNT(*) FROM playlists) AS playlist_count,
        (SELECT COUNT(*) FROM track_likes) AS liked_count,
        (SELECT COALESCE(SUM(size), 0) FROM tracks) AS total_bytes,
        (SELECT COALESCE(SUM(duration_sec), 0) FROM tracks) AS total_duration_sec,
        (SELECT COUNT(*) FROM albums WHERE cover_art_path IS NOT NULL) AS albums_with_art,
        (SELECT MIN(year) FROM tracks WHERE year IS NOT NULL AND year > 1500) AS oldest_year,
        (SELECT MAX(year) FROM tracks WHERE year IS NOT NULL) AS newest_year
    `).get() as any;

    const topGenreRow = db.prepare(`
      SELECT genre, COUNT(*) AS c
      FROM tracks
      WHERE genre IS NOT NULL AND genre <> ''
      GROUP BY genre
      ORDER BY c DESC
      LIMIT 1
    `).get() as { genre: string; c: number } | undefined;

    const biggestAlbum = db.prepare(`
      SELECT al.title AS title, ar.name AS artist, SUM(t.size) AS bytes
      FROM tracks t
      JOIN albums al ON al.id = t.album_id
      LEFT JOIN artists ar ON ar.id = al.artist_id
      GROUP BY al.id
      ORDER BY bytes DESC
      LIMIT 1
    `).get() as { title: string; artist: string | null; bytes: number } | undefined;

    const longestTrack = db.prepare(`
      SELECT t.title AS title, ar.name AS artist, t.duration_sec AS seconds
      FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id
      WHERE t.duration_sec IS NOT NULL
      ORDER BY t.duration_sec DESC
      LIMIT 1
    `).get() as { title: string; artist: string | null; seconds: number } | undefined;

    const recent = db.prepare(`
      SELECT t.id, t.title, ar.name AS artist, al.title AS album, t.date_added AS dateAdded,
             al.cover_art_path AS coverArtPath
      FROM tracks t
      LEFT JOIN artists ar ON ar.id = t.artist_id
      LEFT JOIN albums al ON al.id = t.album_id
      ORDER BY t.date_added DESC
      LIMIT 8
    `).all() as Array<{ id: number; title: string; artist: string | null; album: string | null; dateAdded: number; coverArtPath: string | null }>;

    return {
      trackCount: counts.track_count,
      albumCount: counts.album_count,
      artistCount: counts.artist_count,
      playlistCount: counts.playlist_count,
      likedCount: counts.liked_count,
      totalBytes: counts.total_bytes,
      totalDurationSec: counts.total_duration_sec,
      coverArtCoverage: counts.album_count > 0 ? counts.albums_with_art / counts.album_count : 0,
      oldestYear: counts.oldest_year ?? null,
      newestYear: counts.newest_year ?? null,
      topGenre: topGenreRow?.genre ?? null,
      topGenreCount: topGenreRow?.c ?? 0,
      biggestAlbum: biggestAlbum ?? null,
      longestTrack: longestTrack ?? null,
      mostRecentlyAdded: recent,
    };
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

  // ----------------------------------------------------------------------
  // Health probes — cheap auto-cleanup triggered by playback / album view
  // ----------------------------------------------------------------------
  //
  // `probe-track`: stat a single track's file. If the file is gone AND
  //   the track's library dir is still reachable+non-empty (per
  //   isTrackLibraryDirHealthy — which also respects the session-wide
  //   suspect flag), delete the DB row. Otherwise leave things alone:
  //   the file might just be behind an unreachable mount, or the
  //   session is in "library suspect" mode after a bad startup probe.
  //
  // `probe-album`: cheap sample-check. Pick ONE track from the album
  //   at random; stat it. If missing AND the dir is healthy, run a
  //   full album rescan (which walks the folder, reconciles DB vs
  //   disk, handles re-encodes / deletions / additions in one pass).
  //   If the sampled file exists, assume the whole album is fine —
  //   way cheaper than stat-every-track, catches the "another machine
  //   re-encoded this album" case since at least one filename will
  //   have changed.
  //
  // Cleanup is throttled so repeated album opens / play retries don't
  // hammer SMB. A track probed in the last 60s is a no-op; an album
  // probed in the last 5 minutes is a no-op.

  const recentTrackProbes = new Map<number, number>();  // trackId → last probe ms
  const recentAlbumProbes = new Map<number, number>();  // albumId → last probe ms
  const TRACK_PROBE_COOLDOWN_MS = 60 * 1000;
  const ALBUM_PROBE_COOLDOWN_MS = 5 * 60 * 1000;

  ipcMain.handle('library:probe-track', async (_e, trackId: number) => {
    if (isLibrarySuspect()) {
      return { ok: true, removed: false, reason: 'library-suspect' };
    }
    const now = Date.now();
    const last = recentTrackProbes.get(trackId) ?? 0;
    if (now - last < TRACK_PROBE_COOLDOWN_MS) {
      return { ok: true, removed: false, reason: 'recent' };
    }
    recentTrackProbes.set(trackId, now);

    const row = getDb().prepare('SELECT id, path, title FROM tracks WHERE id = ?').get(trackId) as
      { id: number; path: string; title: string } | undefined;
    if (!row) return { ok: true, removed: false, reason: 'not-in-db' };

    try {
      await statWithFallback(row.path);
      return { ok: true, removed: false, reason: 'exists' };
    } catch {
      const healthy = await isTrackLibraryDirHealthy(row.path);
      if (!healthy) {
        return { ok: true, removed: false, reason: 'library-dir-unhealthy' };
      }
      getDb().prepare('DELETE FROM tracks WHERE id = ?').run(trackId);
      process.stdout.write(`[library-health] probe-track removed missing file: ${row.path}\n`);
      return { ok: true, removed: true, path: row.path, title: row.title };
    }
  });

  ipcMain.handle('library:probe-album', async (_e, albumId: number) => {
    if (isLibrarySuspect()) {
      return { ok: true, rescanned: false, reason: 'library-suspect' };
    }
    const now = Date.now();
    const last = recentAlbumProbes.get(albumId) ?? 0;
    if (now - last < ALBUM_PROBE_COOLDOWN_MS) {
      return { ok: true, rescanned: false, reason: 'recent' };
    }
    recentAlbumProbes.set(albumId, now);

    // Pick a random track to sample — one stat, not one per track.
    // If a re-encode changed every filename this single missing file
    // will trip the rescan and the whole album gets reconciled.
    const sample = getDb()
      .prepare('SELECT path FROM tracks WHERE album_id = ? ORDER BY RANDOM() LIMIT 1')
      .get(albumId) as { path: string } | undefined;
    if (!sample) return { ok: true, rescanned: false, reason: 'no-tracks' };

    try {
      await statWithFallback(sample.path);
      return { ok: true, rescanned: false, reason: 'sample-exists', sampledPath: sample.path };
    } catch {
      const healthy = await isTrackLibraryDirHealthy(sample.path);
      if (!healthy) {
        return { ok: true, rescanned: false, reason: 'library-dir-unhealthy' };
      }
      process.stdout.write(`[library-health] probe-album sample missing → rescanning album ${albumId}\n`);
      try {
        const result = await rescanAlbum(albumId);
        return {
          ok: true,
          rescanned: true,
          added: result.added ?? 0,
          removed: result.removed ?? 0,
          updated: result.updated ?? 0,
          albumDeleted: result.albumDeleted ?? false,
        };
      } catch (err: any) {
        return { ok: false, rescanned: false, reason: 'rescan-failed', error: err?.message ?? String(err) };
      }
    }
  });
}

