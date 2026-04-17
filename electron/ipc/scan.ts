import type { BrowserWindow, IpcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { IPC, type ScanProgress } from '../../shared/types';
import { getDb } from '../services/db';
import { getSettings } from '../services/settings-store';
import { fetchAlbumArt, persistAlbumArt } from '../services/metadata-providers';

// music-metadata v10+ is ESM-only. Our main process is CommonJS, so we can't
// statically `import` it — Node would throw ERR_REQUIRE_ESM. Lazily load via
// dynamic import(), which CJS can do without issue.
type ParseFile = typeof import('music-metadata').parseFile;
let _parseFile: ParseFile | null = null;
async function getParseFile(): Promise<ParseFile> {
  if (!_parseFile) {
    const mod = await import('music-metadata');
    _parseFile = mod.parseFile;
  }
  return _parseFile;
}

let cancelled = false;
let inProgress = false;
// Art fetch can continue running in the background after the main tag scan
// finishes. We track its state separately so the UI can render both.
let artCancelled = false;
let artInProgress = false;
let artState: {
  albumsTotal: number;
  albumsDone: number;
  currentAlbum: string | null;
} = { albumsTotal: 0, albumsDone: 0, currentAlbum: null };

function currentArtState() {
  return artInProgress
    ? { active: true, ...artState }
    : null;
}

async function walk(
  dir: string,
  exts: Set<string>,
  files: string[],
  onTick: (currentDir: string) => void,
): Promise<void> {
  if (cancelled) return;
  onTick(dir);
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (cancelled) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, exts, files, onTick);
    } else if (e.isFile() && exts.has(path.extname(e.name).toLowerCase())) {
      files.push(full);
    }
  }
}

function upsertArtist(name: string | undefined | null): number | null {
  if (!name) return null;
  const db = getDb();
  const existing = db.prepare('SELECT id FROM artists WHERE name = ?').get(name) as { id: number } | undefined;
  if (existing) return existing.id;
  const info = db.prepare('INSERT INTO artists (name) VALUES (?)').run(name);
  return info.lastInsertRowid as number;
}

function upsertAlbum(title: string | undefined | null, artistId: number | null, year: number | null, genre: string | null): number | null {
  if (!title) return null;
  const db = getDb();
  const existing = db
    .prepare('SELECT id, genre FROM albums WHERE title = ? AND IFNULL(artist_id, 0) = IFNULL(?, 0)')
    .get(title, artistId) as { id: number; genre: string | null } | undefined;
  if (existing) {
    // Fill in genre if not yet set.
    if (!existing.genre && genre) {
      db.prepare('UPDATE albums SET genre = ? WHERE id = ?').run(genre, existing.id);
    }
    return existing.id;
  }
  const info = db
    .prepare('INSERT INTO albums (title, artist_id, year, genre) VALUES (?, ?, ?, ?)')
    .run(title, artistId, year, genre);
  return info.lastInsertRowid as number;
}

async function saveCoverArt(albumId: number, picture: { data: Uint8Array; format?: string } | undefined) {
  if (!picture) return null;
  const settings = getSettings();
  const ext = (picture.format ?? 'image/jpeg').split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'jpg';
  const file = path.join(settings.library.coverArtCachePath, `album_${albumId}.${ext}`);
  await fs.writeFile(file, Buffer.from(picture.data));
  getDb().prepare('UPDATE albums SET cover_art_path = ? WHERE id = ?').run(file, albumId);
  return file;
}

export function registerScanIpc(ipcMain: IpcMain, getWin: () => BrowserWindow | null) {
  // Helper: build a full ScanProgress payload with current art-state baked in.
  const send = (
    partial: Omit<ScanProgress, 'art'> & Partial<Pick<ScanProgress, 'art'>>
  ) => {
    const payload: ScanProgress = {
      art: partial.art ?? currentArtState(),
      ...partial,
    } as ScanProgress;
    getWin()?.webContents.send(IPC.SCAN_PROGRESS, payload);
  };

  ipcMain.handle(IPC.SCAN_CANCEL, () => {
    cancelled = true;
    artCancelled = true;
    return true;
  });

  ipcMain.handle(IPC.SCAN_START, async () => {
    if (inProgress) return false;
    inProgress = true;
    cancelled = false;

    try {
      const settings = getSettings();
      const exts = new Set(settings.scan.extensions.map((e) => e.toLowerCase()));
      const dirs = getDb().prepare('SELECT id, path FROM directories WHERE enabled = 1').all() as Array<{ id: number; path: string }>;

      send({ phase: 'enumerating', filesSeen: 0, filesProcessed: 0, bytesSeen: 0, bytesProcessed: 0, currentFile: null, message: 'Scanning folders…' });

      // Emit an enumeration-progress heartbeat at ~4Hz with the current dir.
      const files: string[] = [];
      let lastTick = 0;
      const onTick = (currentDir: string) => {
        const now = Date.now();
        if (now - lastTick < 250) return;
        lastTick = now;
        send({
          phase: 'enumerating',
          filesSeen: files.length,
          filesProcessed: 0,
          bytesSeen: 0,
          bytesProcessed: 0,
          currentFile: currentDir,
          message: `${files.length.toLocaleString()} files found so far`,
        });
      };

      for (const d of dirs) {
        if (cancelled) break;   // outer loop cancel
        await walk(d.path, exts, files, onTick);
      }

      if (cancelled) {
        send({ phase: 'error', filesSeen: files.length, filesProcessed: 0, bytesSeen: 0, bytesProcessed: 0, currentFile: null, message: 'Scan cancelled' });
        return false;
      }

      // Stat all files for total byte count. Also emit heartbeats so the UI
      // doesn't look frozen on very large collections.
      send({ phase: 'enumerating', filesSeen: files.length, filesProcessed: 0, bytesSeen: 0, bytesProcessed: 0, currentFile: null, message: `Measuring ${files.length.toLocaleString()} files…` });
      let bytesSeen = 0;
      let stattedCount = 0;
      let lastStatTick = 0;
      for (const f of files) {
        if (cancelled) break;
        try { bytesSeen += (await fs.stat(f)).size; } catch { /* ignore */ }
        stattedCount++;
        const now = Date.now();
        if (now - lastStatTick >= 250) {
          lastStatTick = now;
          send({
            phase: 'enumerating',
            filesSeen: files.length,
            filesProcessed: stattedCount,
            bytesSeen,
            bytesProcessed: 0,
            currentFile: f,
            message: `Measuring files (${stattedCount.toLocaleString()} / ${files.length.toLocaleString()})`,
          });
        }
      }

      if (cancelled) {
        send({ phase: 'error', filesSeen: files.length, filesProcessed: 0, bytesSeen, bytesProcessed: 0, currentFile: null, message: 'Scan cancelled' });
        return false;
      }

      send({ phase: 'reading-tags', filesSeen: files.length, filesProcessed: 0, bytesSeen, bytesProcessed: 0, currentFile: null, message: `${files.length.toLocaleString()} files · ${(bytesSeen / (1024 ** 3)).toFixed(2)} GB` });

      const db = getDb();
      const insert = db.prepare(`
        INSERT INTO tracks (path, title, artist_id, album_id, album_artist, track_no, disc_no,
                            year, genre, duration_sec, bitrate, sample_rate, codec, mtime, size, date_added)
        VALUES (@path, @title, @artist_id, @album_id, @album_artist, @track_no, @disc_no,
                @year, @genre, @duration_sec, @bitrate, @sample_rate, @codec, @mtime, @size, @date_added)
        ON CONFLICT(path) DO UPDATE SET
          title = excluded.title,
          artist_id = excluded.artist_id,
          album_id = excluded.album_id,
          album_artist = excluded.album_artist,
          track_no = excluded.track_no,
          disc_no = excluded.disc_no,
          year = excluded.year,
          genre = excluded.genre,
          duration_sec = excluded.duration_sec,
          bitrate = excluded.bitrate,
          sample_rate = excluded.sample_rate,
          codec = excluded.codec,
          mtime = excluded.mtime,
          size = excluded.size
      `);

      let processed = 0;
      let bytesProcessed = 0;
      // Track which albums got new/changed tracks this run. Only those need
      // their cover art re-evaluated against online providers.
      const albumsTouchedThisRun = new Set<number>();
      for (const f of files) {
        if (cancelled) break;
        try {
          const stat = await fs.stat(f);
          const mtime = Math.floor(stat.mtimeMs);
          const size = stat.size;
          if (settings.scan.incremental) {
            const existing = db
              .prepare('SELECT mtime, size FROM tracks WHERE path = ?')
              .get(f) as { mtime: number; size: number } | undefined;
            // Skip only when BOTH mtime and size match. Either changing means
            // the file was rewritten (retag, re-encode) and we should reparse.
            if (existing && existing.mtime === mtime && existing.size === size) {
              processed++;
              bytesProcessed += size;
              continue;
            }
          }
          const parseFile = await getParseFile();
          const md = await parseFile(f, { duration: true, skipCovers: false });
          const artistId = upsertArtist(md.common.artist ?? null);
          const genreTag = (md.common.genre ?? [])[0] ?? null;
          const albumId = upsertAlbum(md.common.album ?? null, artistId, md.common.year ?? null, genreTag);
          insert.run({
            path: f,
            title: md.common.title ?? path.basename(f),
            artist_id: artistId,
            album_id: albumId,
            album_artist: md.common.albumartist ?? null,
            track_no: md.common.track?.no ?? null,
            disc_no: md.common.disk?.no ?? null,
            year: md.common.year ?? null,
            genre: (md.common.genre ?? [])[0] ?? null,
            duration_sec: md.format.duration ?? null,
            bitrate: md.format.bitrate ?? null,
            sample_rate: md.format.sampleRate ?? null,
            codec: md.format.codec ?? null,
            mtime: Math.floor(stat.mtimeMs),
            size: stat.size,
            date_added: Date.now(),
          });

          if (albumId) albumsTouchedThisRun.add(albumId);

          // Save embedded cover art if we don't have one for this album yet.
          if (albumId && settings.scan.fetchCoverArt) {
            const row = db.prepare('SELECT cover_art_path FROM albums WHERE id = ?').get(albumId) as { cover_art_path: string | null } | undefined;
            if (!row?.cover_art_path && md.common.picture && md.common.picture[0]) {
              await saveCoverArt(albumId, md.common.picture[0]);
              // We got art from the file itself — clear any prior "failed lookup" flag.
              db.prepare('UPDATE albums SET art_lookup_failed = 0 WHERE id = ?').run(albumId);
            }
          }
        } catch (err) {
          // continue
        }
        processed++;
        // Bump bytesProcessed with this file's size (stat is fresh above).
        try { bytesProcessed += (await fs.stat(f)).size; } catch { /* ignore */ }
        if (processed % 20 === 0 || processed === files.length) {
          send({ phase: 'reading-tags', filesSeen: files.length, filesProcessed: processed, bytesSeen, bytesProcessed, currentFile: f, message: null });
        }
      }

      for (const d of dirs) {
        db.prepare('UPDATE directories SET last_scanned_at = ? WHERE id = ?').run(Date.now(), d.id);
      }

      // Kick off the online art-fetching in the background. We return `done`
      // to the UI immediately so the library is usable; the art worker keeps
      // posting progress via the `art` sub-state and completion events.
      const touchedIds = [...albumsTouchedThisRun];
      if (settings.scan.fetchCoverArt && settings.scan.providers.length > 0 && !cancelled) {
        // Fire and forget. `runArtFetch` handles its own error reporting.
        void runArtFetch(touchedIds, send);
      }

      send({
        phase: 'done',
        filesSeen: files.length,
        filesProcessed: processed,
        bytesSeen,
        bytesProcessed,
        currentFile: null,
        message: artInProgress ? 'Tag scan complete — fetching cover art in background' : 'Scan complete',
      });
      return true;
    } catch (err: any) {
      send({ phase: 'error', filesSeen: 0, filesProcessed: 0, bytesSeen: 0, bytesProcessed: 0, currentFile: null, message: err?.message ?? 'Scan failed' });
      return false;
    } finally {
      inProgress = false;
    }
  });

  /**
   * Background album art fetcher. Runs concurrently with whatever the user is
   * doing in the UI. Emits progress via the `art` sub-state of scan:progress.
   *
   * Safe to call while another art fetch is running — we de-dupe via `artInProgress`.
   */
  async function runArtFetch(touchedIds: number[], sendFn: typeof send) {
    if (artInProgress) return;
    artInProgress = true;
    artCancelled = false;
    const db = getDb();
    const settings = getSettings();

    try {
      const touchedPlaceholders = touchedIds.length ? touchedIds.map(() => '?').join(',') : 'NULL';
      const sql = `
        SELECT al.id, al.title, ar.name AS artist
        FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id
        WHERE al.cover_art_path IS NULL
          AND (
            al.art_lookup_failed = 0
            OR al.art_lookup_failed IS NULL
            OR al.id IN (${touchedPlaceholders})
          )
      `;
      const missing = (touchedIds.length
        ? db.prepare(sql).all(...touchedIds)
        : db.prepare(sql).all()) as Array<{ id: number; title: string; artist: string | null }>;

      if (missing.length === 0) {
        artInProgress = false;
        return;
      }

      artState = { albumsTotal: missing.length, albumsDone: 0, currentAlbum: null };
      // Push an initial art-state update without touching the tag-scan fields.
      sendFn({
        phase: 'done',
        filesSeen: 0, filesProcessed: 0, bytesSeen: 0, bytesProcessed: 0,
        currentFile: null, message: null,
        art: { active: true, ...artState },
      });

      const markLookup = db.prepare('UPDATE albums SET art_lookup_at = ?, art_lookup_failed = ? WHERE id = ?');
      for (const al of missing) {
        if (artCancelled) break;
        artState.currentAlbum = `${al.artist ?? '?'} — ${al.title}`;
        sendFn({
          phase: 'fetching-art',
          filesSeen: missing.length, filesProcessed: artState.albumsDone,
          bytesSeen: 0, bytesProcessed: 0,
          currentFile: artState.currentAlbum, message: null,
          art: { active: true, ...artState },
        });

        let gotArt = false;
        try {
          const art = await fetchAlbumArt(al.artist, al.title, settings.scan.providers);
          if (art) {
            await persistAlbumArt(al.id, art);
            gotArt = true;
          }
        } catch {
          /* continue */
        }
        markLookup.run(Date.now(), gotArt ? 0 : 1, al.id);
        artState.albumsDone++;
      }

      // Final art-done signal.
      sendFn({
        phase: 'done',
        filesSeen: missing.length, filesProcessed: artState.albumsDone,
        bytesSeen: 0, bytesProcessed: 0,
        currentFile: null,
        message: `Cover art: ${artState.albumsDone} album${artState.albumsDone === 1 ? '' : 's'} processed`,
        art: null,
      });
    } catch (err: any) {
      sendFn({
        phase: 'error',
        filesSeen: 0, filesProcessed: 0, bytesSeen: 0, bytesProcessed: 0,
        currentFile: null, message: `Art fetch failed: ${err?.message ?? err}`,
        art: null,
      });
    } finally {
      artInProgress = false;
      artState = { albumsTotal: 0, albumsDone: 0, currentAlbum: null };
    }
  }
}
