// Year-tag audit + fix. Finds tracks whose `year` field looks wrong
// and either suggests or applies a corrected value by writing back
// to the actual file tags via ffmpeg.
//
// Four categories of "wrong":
//
//   1. TWO-DIGIT (year < 100, e.g. "96" or "19")
//      Tagger wrote a two-digit year and the parser stored it literally.
//      Fix: Y2K-style pivot — if ≤ 30 treat as 20xx, else 19xx.
//      This is the same convention `music-metadata` uses internally for
//      ID3v2 TYER/TDAT when the tagger emitted a short year.
//
//   2. ZERO (year = 0)
//      Tagger wrote a placeholder zero. Try to recover from the album's
//      consensus; fall back to leaving it null.
//
//   3. FUTURE (year > currentYear + 1)
//      Typo that landed in 2157 or similar. Can only recover by album
//      consensus. Without consensus, we leave it alone (could be a
//      genuine scheduled release).
//
//   4. ALBUM-OUTLIER
//      Year is valid-looking but disagrees with N other tracks on the
//      same album. Classic symptom of one track being re-tagged
//      differently (e.g. a remaster's release year mixed in with the
//      original album). Fix: use the majority year.
//
// The fix path opens each file with ffmpeg in -c copy mode (no re-
// encode) and overwrites just the date/year metadata. See
// electron/services/ffmpeg.ts::writeTags. Progress events stream to
// the renderer so the settings panel can show a bar.

import type { IpcMain, BrowserWindow } from 'electron';
import { IPC, type YearAuditResult, type YearTagFix, type YearFixProgress } from '../../shared/types';
import { getDb } from '../services/db';
import { writeTags } from '../services/ffmpeg';

/** Y2K pivot for two-digit years. Two-digit `yy` with yy ≤ PIVOT is
 *  interpreted as 20yy, else 19yy. 30 is a common choice for music
 *  catalogues and matches what music-metadata does internally. */
const TWO_DIGIT_PIVOT = 30;

function expandTwoDigit(yy: number): number {
  return yy <= TWO_DIGIT_PIVOT ? 2000 + yy : 1900 + yy;
}

interface TrackRow {
  id: number;
  path: string;
  title: string;
  artist: string | null;
  album: string | null;
  album_id: number | null;
  year: number | null;
}

function computeAudit(): YearAuditResult {
  const db = getDb();
  const currentYear = new Date().getFullYear();

  const rows = db.prepare(`
    SELECT t.id, t.path, t.title, t.album_id, t.year,
           ar.name AS artist,
           al.title AS album
    FROM tracks t
    LEFT JOIN artists ar ON ar.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
  `).all() as TrackRow[];

  // Per-album consensus year: the most common non-corrupt year across
  // the album's tracks. Used to rescue zero/future years and to
  // flag album-outliers. Populated only when the album has at least
  // 3 tracks AND the majority year covers ≥60% of them — otherwise
  // the "consensus" is too weak to fix against.
  const albumVotes = new Map<number, Map<number, number>>(); // album_id → (year → count)
  const albumSize = new Map<number, number>();
  for (const r of rows) {
    if (r.album_id === null) continue;
    albumSize.set(r.album_id, (albumSize.get(r.album_id) ?? 0) + 1);
    // Skip bad years from voting — we don't want a 2-digit value to
    // establish consensus and then "fix" the other tracks wrong.
    if (r.year === null) continue;
    if (r.year === 0) continue;
    if (r.year < 100) continue;
    if (r.year > currentYear + 1) continue;
    const m = albumVotes.get(r.album_id) ?? new Map<number, number>();
    m.set(r.year, (m.get(r.year) ?? 0) + 1);
    albumVotes.set(r.album_id, m);
  }

  const consensus = new Map<number, number>(); // album_id → year
  for (const [albumId, votes] of albumVotes) {
    const total = albumSize.get(albumId) ?? 0;
    if (total < 3) continue;
    let bestYear = 0, bestCount = 0;
    for (const [y, c] of votes) {
      if (c > bestCount) { bestCount = c; bestYear = y; }
    }
    if (bestCount / total >= 0.6) consensus.set(albumId, bestYear);
  }

  const fixes: YearTagFix[] = [];

  for (const r of rows) {
    // 1. Two-digit year — always fixable by pivot, don't need consensus.
    if (r.year !== null && r.year > 0 && r.year < 100) {
      const suggested = expandTwoDigit(r.year);
      fixes.push({
        trackId: r.id,
        path: r.path,
        title: r.title,
        artist: r.artist,
        album: r.album,
        currentYear: r.year,
        suggestedYear: suggested,
        issue: 'two-digit',
        reason: `Two-digit year ${r.year} → ${suggested} (Y2K pivot: ${r.year} ≤ ${TWO_DIGIT_PIVOT} ? 20${String(r.year).padStart(2,'0')} : 19${String(r.year).padStart(2,'0')})`,
      });
      continue;
    }

    // 2. Zero year — only fixable from album consensus. Without it,
    //    leave alone (or clear to null; we don't for safety here since
    //    fix-years isn't equipped to clear tags).
    if (r.year === 0) {
      const alby = r.album_id !== null ? consensus.get(r.album_id) : undefined;
      if (alby !== undefined) {
        fixes.push({
          trackId: r.id,
          path: r.path,
          title: r.title,
          artist: r.artist,
          album: r.album,
          currentYear: 0,
          suggestedYear: alby,
          issue: 'zero',
          reason: `Year=0; album "${r.album ?? 'Unknown'}" has consensus year ${alby}`,
        });
      }
      continue;
    }

    // 3. Future year — also only fixable from album consensus.
    if (r.year !== null && r.year > currentYear + 1) {
      const alby = r.album_id !== null ? consensus.get(r.album_id) : undefined;
      if (alby !== undefined && alby !== r.year) {
        fixes.push({
          trackId: r.id,
          path: r.path,
          title: r.title,
          artist: r.artist,
          album: r.album,
          currentYear: r.year,
          suggestedYear: alby,
          issue: 'future',
          reason: `Year ${r.year} is in the future; album consensus is ${alby}`,
        });
      }
      continue;
    }

    // 4. Album outlier — year looks valid but disagrees with the
    //    album's strong majority. Only flag if the consensus is
    //    different AND the track's current year isn't also a valid
    //    possibility (within 1 year of consensus). A ±1 tolerance
    //    covers re-releases where individual tracks carry the
    //    original year that's a year off from the album's cover
    //    year.
    if (r.year !== null && r.year >= 100 && r.year <= currentYear + 1 && r.album_id !== null) {
      const alby = consensus.get(r.album_id);
      if (alby !== undefined && Math.abs(alby - r.year) > 1) {
        fixes.push({
          trackId: r.id,
          path: r.path,
          title: r.title,
          artist: r.artist,
          album: r.album,
          currentYear: r.year,
          suggestedYear: alby,
          issue: 'album-outlier',
          reason: `Year ${r.year} disagrees with album consensus ${alby}`,
        });
      }
    }
  }

  const summary = {
    twoDigit:     fixes.filter((f) => f.issue === 'two-digit').length,
    zero:         fixes.filter((f) => f.issue === 'zero').length,
    future:       fixes.filter((f) => f.issue === 'future').length,
    albumOutlier: fixes.filter((f) => f.issue === 'album-outlier').length,
    total:        fixes.length,
  };

  return { summary, fixes };
}

/**
 * Apply a batch of year-tag fixes. Each entry is independent; failures
 * are collected and returned alongside successes. We write the tag via
 * ffmpeg's copy-mode (no re-encode) then update the DB. If the ffmpeg
 * call fails we don't touch the DB — keeps the two in sync.
 */
async function applyFixes(
  win: BrowserWindow | null,
  fixes: Array<{ trackId: number; path: string; year: number }>,
): Promise<YearFixProgress> {
  const db = getDb();
  const updateStmt = db.prepare('UPDATE tracks SET year = ? WHERE id = ?');
  const errors: YearFixProgress['errors'] = [];
  const total = fixes.length;
  let done = 0;

  const push = (payload: YearFixProgress) => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.TAGS_FIX_PROGRESS, payload);
  };
  push({ done, total, currentPath: null, errors, finished: false });

  for (const f of fixes) {
    push({ done, total, currentPath: f.path, errors, finished: false });
    try {
      // Write both `date` and `year` so every container picks the
      // right underlying tag:
      //   - FLAC / Vorbis: reads DATE
      //   - MP3 / ID3v2.4: reads TDRC (ffmpeg maps `date`)
      //   - M4A / iTunes atoms: reads ©day (ffmpeg maps `date`)
      //   - MP3 / ID3v2.3: some taggers look at TYER (ffmpeg maps `year`)
      // Writing both is harmless on every format that only recognises one.
      const yyyy = String(f.year);
      const r = await writeTags(f.path, { date: yyyy, year: yyyy });
      if (!r.ok) {
        errors.push({ trackId: f.trackId, path: f.path, error: r.error ?? 'unknown' });
        process.stdout.write(`[tag-audit] fix failed for ${f.path}: ${r.error}\n`);
      } else {
        updateStmt.run(f.year, f.trackId);
        process.stdout.write(`[tag-audit] fixed year=${f.year} on ${f.path}\n`);
      }
    } catch (err: any) {
      errors.push({ trackId: f.trackId, path: f.path, error: err?.message ?? String(err) });
    }
    done++;
    push({ done, total, currentPath: f.path, errors, finished: false });
  }

  const final: YearFixProgress = { done, total, currentPath: null, errors, finished: true };
  push(final);
  return final;
}

export function registerTagAuditIpc(ipcMain: IpcMain, getWin: () => BrowserWindow | null) {
  ipcMain.handle(IPC.TAGS_AUDIT_YEARS, (): YearAuditResult => {
    try { return computeAudit(); }
    catch (err: any) {
      process.stdout.write(`[tag-audit] audit failed: ${err?.message ?? err}\n`);
      return { summary: { twoDigit: 0, zero: 0, future: 0, albumOutlier: 0, total: 0 }, fixes: [] };
    }
  });

  ipcMain.handle(IPC.TAGS_FIX_YEARS, async (_e, fixes: Array<{ trackId: number; path: string; year: number }>) => {
    if (!Array.isArray(fixes) || fixes.length === 0) {
      return { done: 0, total: 0, currentPath: null, errors: [], finished: true };
    }
    return applyFixes(getWin(), fixes);
  });
}
