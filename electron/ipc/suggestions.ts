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
// TWO-TIER TASTE PROFILE
// ---------------------------------------------------------------------------
// Splitting the profile into separate "liked" and "played-only" maps
// prevents a track you've had on rotation 100 times (but never hit the
// heart on) from dominating your taste signal. Such a track is usually
// something that lives in your queue by accident — shuffle luck, radio
// appearance, album filler — not something you've actually committed
// to loving. Treating it equal to a like would drag recommendations
// toward "more of the stuff you kind of tolerate."
//
// Two independent profiles:
//   likedProfile — from tracks in track_likes. A liked track contributes
//     `(1 + log(1+plays)) × decay`, so play count still boosts, but
//     the like itself is a strong floor regardless of how often it's
//     been spun. Liked-but-rarely-played tracks still register.
//
//   playedProfile — from tracks with plays > 0 AND NOT liked. Each
//     contributes `log(1+plays) × decay`. The log keeps 100 plays
//     from being 100× the signal of 1 play — diminishing returns
//     match how music listening actually works (your 100th spin of
//     a song tells me much less than your first 10).
//
// Each candidate track gets two scores per attribute (artist / genre /
// album / year): one against the liked profile, one against the played
// profile. We then combine them as a 70/30 blend, favouring likes:
//   combinedArtistMatch = 0.70 × likedArtistMatch + 0.30 × playedArtistMatch
// The blend tuning is deliberately biased — a user's explicit likes
// are the clearest signal of "what kind of music I want to hear,"
// while playcount is a noisy proxy for it. If the user has never liked
// anything, the liked profile is empty and all weight falls through
// to played — degrades gracefully to a play-based recommender.
//
// FINAL SCORE
// ---------------------------------------------------------------------------
// score = 0.40·combinedArtist + 0.25·combinedGenre + 0.15·combinedAlbum + 0.10·combinedYear
//
// Then two post-multipliers that push truly-discoverable picks up:
//   - Recency penalty (played in last 14 days → scaled down).
//   - Over-familiarity penalty (liked AND played >10 times → halved).
//
// The reason chip is the single biggest contributor to the score —
// whichever of combined-{artist,genre,album,year} × its top-level
// weight wins. Gives the user a plain-English "why is this here?"
// label so the list doesn't feel like a black box.

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

// Profile blend: how much the LIKED-tracks taste profile dominates over
// the PLAYED-only profile when combining partial scores. 0.70 means
// three-quarters of your taste signal comes from what you've explicitly
// liked; the rest fills in from what you've played often enough to
// matter. Tunable — if the list feels too narrowly "more of what you
// already liked", bump PLAYED_BLEND up a bit for broader strokes.
const LIKED_BLEND  = 0.70;
const PLAYED_BLEND = 0.30;

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

// How much score jitter to apply when the caller provides a seed
// (i.e., when the user explicitly hit Refresh). ±15% of the raw
// final score — enough to reshuffle tracks with similar affinities,
// not so much that actual favourites stop surfacing at the top.
// Result: every refresh produces a genuinely different order, with
// the same overall "these are your picks" quality bar.
const JITTER_MAGNITUDE = 0.15;

// How much to penalise subsequent picks by the same artist / album.
// Applied as a multiplicative decay on score for each same-artist
// track already chosen. Encourages the top-100 to feel like a mix
// rather than a single-artist marathon.
const ARTIST_REPEAT_DECAY = 0.85;
const ALBUM_REPEAT_DECAY  = 0.90;

/** Seeded PRNG — linear congruential, deterministic given `seed`.
 *  Returns values in [0, 1). Used to drive the refresh-time jitter
 *  so a given seed always produces the same "shuffle" — handy for
 *  debugging, and means successive renders within one refresh hit
 *  the same scored order. */
function seededRand(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

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
/**
 * @param limit How many suggestions to return (clamped 1-500).
 * @param seed Optional PRNG seed. When provided, scores get ±JITTER_MAGNITUDE
 *   noise and picks get artist/album-repeat decay, so every refresh
 *   produces a genuinely different ordering. Omit for deterministic
 *   scoring (handy for testing).
 */
function computeSuggestions(limit: number = 100, seed: number | null = null): SuggestionEntry[] {
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

  // --- Phase 1: build the two-tier taste profile ---------------------------
  // Liked profile (strong signal) and played-only profile (secondary)
  // kept separate so they can be weighted differently when combined.
  // Each Map keys attribute-value → accumulated weight.
  const decay = (lastMs: number | null): number => {
    if (!lastMs) return 0.5; // liked-but-never-played gets a neutral 0.5
    const days = (now - lastMs) / 86_400_000;
    if (days < 0) return 1;
    return Math.exp(-days / HALF_LIFE_DAYS);
  };

  const likedArtistW  = new Map<number, number>();
  const likedGenreW   = new Map<string, number>();
  const likedAlbumW   = new Map<number, number>();
  const likedYearW    = new Map<number, number>();
  const playedArtistW = new Map<number, number>();
  const playedGenreW  = new Map<string, number>();
  const playedAlbumW  = new Map<number, number>();
  const playedYearW   = new Map<number, number>();

  for (const r of rows) {
    if (r.plays === 0 && !r.liked) continue;
    const d = decay(r.last);
    if (r.liked) {
      // Liked track: floor of 1 + log-play boost. Even a never-played
      // like registers as a solid 1×decay; heavily-played liked tracks
      // climb logarithmically from there (1+ln(51) ≈ 4.9 for 50 plays).
      const w = (1 + Math.log(1 + r.plays)) * d;
      if (w <= 0) continue;
      if (r.artist_id !== null) likedArtistW.set(r.artist_id, (likedArtistW.get(r.artist_id) ?? 0) + w);
      if (r.genre)              likedGenreW.set(r.genre,       (likedGenreW.get(r.genre) ?? 0) + w);
      if (r.album_id !== null)  likedAlbumW.set(r.album_id,    (likedAlbumW.get(r.album_id) ?? 0) + w);
      if (r.year !== null)      likedYearW.set(r.year,         (likedYearW.get(r.year) ?? 0) + w);
    } else {
      // Played-not-liked: log(1+plays) × decay. One play ≈ 0.69, ten
      // plays ≈ 2.4, a hundred plays ≈ 4.6. A heavily-played unliked
      // track still contributes real signal but can't dominate a liked
      // track's floor of 1 (weighted at 70% vs 30% in the blend below).
      const w = Math.log(1 + r.plays) * d;
      if (w <= 0) continue;
      if (r.artist_id !== null) playedArtistW.set(r.artist_id, (playedArtistW.get(r.artist_id) ?? 0) + w);
      if (r.genre)              playedGenreW.set(r.genre,       (playedGenreW.get(r.genre) ?? 0) + w);
      if (r.album_id !== null)  playedAlbumW.set(r.album_id,    (playedAlbumW.get(r.album_id) ?? 0) + w);
      if (r.year !== null)      playedYearW.set(r.year,         (playedYearW.get(r.year) ?? 0) + w);
    }
  }

  // If the user has zero history, there's nothing to score from. Bail
  // with an empty list rather than returning a random slice.
  const anyProfile =
    likedArtistW.size + likedGenreW.size + likedAlbumW.size + likedYearW.size +
    playedArtistW.size + playedGenreW.size + playedAlbumW.size + playedYearW.size;
  if (anyProfile === 0) return [];

  // --- Phase 2: per-profile normalisers -----------------------------------
  // Each profile gets its own max so one empty profile (e.g. no likes
  // yet) doesn't zero out the other. The combined score below blends.
  const normMap = <K>(m: Map<K, number>) => {
    const max = Math.max(0, ...m.values());
    return (k: K | null): number => (k !== null && max > 0 ? (m.get(k) ?? 0) / max : 0);
  };
  const likedArtistScore  = normMap(likedArtistW);
  const likedGenreScore   = normMap(likedGenreW);
  const likedAlbumScore   = normMap(likedAlbumW);
  const playedArtistScore = normMap(playedArtistW);
  const playedGenreScore  = normMap(playedGenreW);
  const playedAlbumScore  = normMap(playedAlbumW);

  // Year scoring: smoothed across ±20 years using a Gaussian-like bell
  // with YEAR_SIGMA sigma. Computed per-profile independently so a
  // user who likes 1970s rock and often plays 2020s pop sees both
  // contribute to their suggestions.
  const makeYearScorer = (yearW: Map<number, number>) => {
    if (yearW.size === 0) return (_y: number | null): number => 0;
    const rawFor = (y: number): number => {
      let raw = 0;
      for (const [ky, w] of yearW) {
        const dy = Math.abs(ky - y);
        if (dy > 20) continue;
        raw += w * Math.exp(-dy / YEAR_SIGMA);
      }
      return raw;
    };
    const maxRaw = Math.max(0, ...[...yearW.keys()].map(rawFor));
    return (y: number | null): number => (y === null || maxRaw <= 0 ? 0 : rawFor(y) / maxRaw);
  };
  const likedYearScore  = makeYearScorer(likedYearW);
  const playedYearScore = makeYearScorer(playedYearW);

  // Combined scorers: 70% liked-profile, 30% played-profile. If the
  // user has never liked anything the liked-side returns 0 and all
  // weight transparently flows through the played side.
  const artistScoreFor = (id: number | null) => LIKED_BLEND * likedArtistScore(id) + PLAYED_BLEND * playedArtistScore(id);
  const genreScoreFor  = (g: string | null) => LIKED_BLEND * likedGenreScore(g)  + PLAYED_BLEND * playedGenreScore(g);
  const albumScoreFor  = (id: number | null) => LIKED_BLEND * likedAlbumScore(id) + PLAYED_BLEND * playedAlbumScore(id);
  const yearScoreNorm  = (y: number | null) => LIKED_BLEND * likedYearScore(y)   + PLAYED_BLEND * playedYearScore(y);

  // --- Phase 3: score each candidate ---------------------------------------
  // If the caller passed a seed (user hit Refresh), we apply a ±15%
  // multiplicative jitter per track so that tracks with similar raw
  // scores re-order on each refresh. The PRNG is deterministic given
  // the seed, so a single request produces stable ordering across
  // any internal re-reads.
  const rand = seed != null ? seededRand(seed) : null;

  interface Scored {
    id: number;
    artist_id: number | null;
    album_id: number | null;
    score: number;
    reason: SuggestionEntry['reason'];
  }
  const scored: Scored[] = [];

  for (const r of rows) {
    // Skip tracks the user has already liked. "Suggested" is a
    // discovery surface — a liked track is, by definition, something
    // they already know they enjoy. Those still contribute to the
    // TASTE PROFILE above (Phase 1) where they're the strongest
    // positive signal for artist/genre/era weights; they just don't
    // compete for slots in the output list.
    if (r.liked) continue;

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

    // Refresh jitter: ±JITTER_MAGNITUDE of the raw score. Applied
    // multiplicatively so high-score tracks still beat low-score tracks,
    // but tracks within the same affinity band re-order unpredictably.
    // Only kicks in when a seed is provided (user-initiated refresh).
    if (rand) {
      const jitter = 1 + (rand() * 2 - 1) * JITTER_MAGNITUDE;
      score *= jitter;
    }

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

    scored.push({ id: r.id, artist_id: r.artist_id, album_id: r.album_id, score, reason });
  }

  // --- Phase 4: pick top N with diversification -----------------------------
  // Initial sort by jittered score. Then, when a seed is provided, walk
  // the list and apply a multiplicative decay to same-artist / same-album
  // tracks each time we pick one. This means the top-100 doesn't turn into
  // "25 tracks from one artist in a row" — variety wins ties. Without a
  // seed (no refresh request) we skip diversification so the deterministic
  // view stays predictable.
  scored.sort((a, b) => b.score - a.score);
  let top: Scored[];
  if (rand) {
    top = [];
    const artistSeen = new Map<number, number>();
    const albumSeen = new Map<number, number>();
    const pool = [...scored];
    while (top.length < limit && pool.length > 0) {
      // Apply per-pick decay in-place: each candidate's effective score
      // equals its base score × ARTIST_REPEAT_DECAY^(times artist picked)
      // × ALBUM_REPEAT_DECAY^(times album picked). Recompute and pick
      // the current max on every iteration — a cheap O(pool × picks)
      // loop for a limit of 500 and pool size in the low thousands.
      let bestIdx = 0;
      let bestEff = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i];
        const aSeen = c.artist_id !== null ? (artistSeen.get(c.artist_id) ?? 0) : 0;
        const lSeen = c.album_id  !== null ? (albumSeen.get(c.album_id) ?? 0) : 0;
        const eff = c.score * Math.pow(ARTIST_REPEAT_DECAY, aSeen) * Math.pow(ALBUM_REPEAT_DECAY, lSeen);
        if (eff > bestEff) { bestEff = eff; bestIdx = i; }
      }
      const picked = pool.splice(bestIdx, 1)[0];
      top.push(picked);
      if (picked.artist_id !== null) artistSeen.set(picked.artist_id, (artistSeen.get(picked.artist_id) ?? 0) + 1);
      if (picked.album_id !== null) albumSeen.set(picked.album_id, (albumSeen.get(picked.album_id) ?? 0) + 1);
    }
  } else {
    top = scored.slice(0, limit);
  }
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
           t.codec,
           t.bitrate,
           t.sample_rate,
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
      codec: f.codec ?? null,
      bitrate: f.bitrate ?? null,
      sample_rate: f.sample_rate ?? null,
      liked: !!f.liked,
      score: s.score,
      reason: s.reason,
      reasonDetail,
    });
  }
  return result;
}

export function registerSuggestionsIpc(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.SUGGESTIONS_GET, (_e, limit?: number, seed?: number) => {
    try {
      const n = typeof limit === 'number' && limit > 0 ? Math.min(500, limit) : 100;
      const s = typeof seed === 'number' && Number.isFinite(seed) ? seed : null;
      return computeSuggestions(n, s);
    } catch (err: any) {
      process.stdout.write(`[suggestions] compute failed: ${err?.message ?? err}\n`);
      return [];
    }
  });
}
