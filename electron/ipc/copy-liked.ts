/**
 * Copy-Liked-To-Folder
 * ====================
 *
 * One-shot export of every liked track's AUDIO FILE (not the playlist
 * .m3u8 — that lives in playlist-export.ts) into a folder tree shaped
 * as `<dest>/<Artist Name>/<original filename>`. Intended as a quick
 * "make me a portable copy of my favourites" button — drop a USB stick
 * in, pick it, walk away.
 *
 * Interactive prompt protocol
 * ---------------------------
 * The service reports problems back to the renderer and WAITS for a
 * decision before continuing:
 *
 *   pl:copy-liked-progress    { done, total, currentFile }
 *   pl:copy-liked-conflict    { id, srcPath, destPath, reason: 'exists' }
 *     → renderer sends pl:copy-liked-decide with
 *       { id, action: 'overwrite' | 'skip' | 'overwrite-all' | 'skip-all' | 'abort' }
 *   pl:copy-liked-error       { id, srcPath, destPath, error }
 *     → renderer sends pl:copy-liked-decide with
 *       { id, action: 'continue' | 'skip' | 'skip-all' | 'abort' }
 *   pl:copy-liked-done        { total, copied, skipped, overwritten, failed, aborted, errors[] }
 *
 * Only one copy run is allowed at a time (guarded by `running` flag).
 * Decisions are keyed by `id` (a monotonic counter) so a stale reply
 * from the renderer can't resolve the wrong prompt.
 */

import type { BrowserWindow, IpcMain } from 'electron';
import { dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getDb } from '../services/db';

type ConflictAction = 'overwrite' | 'skip' | 'overwrite-all' | 'skip-all' | 'abort';
type ErrorAction = 'continue' | 'skip' | 'skip-all' | 'abort';
type AnyAction = ConflictAction | ErrorAction;

interface PendingPrompt {
  id: number;
  resolve: (action: AnyAction) => void;
}

let running = false;
let pending: PendingPrompt | null = null;
let promptCounter = 0;

// Windows reserved filename chars + the path separators we obviously
// can't have inside a folder name. Also strip leading/trailing dots +
// spaces (Windows trims those silently, which causes stat mismatches).
function sanitizeFolderName(raw: string): string {
  const collapsed = raw
    .replace(/[\\/:*?"<>|]/g, '_')
    // Control chars
    .replace(/[\x00-\x1f]/g, '')
    .trim()
    .replace(/\.+$/, '')
    .replace(/^\.+/, '');
  // Windows reserved device names can't be folder names either. Bump
  // with a leading underscore so they still sort reasonably.
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(collapsed)) {
    return `_${collapsed}`;
  }
  return collapsed || 'Unknown Artist';
}

export function registerCopyLikedIpc(ipcMain: IpcMain, getWindow: () => BrowserWindow | null) {
  // Prompts main to open a folder picker. Kept separate from the start
  // handler so the UI can confirm the path with the user before kicking
  // off the actual copy (which is a long-running, interactive flow).
  ipcMain.handle('pl:copy-liked-pick-dest', async () => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Pick a destination for your Liked songs',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Copy Here',
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  // Renderer replies to a pending conflict/error prompt. We thread
  // these through a single pending slot because the copy loop is
  // strictly sequential (one prompt outstanding at a time).
  ipcMain.handle('pl:copy-liked-decide', (_e, payload: { id: number; action: AnyAction }) => {
    if (!pending) return false;
    if (pending.id !== payload.id) return false;    // stale reply
    const p = pending;
    pending = null;
    p.resolve(payload.action);
    return true;
  });

  ipcMain.handle('pl:copy-liked-start', async (_e, destDir: string) => {
    if (running) return { ok: false, reason: 'already-running' };
    if (!destDir || typeof destDir !== 'string') return { ok: false, reason: 'no-dest' };

    running = true;
    const win = getWindow();

    // Snapshot the liked set. We join tracks + artists to get the
    // artist NAME for the folder (foreign key resolution deferred to
    // SQL — the renderer doesn't need to know). album_artist would
    // also be reasonable; we prefer the track artist because that's
    // what most "Artist/…" folder structures on disk use. Falls back
    // to 'Unknown Artist' when we have nothing.
    const rows = getDb()
      .prepare(`
        SELECT t.id, t.path, COALESCE(ar.name, t.album_artist, 'Unknown Artist') AS artist
        FROM track_likes tl
        JOIN tracks t  ON t.id = tl.track_id
        LEFT JOIN artists ar ON ar.id = t.artist_id
        ORDER BY ar.name COLLATE NOCASE, t.path COLLATE NOCASE
      `)
      .all() as Array<{ id: number; path: string; artist: string }>;

    const total = rows.length;
    let copied = 0;
    let overwritten = 0;
    let skipped = 0;
    let failed = 0;
    let aborted = false;
    const errors: Array<{ path: string; error: string }> = [];

    // Latches — "Overwrite All" and "Skip All" persist across the
    // remaining iterations so the user isn't pestered every file once
    // they've made a blanket decision.
    let overwriteAll = false;
    let skipAllConflicts = false;
    let skipAllErrors = false;

    function ask(kind: 'conflict' | 'error', ctx: any): Promise<AnyAction> {
      return new Promise<AnyAction>((resolve) => {
        const id = ++promptCounter;
        pending = { id, resolve };
        if (!win) {
          // Shouldn't happen in practice, but if the window is gone
          // there's no one to answer — auto-abort cleanly.
          pending = null;
          resolve('abort');
          return;
        }
        win.webContents.send(kind === 'conflict' ? 'pl:copy-liked-conflict' : 'pl:copy-liked-error',
          { id, ...ctx });
      });
    }

    try {
      // Ensure the top-level dest exists (picker created it if the user
      // used "New folder" in the dialog, but defensive mkdir is cheap).
      await fs.mkdir(destDir, { recursive: true });

      for (let i = 0; i < rows.length; i++) {
        if (aborted) break;
        const r = rows[i];
        const srcPath = r.path;
        const artistFolder = sanitizeFolderName(r.artist || 'Unknown Artist');
        const destFolder = path.join(destDir, artistFolder);
        const destPath = path.join(destFolder, path.basename(srcPath));

        win?.webContents.send('pl:copy-liked-progress', {
          done: i,
          total,
          currentFile: srcPath,
        });

        // Per-track work inside a retry loop so "Continue" (on error) +
        // "Overwrite"/"Skip" (on conflict) can all hand control back
        // here without bailing the whole run.
        let handled = false;
        while (!handled && !aborted) {
          try {
            // Make sure the artist folder exists. Do this INSIDE the
            // retry loop so a transient mkdir failure (network share
            // dropped, etc.) can be continued past.
            await fs.mkdir(destFolder, { recursive: true });

            // Conflict detection: stat the dest first. If it exists,
            // either honour an existing blanket decision or ask.
            let exists = false;
            try {
              await fs.stat(destPath);
              exists = true;
            } catch { /* ENOENT → exists stays false */ }

            if (exists) {
              let action: AnyAction;
              if (overwriteAll) action = 'overwrite';
              else if (skipAllConflicts) action = 'skip';
              else {
                action = await ask('conflict', {
                  srcPath,
                  destPath,
                  artist: r.artist,
                });
              }
              if (action === 'abort') { aborted = true; break; }
              if (action === 'overwrite-all') { overwriteAll = true; action = 'overwrite'; }
              if (action === 'skip-all') { skipAllConflicts = true; action = 'skip'; }
              if (action === 'skip') {
                skipped++;
                handled = true;
                break;
              }
              // 'overwrite' → fall through to copyFile, which replaces.
            }

            await fs.copyFile(srcPath, destPath);
            if (exists) overwritten++; else copied++;
            handled = true;
          } catch (err: any) {
            const msg = err?.message ?? String(err);
            let action: AnyAction;
            if (skipAllErrors) action = 'skip';
            else {
              action = await ask('error', {
                srcPath,
                destPath,
                error: msg,
                artist: r.artist,
              });
            }
            if (action === 'abort') { aborted = true; break; }
            if (action === 'skip-all') { skipAllErrors = true; action = 'skip'; }
            if (action === 'continue') {
              // "Continue" = try this file again. If it fails again,
              // the user gets asked again. Avoids silently giving up
              // on a transient blip while still allowing them to
              // escape by picking Skip or Skip All.
              continue;
            }
            // 'skip' → record and move on.
            failed++;
            errors.push({ path: srcPath, error: msg });
            handled = true;
          }
        }
      }

      // Final progress tick so the UI can show 100%.
      win?.webContents.send('pl:copy-liked-progress', {
        done: total,
        total,
        currentFile: null,
      });

      win?.webContents.send('pl:copy-liked-done', {
        total,
        copied,
        overwritten,
        skipped,
        failed,
        aborted,
        errors,
      });

      return { ok: true };
    } finally {
      running = false;
      pending = null;
    }
  });

  // Explicit abort channel — useful if the UI closes while a prompt is
  // outstanding. Resolves the pending promise (if any) with 'abort'.
  ipcMain.handle('pl:copy-liked-abort', () => {
    if (pending) {
      const p = pending;
      pending = null;
      p.resolve('abort');
    }
    return true;
  });
}
