import type { BrowserWindow, IpcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { IPC, type ScanProgress } from '../../shared/types';
import { getDb } from '../services/db';
import { getSettings } from '../services/settings-store';
import { fetchAlbumArt, persistAlbumArt } from '../services/metadata-providers';
import { saveAlbumArt } from '../services/cover-art';

// Set by main.ts once the window exists. Lets services outside the IPC
// registration closure (e.g. the startup resume) post scan:progress events.
let windowGetter: () => BrowserWindow | null = () => null;
export function setProgressWindow(getter: () => BrowserWindow | null) {
  windowGetter = getter;
}
function emit(payload: ScanProgress) {
  windowGetter()?.webContents.send(IPC.SCAN_PROGRESS, payload);
}

// music-metadata v10+ is ESM-only. Our main process is CommonJS. For CJS
// consumers the library exposes a `loadMusicMetadata()` factory — call it
// once, keep the resolved module, use its `parseFile`.
type ParseFile = typeof import('music-metadata').parseFile;
let _parseFile: ParseFile | null = null;
async function getParseFile(): Promise<ParseFile> {
  if (!_parseFile) {
    const mod: any = await import('music-metadata');
    // v10+: `loadMusicMetadata` is the CJS-friendly entry point.
    // Older v8/v9: `parseFile` is a direct named export.
    const load = mod.loadMusicMetadata ?? mod.default?.loadMusicMetadata;
    let fn: any;
    if (typeof load === 'function') {
      const mm = await load();
      fn = mm.parseFile;
    } else {
      fn = mod.parseFile ?? mod.default?.parseFile;
    }
    if (typeof fn !== 'function') {
      throw new Error(`music-metadata did not expose parseFile. Got keys: ${Object.keys(mod).join(', ')}`);
    }
    _parseFile = fn;
  }
  return _parseFile!;
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

async function saveEmbeddedCoverArt(
  albumId: number,
  picture: { data: Uint8Array; format?: string } | undefined,
) {
  if (!picture) return null;
  return saveAlbumArt(albumId, picture.data, picture.format ?? 'image/jpeg');
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

      // A user-initiated rescan should give previously-failed album art
      // another shot against the online providers. (Startup resume keeps the
      // flag so we don't hammer MB every launch for genuinely obscure releases.)
      if (settings.scan.fetchCoverArt && settings.scan.providers.length > 0) {
        getDb().prepare('UPDATE albums SET art_lookup_failed = 0 WHERE cover_art_path IS NULL').run();
      }

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
              await saveEmbeddedCoverArt(albumId, md.common.picture[0]);
              // We got art from the file itself — clear any prior "failed lookup" flag.
              db.prepare('UPDATE albums SET art_lookup_failed = 0 WHERE id = ?').run(albumId);
            }
          }
        } catch (err: any) {
          // Log so bad files don't fail silently. If *every* file errors here,
          // the DB will end up empty even though the UI says "done".
          console.error(`[scan] failed to process ${f}:`, err?.code ?? '', err?.message ?? err);
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
        void runArtFetch(touchedIds);
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

}

/**
 * Background album art fetcher. Runs concurrently with whatever the user is
 * doing in the UI. Emits progress via the `art` sub-state of scan:progress.
 *
 * Safe to call while another art fetch is running — de-duped via `artInProgress`.
 * `touchedIds` is a list of album IDs that got new/changed tracks this run,
 * meaning we should retry them even if a previous lookup failed. Pass `[]`
 * to pick up any album that hasn't been tried yet (used on startup resume).
 */
export async function runArtFetch(touchedIds: number[]): Promise<void> {
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
    emit({
      phase: 'fetching-art',
      filesSeen: missing.length, filesProcessed: 0,
      bytesSeen: 0, bytesProcessed: 0,
      currentFile: null, message: `Fetching cover art for ${missing.length} album(s)`,
      art: { active: true, ...artState },
    });

    const markLookup = db.prepare('UPDATE albums SET art_lookup_at = ?, art_lookup_failed = ? WHERE id = ?');
    for (const al of missing) {
      if (artCancelled) break;
      artState.currentAlbum = `${al.artist ?? '?'} — ${al.title}`;
      emit({
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
      // Per-album update so Albums/Home views can re-render with the new cover.
      if (gotArt) {
        emit({
          phase: 'fetching-art',
          filesSeen: missing.length, filesProcessed: artState.albumsDone,
          bytesSeen: 0, bytesProcessed: 0,
          currentFile: artState.currentAlbum, message: 'album-art-landed',
          art: { active: true, ...artState },
        });
      }
    }

    emit({
      phase: 'done',
      filesSeen: missing.length, filesProcessed: artState.albumsDone,
      bytesSeen: 0, bytesProcessed: 0,
      currentFile: null,
      message: `Cover art: ${artState.albumsDone} album${artState.albumsDone === 1 ? '' : 's'} processed`,
      art: null,
    });
  } catch (err: any) {
    emit({
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

/**
 * Called once on app startup. If the previous session was killed mid art-fetch,
 * any album with cover_art_path NULL and no `art_lookup_failed=1` flag is still
 * pending. Resume quietly in the background so covers keep filling in.
 */
export async function resumeArtFetchOnStartup(): Promise<void> {
  const settings = getSettings();
  if (!settings.scan.fetchCoverArt || settings.scan.providers.length === 0) return;

  const pending = (getDb()
    .prepare(`
      SELECT COUNT(*) AS c FROM albums
      WHERE cover_art_path IS NULL
        AND (art_lookup_failed IS NULL OR art_lookup_failed = 0)
    `)
    .get() as { c: number }).c;

  if (pending === 0) return;
  // Fire and forget. The background scan UI will reflect its progress.
  void runArtFetch([]);
}
