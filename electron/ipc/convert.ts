import type { BrowserWindow, IpcMain } from 'electron';
import { shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IPC, type ConvertProgress } from '../../shared/types';
import { getDb } from '../services/db';
import { getSettings } from '../services/settings-store';
import { convertToMp3, isFfmpegAvailable, mp3PathFor } from '../services/ffmpeg';

let abortController: AbortController | null = null;
let inProgress = false;

export function registerConvertIpc(ipcMain: IpcMain, getWin: () => BrowserWindow | null) {
  const emit = (p: ConvertProgress) => getWin()?.webContents.send(IPC.CONVERT_PROGRESS, p);

  ipcMain.handle(IPC.CONVERT_CHECK_AVAILABLE, async () => {
    const available = await isFfmpegAvailable();
    return { available };
  });

  ipcMain.handle(IPC.CONVERT_CANCEL, () => {
    abortController?.abort();
    return true;
  });

  ipcMain.handle(IPC.CONVERT_ALBUM_TO_MP3, async (_e, albumId: number) => {
    if (inProgress) return { ok: false, error: 'Another conversion is already running' };
    inProgress = true;
    abortController = new AbortController();

    const emitBase: Omit<ConvertProgress, 'phase' | 'message'> = {
      albumId, tracksTotal: 0, tracksDone: 0, currentFile: null, bytesBefore: 0, bytesAfter: 0,
    };

    try {
      const available = await isFfmpegAvailable();
      if (!available) {
        emit({ ...emitBase, phase: 'error', message: 'ffmpeg not available. Run `npm install` to install ffmpeg-static.' });
        return { ok: false, error: 'ffmpeg not available' };
      }

      const settings = getSettings();
      const db = getDb();

      // Pick every FLAC track in this album (case-insensitive extension).
      const rows = db.prepare(`
        SELECT t.id, t.path, t.size FROM tracks t
        WHERE t.album_id = ? AND LOWER(t.path) LIKE '%.flac'
      `).all(albumId) as Array<{ id: number; path: string; size: number }>;

      if (rows.length === 0) {
        emit({ ...emitBase, phase: 'done', message: 'No FLAC tracks found on this album.' });
        return { ok: true, tracksConverted: 0, bytesSaved: 0 };
      }

      const albumRow = db.prepare(`
        SELECT al.title, ar.name AS artist FROM albums al
        LEFT JOIN artists ar ON ar.id = al.artist_id
        WHERE al.id = ?
      `).get(albumId) as { title: string; artist: string | null } | undefined;

      const bytesBefore = rows.reduce((n, r) => n + (r.size ?? 0), 0);
      emit({
        ...emitBase,
        phase: 'starting',
        tracksTotal: rows.length,
        bytesBefore,
        message: `Converting "${albumRow?.title ?? 'album'}" (${rows.length} FLAC track${rows.length === 1 ? '' : 's'})`,
      });

      // Convert each track.
      const results: Array<{ trackId: number; flac: string; mp3: string; mp3Size: number }> = [];
      for (let i = 0; i < rows.length; i++) {
        if (abortController.signal.aborted) break;
        const r = rows[i];
        const outPath = mp3PathFor(r.path);

        // Pre-flight: refuse to overwrite an existing mp3 at the target.
        try {
          const st = await fs.stat(outPath);
          if (st.isFile()) {
            emit({
              ...emitBase, phase: 'error', tracksTotal: rows.length, tracksDone: i,
              message: `Refusing to overwrite existing ${path.basename(outPath)}`,
              currentFile: r.path, bytesBefore,
            });
            return { ok: false, error: `Target exists: ${outPath}` };
          }
        } catch { /* no existing file — proceed */ }

        emit({
          ...emitBase,
          phase: 'converting',
          tracksTotal: rows.length,
          tracksDone: i,
          currentFile: r.path,
          bytesBefore,
          message: null,
        });

        const res = await convertToMp3(r.path, outPath, settings.conversion.quality, abortController.signal);
        if (!res.ok) {
          emit({
            ...emitBase, phase: 'error', tracksTotal: rows.length, tracksDone: i,
            currentFile: r.path, bytesBefore,
            message: res.error ?? 'Conversion failed',
          });
          return { ok: false, error: res.error ?? 'Conversion failed' };
        }

        // Verify the MP3 exists and is non-trivially sized (>= 30 KB — a 1-second
        // MP3 at 256 kbps is ~32 KB; anything smaller is almost certainly corrupt).
        let mp3Size = 0;
        try {
          const st = await fs.stat(outPath);
          mp3Size = st.size;
        } catch {
          emit({
            ...emitBase, phase: 'error', tracksTotal: rows.length, tracksDone: i,
            currentFile: r.path, bytesBefore,
            message: `Output missing after conversion: ${outPath}`,
          });
          return { ok: false, error: 'Output missing' };
        }
        if (mp3Size < 30 * 1024) {
          emit({
            ...emitBase, phase: 'error', tracksTotal: rows.length, tracksDone: i,
            currentFile: r.path, bytesBefore,
            message: `Output suspiciously small (${mp3Size} bytes): ${outPath}`,
          });
          try { await fs.unlink(outPath); } catch { /* ignore */ }
          return { ok: false, error: 'Output too small' };
        }

        results.push({ trackId: r.id, flac: r.path, mp3: outPath, mp3Size });
      }

      if (abortController.signal.aborted) {
        // Nothing has been deleted yet — just report cancel.
        emit({
          ...emitBase, phase: 'error', tracksTotal: rows.length, tracksDone: results.length,
          bytesBefore, message: 'Conversion cancelled. Any .mp3 files created so far are left in place.',
        });
        return { ok: false, error: 'cancelled' };
      }

      // Verification pass: all MP3s must exist, total reasonable size vs FLAC.
      emit({ ...emitBase, phase: 'verifying', tracksTotal: rows.length, tracksDone: rows.length, bytesBefore, message: 'Verifying outputs' });
      let bytesAfter = 0;
      for (const r of results) {
        const st = await fs.stat(r.mp3);
        bytesAfter += st.size;
      }

      // Move FLAC originals to trash, then update DB rows in a single transaction.
      emit({
        ...emitBase, phase: 'removing-originals', tracksTotal: rows.length, tracksDone: rows.length,
        bytesBefore, bytesAfter, message: settings.conversion.moveOriginalsToTrash ? 'Moving FLAC originals to trash' : 'Deleting FLAC originals',
      });

      for (const r of results) {
        try {
          if (settings.conversion.moveOriginalsToTrash) await shell.trashItem(r.flac);
          else await fs.unlink(r.flac);
        } catch (err: any) {
          // If we can't remove the FLAC, don't remap the DB — the user ends up
          // with both files, which is safe. Surface the error but keep going.
          emit({
            ...emitBase, phase: 'error', tracksTotal: rows.length, tracksDone: rows.length,
            bytesBefore, bytesAfter,
            message: `Couldn't remove ${r.flac}: ${err?.message ?? err}`,
          });
          return { ok: false, error: err?.message ?? 'Remove failed' };
        }
      }

      // Update DB: point rows at the new MP3 and update size/codec/path.
      const update = db.prepare('UPDATE tracks SET path = ?, size = ?, codec = ? WHERE id = ?');
      const tx = db.transaction(() => {
        for (const r of results) update.run(r.mp3, r.mp3Size, 'MPEG 1 Layer 3', r.trackId);
      });
      tx();

      emit({
        ...emitBase, phase: 'done', tracksTotal: rows.length, tracksDone: rows.length,
        bytesBefore, bytesAfter,
        message: `Saved ${prettyBytes(bytesBefore - bytesAfter)} on "${albumRow?.title ?? 'album'}"`,
      });

      return {
        ok: true,
        tracksConverted: results.length,
        bytesBefore,
        bytesAfter,
        bytesSaved: bytesBefore - bytesAfter,
      };
    } catch (err: any) {
      emit({ ...emitBase, phase: 'error', message: err?.message ?? 'Unexpected error' });
      return { ok: false, error: err?.message ?? 'Unexpected error' };
    } finally {
      inProgress = false;
      abortController = null;
    }
  });
}

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
