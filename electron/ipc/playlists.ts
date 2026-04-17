import type { IpcMain } from 'electron';
import { IPC, LIKED_PLAYLIST_ID } from '../../shared/types';
import { getDb } from '../services/db';

export function registerPlaylistsIpc(ipcMain: IpcMain) {
  ipcMain.handle(IPC.PL_LIST, () => {
    const likedCount = (getDb().prepare('SELECT COUNT(*) AS c FROM track_likes').get() as { c: number }).c;
    const rows = getDb()
      .prepare(`
        SELECT p.id, p.name, p.description, p.kind, p.created_at, p.updated_at,
               (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count
        FROM playlists p
        ORDER BY p.updated_at DESC
      `)
      .all() as any[];
    return [
      {
        id: LIKED_PLAYLIST_ID,
        name: 'Liked Songs',
        description: 'Every track you liked, automatically.',
        kind: 'smart',
        trackCount: likedCount,
        createdAt: 0,
        updatedAt: 0,
      },
      ...rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        kind: r.kind,
        trackCount: r.track_count,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    ];
  });

  ipcMain.handle(IPC.PL_CREATE, (_e, name: string, description: string | null = null) => {
    const now = Date.now();
    const info = getDb()
      .prepare('INSERT INTO playlists (name, description, kind, created_at, updated_at) VALUES (?, ?, \'manual\', ?, ?)')
      .run(name, description, now, now);
    return info.lastInsertRowid as number;
  });

  ipcMain.handle(IPC.PL_RENAME, (_e, id: number, name: string, description: string | null) => {
    getDb()
      .prepare('UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(name, description, Date.now(), id);
    return true;
  });

  ipcMain.handle(IPC.PL_DELETE, (_e, id: number) => {
    getDb().prepare('DELETE FROM playlists WHERE id = ?').run(id);
    return true;
  });

  ipcMain.handle(IPC.PL_GET, (_e, id: number) => {
    if (id === LIKED_PLAYLIST_ID) {
      const tracks = getDb()
        .prepare(`
          SELECT t.*, ar.name AS artist, al.title AS album, al.cover_art_path AS cover_art_path, tl.liked_at AS added_at
          FROM track_likes tl
          JOIN tracks t ON t.id = tl.track_id
          LEFT JOIN artists ar ON ar.id = t.artist_id
          LEFT JOIN albums al ON al.id = t.album_id
          ORDER BY tl.liked_at DESC
        `)
        .all();
      return {
        playlist: { id: LIKED_PLAYLIST_ID, name: 'Liked Songs', description: 'Every track you liked, automatically.', kind: 'smart', trackCount: tracks.length },
        tracks,
      };
    }
    const playlist = getDb().prepare('SELECT * FROM playlists WHERE id = ?').get(id);
    const tracks = getDb()
      .prepare(`
        SELECT t.*, ar.name AS artist, al.title AS album, al.cover_art_path AS cover_art_path, pt.position AS position, pt.added_at AS added_at
        FROM playlist_tracks pt
        JOIN tracks t ON t.id = pt.track_id
        LEFT JOIN artists ar ON ar.id = t.artist_id
        LEFT JOIN albums al ON al.id = t.album_id
        WHERE pt.playlist_id = ?
        ORDER BY pt.position ASC
      `)
      .all(id);
    return { playlist, tracks };
  });

  ipcMain.handle(IPC.PL_ADD_TRACKS, (_e, id: number, trackIds: number[]) => {
    if (id === LIKED_PLAYLIST_ID) {
      // Adding to "Liked Songs" just likes them.
      const stmt = getDb().prepare('INSERT OR IGNORE INTO track_likes (track_id, liked_at) VALUES (?, ?)');
      const now = Date.now();
      const tx = getDb().transaction((ids: number[]) => {
        for (const tid of ids) stmt.run(tid, now);
      });
      tx(trackIds);
      return true;
    }
    const maxRow = getDb()
      .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM playlist_tracks WHERE playlist_id = ?')
      .get(id) as { m: number };
    let pos = maxRow.m + 1;
    const now = Date.now();
    const stmt = getDb().prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)');
    const tx = getDb().transaction((ids: number[]) => {
      for (const tid of ids) stmt.run(id, tid, pos++, now);
      getDb().prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, id);
    });
    tx(trackIds);
    return true;
  });

  ipcMain.handle(IPC.PL_REMOVE_TRACKS, (_e, id: number, trackIds: number[]) => {
    if (id === LIKED_PLAYLIST_ID) {
      const stmt = getDb().prepare('DELETE FROM track_likes WHERE track_id = ?');
      const tx = getDb().transaction((ids: number[]) => { for (const tid of ids) stmt.run(tid); });
      tx(trackIds);
      return true;
    }
    const stmt = getDb().prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?');
    const tx = getDb().transaction((ids: number[]) => {
      for (const tid of ids) stmt.run(id, tid);
      getDb().prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), id);
    });
    tx(trackIds);
    return true;
  });

  ipcMain.handle(IPC.PL_REORDER, (_e, id: number, orderedTrackIds: number[]) => {
    const stmt = getDb().prepare('UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?');
    const tx = getDb().transaction(() => {
      orderedTrackIds.forEach((tid, i) => stmt.run(i, id, tid));
      getDb().prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), id);
    });
    tx();
    return true;
  });

  ipcMain.handle(IPC.LIKE_TOGGLE, (_e, trackId: number) => {
    const existing = getDb().prepare('SELECT 1 FROM track_likes WHERE track_id = ?').get(trackId);
    if (existing) {
      getDb().prepare('DELETE FROM track_likes WHERE track_id = ?').run(trackId);
      return false;
    }
    getDb().prepare('INSERT INTO track_likes (track_id, liked_at) VALUES (?, ?)').run(trackId, Date.now());
    return true;
  });

  ipcMain.handle(IPC.LIKE_LIST, () => {
    return (getDb().prepare('SELECT track_id FROM track_likes').all() as Array<{ track_id: number }>)
      .map((r) => r.track_id);
  });
}
