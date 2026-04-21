// Local-only recommendation engine. No ML, no external APIs, no
// collaborative-filtering matrix magic — just statistical scoring
// over the user's own listening history and library metadata.
//
// Inputs (all from SQLite):
//   - track_plays_summary.play_count       (how often)
//   - track_plays_summary.last_played_at   (how recently)
//   - track_likes                           (explicit positive signal)
//   - tracks.artist_id / album_id / genre / year  (the attributes we
//     score similarity against)
//
// Four partial scores per candidate track, each normalised to 0..1:
//   artistMatch  — weight(this.artist_id) / max(weight(any artist))
//   genreMatch   — weight(this.genre)     / max(weight(any genre))
//   albumMatch   — weight(this.album_id)  / max(weight(any album))
//   yearMatch    — sum over liked years of exp(-|dy|/5), normalised
//
// Final score = 0.40·artist + 0.25·genre + 0.15·album + 0.10·year
//
// Then two post-multipliers that push truly-discoverable picks up:
//   - Recency penalty (played in last 14 days → scaled down).
//   - Over-familiarity penalty (liked AND played >10 times → halved).
//
// The reason chip is the single biggest contributor to the score —
// whichever of artistMatch/genreMatch/albumMatch/yearMatch×its weight
// wins. Gives the user a plain-English "why is this here?" label so
// the list doesn't feel like a black box.

import type { IpcMain } from 'electron';
import { IPC, type SuggestionEntry } from '../../shared/types';
import { getDb } from '../services/db';

// Exponential recency half-life. 180 days means a play from 6 months
// ago counts half as much as one from today. Long enough that seasonal
// listeners aren't forgotten, short enough that taste drift is honoured.
const HALF_LIFE_DAYS = 180;

// Year-proximity scale: a 1978 track gets ~80% of a 1980-lover's year
// weight; a 1968 track gets ~14%. 5-year sigma feels right for music
// (decades cluster sonically).
const YEAR_SIGMA = 5;

// Component weights. Sum intentionally ≤ 1 so scores stay in a
// recognisable 0..1 neighbourhood — makes debug logs readable.
const W_ARTIST = 0.40;
const W_GENRE  = 0.25;
const W_ALBUM  = 0.15;
const W_YEAR   = 0.10;

// How much a like amplifies a single track's contribution to the
// taste profile. A liked-but-never-played track still registers; a
// played-and-liked track dominates over a played-once-not-liked one.
const LIKE_BOOST = 5;

// Recency penalty: tracks played in the last N days get their final
// score scaled by `(age / N) ^ 0.5`, so a just-played track ≈ 0, a
// 2-week-old play ≈ 1.
const RECENCY_PENALTY_WINDOW_DAYS = 14;

// Over-familiar threshold: liked + played this much → user already
// knows the track; we want discovery, not nostalgia.
const FAMILIAR_PLAY_THRESHOLD = 10;
const FAMILIAR_SCALE = 0.3;

// Minimum final score to include in results — filters out essentially-
// random floor noise when the user's history is thin.
const MIN_SCORE = 0.01;

interface HistoryRow {
  id: number;
  artist_id: number | null;
  album_id: number | null;
  genre: string | null;
  year: number | null;
  plays: number;
  last: number | null;     // epoch ms from track_plays_summary
  liked: 0 | 1;
}

/**
 * Main handler. Pulls every track in the library with its aggregated
 * play + like signals, computes the taste profile, scores each
 * candidate, and returns the top-N enriched with artist/album/cover
 * for direct consumption by the renderer's view layer.
 */
function computeSuggestions(limit: number = 100): SuggestionEntry[] {
  const db = getDb();
  const now = Date.now();

  // Pull the history + attributes for every track in one shot. The
  // LEFT JOINs preserve tracks that have never been played or liked —
  // they count as candidates (score likely 0, filtered below) and
  // also contribute nothing to the taste profile.
  const rows = db.prepare(`
    SELECT t.id,
           t.artist_id,
           t.album_id,
           t.genre,
           t.year,
           COALESCE(s.play_count, 0) AS plays,
           s.last_played_at          AS last,
           CASE WHEN l.track_id IS NOT NULL THEN 1 ELSE 0 END AS liked
    FROM tracks t
    LEFT JOIN track_plays_summary s ON s.track_id = t.id
    LEFT JOIN track_likes l          ON l.track_id = t.id
  `).all() as HistoryRow[];

  if (rows.length === 0) return [];

  // --- Phase 1: build the taste profile ------------------------------------
  // For every track the user has actually touched (played OR liked),
  // contribute a weight to its artist, genre, album, year buckets.
  const decay = (lastMs: number | null): number => {
    if (!lastMs) return 0.5; // liked-but-never-played gets a neutral 0.5
    const days = (now - lastMs) / 86_400_000;
    if (days < 0) return 1;
    return Math.exp(-days / HALF_LIFE_DAYS);
  };

  const artistW = new Map<number, number>();
  const genreW  = new Map<string, number>();
  const albumW  = new Map<number, number>();
  const yearW   = new Map<number, number>();

  for (const r of rows) {
    // Skip tracks the user has never interacted with — they provide
    // zero signal to the profile.
    if (r.plays === 0 && !r.liked) continue;
    const w = (r.plays + (r.liked ? LIKE_BOOST : 0)) * decay(r.last);
    if (w <= 0) continue;
    if (r.artist_id !== null) artistW.set(r.artist_id, (artistW.get(r.artist_id) ?? 0) + w);
    if (r.genre)              genreW.set(r.genre,      (genreW.get(r.genre) ?? 0) + w);
    if (r.album_id !== null)  albumW.set(r.album_id,   (albumW.get(r.album_id) ?? 0) + w);
    if (r.year !== null)      yearW.set(r.year,        (yearW.get(r.year) ?? 0) + w);
  }

  // If the user has zero history, there's nothing to score from. Bail
  // with an empty list rather than returning a random slice.
  if (artistW.size === 0 && genreW.size === 0 && albumW.size === 0 && yearW.size === 0) {
    return [];
  }

  // --- Phase 2: normaliser helpers -----------------------------------------
  const maxArtistW = Math.max(0, ...artistW.values());
  const maxGenreW  = Math.max(0, ...genreW.values());
  const maxAlbumW  = Math.max(0, ...albumW.values());
  const artistScoreFor = (id: number | null) => id !== null && maxArtistW > 0 ? (artistW.get(id) ?? 0) / maxArtistW : 0;
  const genreScoreFor  = (g: string | null)  => g        && maxGenreW  > 0 ? (genreW.get(g) ?? 0)  / maxGenreW  : 0;
  const albumScoreFor  = (id: number | null) => id !== null && maxAlbumW  > 0 ? (albumW.get(id) ?? 0) / maxAlbumW  : 0;

  // Year: a candidate year scores by summing exp(-|candidate-ky|/sigma)
  // across every year the user has listened to, weighted by that year's
  // profile weight. Normalise against the best-possible year (the one
  // that's exactly on the peak).
  const yearScoreFor = (y: number | null): number => {
    if (y === null || yearW.size === 0) return 0;
    let raw = 0;
    for (const [ky, w] of yearW) {
      const dy = Math.abs(ky - y);
      if (dy > 20) continue;  // years more than 20 apart contribute nothing
      raw += w * Math.exp(-dy / YEAR_SIGMA);
    }
    return raw;
  };
  // Normalise year scores to 0..1 by sampling every year present in the
  // profile (the maximum possible score is achieved by a track AT one of
  // those years).
  const maxYearRaw = Math.max(0, ...[...yearW.keys()].map((y) => yearScoreFor(y)));
  const yearScoreNorm = (y: number | null) => (maxYearRaw > 0 ? yearScoreFor(y) / maxYearRaw : 0);

  // --- Phase 3: score each candidate ---------------------------------------
  interface Scored {
    id: number;
    score: number;
    reason: SuggestionEntry['reason'];
  }
  const scored: Scored[] = [];

  for (const r of rows) {
    const aS = artistScoreFor(r.artist_id);
    const gS = genreScoreFor(r.genre);
    const alS = albumScoreFor(r.album_id);
    const yS = yearScoreNorm(r.year);

    let score = W_ARTIST * aS + W_GENRE * gS + W_ALBUM * alS + W_YEAR * yS;

    // Recency penalty — just-played tracks feel stale in a "suggested"
    // list, so scale their score down. `age / window` clamped to [0,1];
    // the square root keeps the penalty gentle for the first few days
    // and still dominant for "played 10 minutes ago".
    if (r.last) {
      const ageDays = (now - r.last) / 86_400_000;
      if (ageDays < RECENCY_PENALTY_WINDOW_DAYS) {
        const ratio = Math.max(0, ageDays / RECENCY_PENALTY_WINDOW_DAYS);
        score *= Math.sqrt(ratio);
      }
    }

    // Over-familiar penalty: liked + frequent. User already knows this
    // one; give room for discovery.
    if (r.liked && r.plays > FAMILIAR_PLAY_THRESHOLD) score *= FAMILIAR_SCALE;

    if (score < MIN_SCORE) continue;

    // Reason chip: whichever weighted component contributed the most.
    // Ties are broken deterministically by the declared order below
    // (artist > genre > album > year), which matches our W_* weights.
    const contribs: Array<[SuggestionEntry['reason'], number]> = [
      ['artist', W_ARTIST * aS],
      ['genre',  W_GENRE  * gS],
      ['album',  W_ALBUM  * alS],
      ['era',    W_YEAR   * yS],
    ];
    contribs.sort((a, b) => b[1] - a[1]);
    const reason = contribs[0][0];

    scored.push({ id: r.id, score, reason });
  }

  // --- Phase 4: take top N + enrich for the UI -----------------------------
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  if (top.length === 0) return [];

  // One batch fetch for display fields + reason details.
  const placeholders = top.map(() => '?').join(',');
  const fullRows = db.prepare(`
    SELECT t.id,
           t.title,
           t.path,
           t.duration_sec,
           t.year,
           t.genre,
           t.album_id,
           ar.name        AS artist,
           al.title       AS album,
           al.cover_art_path,
           CASE WHEN l.track_id IS NOT NULL THEN 1 ELSE 0 END AS liked
    FROM tracks t
    LEFT JOIN artists ar    ON ar.id = t.artist_id
    LEFT JOIN albums  al    ON al.id = t.album_id
    LEFT JOIN track_likes l ON l.track_id = t.id
    WHERE t.id IN (${placeholders})
  `).all(...top.map((t) => t.id)) as any[];

  const byId = new Map<number, any>(fullRows.map((r) => [r.id, r]));
  // Preserve the scored order — SQL's `IN` doesn't guarantee it, and
  // ordering at the DB layer via a CASE on thousands of ids is uglier
  // than doing it in JS.
  const result: SuggestionEntry[] = [];
  for (const s of top) {
    const f = byId.get(s.id);
    if (!f) continue;
    // Decade label for era reason: "1990s", "2020s", etc.
    const decade = f.year ? `${Math.floor(f.year / 10) * 10}s` : '';
    const reasonDetail =
      s.reason === 'artist' ? (f.artist ?? '') :
      s.reason === 'genre'  ? (f.genre  ?? '') :
      s.reason === 'album'  ? (f.album  ?? '') :
      s.reason === 'era'    ? decade :
      '';
    result.push({
      id: f.id,
      title: f.title,
      artist: f.artist,
      album: f.album,
      path: f.path,
      duration_sec: f.duration_sec,
      cover_art_path: f.cover_art_path,
      year: f.year,
      genre: f.genre,
      liked: !!f.liked,
      score: s.score,
      reason: s.reason,
      reasonDetail,
    });
  }
  return result;
}

export function registerSuggestionsIpc(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.SUGGESTIONS_GET, (_e, limit?: number) => {
    try {
      return computeSuggestions(typeof limit === 'number' && limit > 0 ? Math.min(500, limit) : 100);
    } catch (err: any) {
      process.stdout.write(`[suggestions] compute failed: ${err?.message ?? err}\n`);
      return [];
    }
  });
}
