import type { BrowserWindow, IpcMain } from 'electron';
import { shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IPC, type ConvertProgress } from '../../shared/types';
import { getDb } from '../services/db';
import { getSettings } from '../services/settings-store';
import { convertToMp3, isFfmpegAvailable, mp3PathFor } from '../services/ffmpeg';
import { resolveExistingPath } from '../services/fs-fallback';

let abortController: AbortController | null = null;
let inProgress = false;

export function registerConvertIpc(ipcMain: IpcMain, getWin: () => BrowserWindow | null) {
  const emit = (p: ConvertProgress) => {
    // Mirror every progress event to stdout so debugging a failed convert
    // doesn't require fishing it out of the renderer console. Phase + any
    // message + the currently-targeted file is usually enough to tell what
    // step broke; on 'error' phase we dump the full message inline.
    const bits = [`phase=${p.phase}`, `done=${p.tracksDone}/${p.tracksTotal}`];
    if (p.currentFile) bits.push(`file=${p.currentFile}`);
    if (p.message) bits.push(`msg=${p.message}`);
    process.stdout.write(`[convert] ${bits.join(' | ')}\n`);
    getWin()?.webContents.send(IPC.CONVERT_PROGRESS, p);
  };

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

      // Per-track "commit as you go" flow. Each FLAC is independently:
      //   convert → verify (exists + ≥30 KB) → delete FLAC → update DB
      // A failure at ANY step leaves the FLAC untouched and (if created)
      // unlinks the bad MP3. Prior successful tracks stay committed.
      //
      // This is the user's safety guarantee: if verification fails (zero-
      // byte output, small output, missing output), the original FLAC is
      // NEVER removed, and the garbage MP3 is cleaned up so a retry starts
      // fresh. Previously we batched verify+trash at the end, which had
      // two failure modes users hit:
      //   1. shell.trashItem on SMB shares silently hard-deletes, so a
      //      successful trash-then-DB-crash loses originals outright.
      //   2. An orphaned half-converted MP3 from a crashed run blocked
      //      the next run's pre-flight with "refusing to overwrite".
      //
      // The per-track version sidesteps both: FLACs only leave after
      // their MP3 verifies, and we don't care what garbage a previous
      // crashed run left behind — ffmpeg's `-y` flag overwrites it.
      const MIN_MP3_BYTES = 30 * 1024; // ~1 sec at 256 kbps; smaller = corrupt
      const MP3_CODEC = 'MPEG 1 Layer 3';

      const update = db.prepare('UPDATE tracks SET path = ?, size = ?, codec = ? WHERE id = ?');

      let tracksConverted = 0;
      let tracksSkipped = 0;
      let bytesAfter = 0;
      const skipReasons: string[] = [];

      for (let i = 0; i < rows.length; i++) {
        if (abortController.signal.aborted) break;
        const r = rows[i];

        // Resolve the FLAC path via fs-fallback so trailing-dot / case-drift
        // filenames on SMB shares still open. ffmpeg itself doesn't do this
        // resolution, so without it ffmpeg would fail on the same files the
        // playback path used to fail on.
        const resolvedFlac = await resolveExistingPath(r.path);
        const outPath = mp3PathFor(resolvedFlac);
        const baseName = path.basename(resolvedFlac);

        emit({
          ...emitBase,
          phase: 'converting',
          tracksTotal: rows.length,
          tracksDone: i,
          currentFile: r.path,
          bytesBefore,
          message: null,
        });

        // --- 1. Convert -----------------------------------------------------
        const res = await convertToMp3(resolvedFlac, outPath, settings.conversion.quality, abortController.signal);
        if (!res.ok) {
          // ffmpeg itself failed. If it left a partial file behind, clean it
          // up — no point keeping a half-written mp3 around. Leave the FLAC
          // alone. Continue to the next track.
          try { await fs.unlink(outPath); } catch { /* might not exist */ }
          process.stdout.write(`[convert] ffmpeg failed on ${baseName}: ${res.error} — FLAC preserved, skipping\n`);
          tracksSkipped++;
          skipReasons.push(`${baseName}: ffmpeg failed (${(res.error ?? '').slice(0, 120)})`);
          continue;
        }

        // --- 2. Verify output ----------------------------------------------
        let mp3Size = 0;
        try {
          const st = await fs.stat(outPath);
          mp3Size = st.size;
        } catch {
          process.stdout.write(`[convert] output missing after ffmpeg on ${baseName} — FLAC preserved, skipping\n`);
          tracksSkipped++;
          skipReasons.push(`${baseName}: output file missing`);
          continue;
        }
        if (mp3Size < MIN_MP3_BYTES) {
          // Output is zero-byte or suspiciously small. Delete it (it's
          // garbage, not something the user placed). Keep the FLAC.
          try { await fs.unlink(outPath); } catch { /* best effort */ }
          process.stdout.write(`[convert] output too small (${mp3Size} bytes) on ${baseName} — removed bad mp3, FLAC preserved, skipping\n`);
          tracksSkipped++;
          skipReasons.push(`${baseName}: output was ${mp3Size} bytes (expected ≥${MIN_MP3_BYTES})`);
          continue;
        }

        // --- 3. Remove the FLAC --------------------------------------------
        // Honors the moveOriginalsToTrash setting. trashItem goes to OS
        // Recycle Bin on local volumes; on SMB it may hard-delete (the
        // user is aware and accepts this — per-track verification above
        // ensures we never remove a FLAC without a good MP3 in place).
        try {
          if (settings.conversion.moveOriginalsToTrash) await shell.trashItem(resolvedFlac);
          else await fs.unlink(resolvedFlac);
        } catch (err: any) {
          // Couldn't remove the FLAC. The MP3 is valid but we now have
          // both formats. Don't update the DB (keep it pointing at the
          // FLAC, which still works). Continue — user ends up with an
          // extra mp3 in the folder but no data loss.
          process.stdout.write(`[convert] couldn't remove ${baseName} after convert: ${err?.message ?? err} — DB left on FLAC, skipping\n`);
          tracksSkipped++;
          skipReasons.push(`${baseName}: couldn't remove original (${err?.message ?? err})`);
          continue;
        }

        // --- 4. Commit the DB update ---------------------------------------
        update.run(outPath, mp3Size, MP3_CODEC, r.id);
        tracksConverted++;
        bytesAfter += mp3Size;

        process.stdout.write(`[convert] ok ${baseName} → ${path.basename(outPath)} (${prettyBytes(mp3Size)})\n`);
      }

      if (abortController.signal.aborted) {
        emit({
          ...emitBase, phase: 'error', tracksTotal: rows.length, tracksDone: tracksConverted,
          bytesBefore, bytesAfter,
          message: `Cancelled. ${tracksConverted} track${tracksConverted === 1 ? '' : 's'} committed, the rest left untouched.`,
        });
        return { ok: false, error: 'cancelled', tracksConverted, tracksSkipped };
      }

      // Final summary. "ok" is true as long as we DID convert at least one
      // track cleanly. A run with some skips but some successes is still a
      // win — we just tell the user what skipped so they can investigate.
      const allSucceeded = tracksSkipped === 0 && tracksConverted === rows.length;
      const msgParts: string[] = [];
      if (tracksConverted > 0) msgParts.push(`Saved ${prettyBytes(Math.max(0, bytesBefore - bytesAfter))} across ${tracksConverted} track${tracksConverted === 1 ? '' : 's'}`);
      if (tracksSkipped > 0) msgParts.push(`${tracksSkipped} skipped (check log)`);
      const summaryMsg = msgParts.join(' · ') || 'Nothing to do.';

      emit({
        ...emitBase,
        phase: allSucceeded ? 'done' : (tracksConverted > 0 ? 'done' : 'error'),
        tracksTotal: rows.length, tracksDone: tracksConverted,
        bytesBefore, bytesAfter,
        message: summaryMsg,
      });

      if (skipReasons.length > 0) {
        process.stdout.write(`[convert] skipped tracks:\n${skipReasons.map((s) => `  - ${s}`).join('\n')}\n`);
      }

      return {
        ok: tracksConverted > 0,
        tracksConverted,
        tracksSkipped,
        bytesBefore,
        bytesAfter,
        bytesSaved: Math.max(0, bytesBefore - bytesAfter),
      };
    } catch (err: any) {
      // No rollback needed — the per-track loop commits as it goes, so a
      // thrown exception here just stops further conversions. Tracks
      // already committed stay committed; the current in-flight MP3 (if
      // any) will be orphaned but that's a known, recoverable state (next
      // run will overwrite it via ffmpeg's -y flag).
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
