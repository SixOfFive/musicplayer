import type { IpcMain } from 'electron';
import { IPC, type StatsOverview, type NeatStats } from '../../shared/types';
import { getDb } from '../services/db';

// ----------------------------------------------------------------------------
// Fun-fact data: a single fat SQL dump powering the fun-fact banner.
// ----------------------------------------------------------------------------

const TITLE_STOPWORDS = new Set<string>([
  'the', 'a', 'an', 'of', 'and', 'or', 'but', 'to', 'in', 'on', 'at', 'by',
  'for', 'with', 'from', 'as', 'is', 'it', 'it\'s', 'its', 'this', 'that',
  'these', 'those', 'be', 'been', 'being', 'am', 'are', 'was', 'were', 'i',
  'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them',
  'feat', 'feat.', 'ft', 'ft.', 'vs', 'vs.', 'remix', 'version', 'edit',
  'remastered', 'remaster', 'live', 'acoustic', 'instrumental', 'mono',
  'stereo', 'demo', 'radio', 'single', 'extended', 'original', 'album',
  'mix', 'part', 'pt', 'pt.', 'no', 'n',
]);

function computeNeatStats(): NeatStats {
  const db = getDb();
  const now = Date.now();
  const year = new Date().getFullYear();

  // --- Decade distribution (track count + on-disk bytes) -------------------
  const decRows = db.prepare(`
    SELECT (t.year / 10) * 10 AS dec_start,
           COUNT(*) AS cnt,
           COALESCE(SUM(t.size), 0) AS bytes
    FROM tracks t
    WHERE t.year IS NOT NULL AND t.year > 1900 AND t.year <= ${year + 1}
    GROUP BY dec_start
    ORDER BY dec_start ASC
  `).all() as Array<{ dec_start: number; cnt: number; bytes: number }>;
  const decadeDistribution = decRows.map((r) => ({
    decade: `${r.dec_start}s`,
    trackCount: r.cnt,
    bytes: r.bytes,
  }));

  // Decade play distribution (join tracks + track_plays_summary)
  const decPlayRows = db.prepare(`
    SELECT (t.year / 10) * 10 AS dec_start,
           COALESCE(SUM(s.play_count), 0) AS plays,
           COALESCE(SUM(s.total_listened_sec), 0) AS listened
    FROM tracks t
    LEFT JOIN track_plays_summary s ON s.track_id = t.id
    WHERE t.year IS NOT NULL AND t.year > 1900 AND t.year <= ${year + 1}
    GROUP BY dec_start
    ORDER BY plays DESC
  `).all() as Array<{ dec_start: number; plays: number; listened: number }>;
  const decadePlayDistribution = decPlayRows.map((r) => ({
    decade: `${r.dec_start}s`,
    playCount: r.plays,
    listenedSec: r.listened,
  }));

  // --- Codec mix -----------------------------------------------------------
  const codecRows = db.prepare(`
    SELECT LOWER(COALESCE(codec, 'unknown')) AS k, COUNT(*) AS c
    FROM tracks
    GROUP BY k
  `).all() as Array<{ k: string; c: number }>;
  const codecDistribution: Record<string, number> = {};
  for (const r of codecRows) codecDistribution[r.k] = r.c;

  // --- Bitrate tiers -------------------------------------------------------
  const bitTiers = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN LOWER(codec) IN ('flac', 'wav', 'alac', 'ape', 'wavpack', 'tak') THEN 1 ELSE 0 END), 0) AS lossless,
      COALESCE(SUM(CASE WHEN bitrate >= 256000 AND LOWER(codec) NOT IN ('flac', 'wav', 'alac', 'ape', 'wavpack', 'tak') THEN 1 ELSE 0 END), 0) AS high_mp3,
      COALESCE(SUM(CASE WHEN bitrate >= 192000 AND bitrate < 256000 THEN 1 ELSE 0 END), 0) AS std_mp3,
      COALESCE(SUM(CASE WHEN bitrate > 0 AND bitrate < 192000 THEN 1 ELSE 0 END), 0) AS low_mp3
    FROM tracks
  `).get() as { lossless: number; high_mp3: number; std_mp3: number; low_mp3: number };

  // Average bitrate across lossy tracks (dividing by 1000 for kbps).
  const avgBitRow = db.prepare(`
    SELECT COALESCE(AVG(bitrate), 0) AS avg
    FROM tracks
    WHERE LOWER(codec) NOT IN ('flac', 'wav', 'alac', 'ape', 'wavpack', 'tak')
      AND bitrate > 0
  `).get() as { avg: number };

  // --- Prolific artists ----------------------------------------------------
  const prolificByTracks = db.prepare(`
    SELECT ar.name, COUNT(*) AS c
    FROM tracks t JOIN artists ar ON ar.id = t.artist_id
    WHERE ar.name IS NOT NULL
    GROUP BY ar.id
    ORDER BY c DESC
    LIMIT 5
  `).all() as Array<{ name: string; c: number }>;

  const prolificByAlbums = db.prepare(`
    SELECT ar.name, COUNT(*) AS c
    FROM albums al JOIN artists ar ON ar.id = al.artist_id
    WHERE ar.name IS NOT NULL
    GROUP BY ar.id
    ORDER BY c DESC
    LIMIT 5
  `).all() as Array<{ name: string; c: number }>;

  // --- Single-track artists -------------------------------------------------
  const singleTrackArtistRow = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT artist_id FROM tracks
      WHERE artist_id IS NOT NULL
      GROUP BY artist_id HAVING COUNT(*) = 1
    )
  `).get() as { c: number };

  // --- Album-shape stats ----------------------------------------------------
  const shortAlbumRow = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT album_id FROM tracks
      WHERE album_id IS NOT NULL
      GROUP BY album_id HAVING COUNT(*) <= 2
    )
  `).get() as { c: number };

  // "Fully heard": every track in the album has plays > 0.
  const fullyHeardRow = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT t.album_id
      FROM tracks t
      LEFT JOIN track_plays_summary s ON s.track_id = t.id
      WHERE t.album_id IS NOT NULL
      GROUP BY t.album_id
      HAVING SUM(CASE WHEN COALESCE(s.play_count, 0) = 0 THEN 1 ELSE 0 END) = 0
    )
  `).get() as { c: number };

  const unheardAlbumRow = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT t.album_id
      FROM tracks t
      LEFT JOIN track_plays_summary s ON s.track_id = t.id
      WHERE t.album_id IS NOT NULL
      GROUP BY t.album_id
      HAVING COALESCE(SUM(s.play_count), 0) = 0
    )
  `).get() as { c: number };

  const untouchedRow = db.prepare(`
    SELECT COUNT(*) AS c
    FROM tracks t
    LEFT JOIN track_plays_summary s ON s.track_id = t.id
    LEFT JOIN track_likes l ON l.track_id = t.id
    WHERE COALESCE(s.play_count, 0) = 0 AND l.track_id IS NULL
  `).get() as { c: number };

  // --- Title extremes -------------------------------------------------------
  const longestTitleRow = db.prepare(`
    SELECT t.title, ar.name AS artist, LENGTH(t.title) AS len
    FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id
    WHERE t.title IS NOT NULL AND LENGTH(t.title) > 0
    ORDER BY LENGTH(t.title) DESC
    LIMIT 1
  `).get() as { title: string; artist: string | null; len: number } | undefined;

  const shortestTitleRow = db.prepare(`
    SELECT t.title, ar.name AS artist, LENGTH(t.title) AS len
    FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id
    WHERE t.title IS NOT NULL AND LENGTH(t.title) > 0
    ORDER BY LENGTH(t.title) ASC
    LIMIT 1
  `).get() as { title: string; artist: string | null; len: number } | undefined;

  // Most common non-stopword in titles. Tokenised in JS — doing it in
  // pure SQL would require a custom tokenize function, and the cost
  // of loading every title once is negligible on a real library.
  const titles = db.prepare(`SELECT title FROM tracks WHERE title IS NOT NULL`).all() as Array<{ title: string }>;
  const wordCounts = new Map<string, number>();
  for (const { title } of titles) {
    // Split on non-letters, lowercase, drop stopwords + 1-letter tokens.
    const tokens = title.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
    for (const t of tokens) {
      if (t.length < 2) continue;
      if (TITLE_STOPWORDS.has(t)) continue;
      wordCounts.set(t, (wordCounts.get(t) ?? 0) + 1);
    }
  }
  let mostCommonTitleWord: NeatStats['mostCommonTitleWord'] = null;
  let topCount = 0;
  for (const [w, c] of wordCounts) {
    if (c > topCount) { topCount = c; mostCommonTitleWord = { word: w, count: c }; }
  }

  // --- Liked analytics ------------------------------------------------------
  const likedAgg = db.prepare(`
    SELECT
      COALESCE(SUM(t.duration_sec), 0) AS runtime,
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN COALESCE(s.play_count, 0) = 0 THEN 1 ELSE 0 END), 0) AS never_played,
      COALESCE(AVG(COALESCE(s.play_count, 0)), 0) AS avg_plays
    FROM track_likes l
    JOIN tracks t ON t.id = l.track_id
    LEFT JOIN track_plays_summary s ON s.track_id = l.track_id
  `).get() as { runtime: number; total: number; never_played: number; avg_plays: number };

  // --- Completion rate ------------------------------------------------------
  const complRow = db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END), 0) AS done
    FROM play_events
  `).get() as { total: number; done: number };
  const completionRate = complRow.total > 0 ? complRow.done / complRow.total : 0;

  // --- Median play_count ----------------------------------------------------
  // SQLite lacks a native median aggregate; pull the list and sort in JS.
  const playCountsRow = db.prepare(`
    SELECT play_count FROM track_plays_summary WHERE play_count > 0
  `).all() as Array<{ play_count: number }>;
  let medianPlayCount = 0;
  if (playCountsRow.length > 0) {
    const arr = playCountsRow.map((r) => r.play_count).sort((a, b) => a - b);
    const mid = Math.floor(arr.length / 2);
    medianPlayCount = arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
  }

  // --- Top genre share of plays --------------------------------------------
  const genreShareRow = db.prepare(`
    SELECT t.genre, SUM(s.play_count) AS plays
    FROM tracks t JOIN track_plays_summary s ON s.track_id = t.id
    WHERE t.genre IS NOT NULL AND t.genre <> ''
    GROUP BY t.genre
    ORDER BY plays DESC LIMIT 1
  `).get() as { genre: string; plays: number } | undefined;
  const totalGenrePlaysRow = db.prepare(`
    SELECT COALESCE(SUM(s.play_count), 0) AS plays
    FROM track_plays_summary s
  `).get() as { plays: number };
  const topGenrePlayShare = genreShareRow && totalGenrePlaysRow.plays > 0
    ? genreShareRow.plays / totalGenrePlaysRow.plays
    : 0;

  // --- Weighted avg year played --------------------------------------------
  const avgYearRow = db.prepare(`
    SELECT COALESCE(SUM(t.year * s.play_count) * 1.0 / NULLIF(SUM(s.play_count), 0), NULL) AS avg_year
    FROM tracks t JOIN track_plays_summary s ON s.track_id = t.id
    WHERE t.year IS NOT NULL AND t.year > 1900
  `).get() as { avg_year: number | null };

  // --- Tracks added this year ----------------------------------------------
  const startOfYear = new Date(new Date().getFullYear(), 0, 1).getTime();
  const thisYearRow = db.prepare(`
    SELECT COUNT(*) AS c FROM tracks WHERE date_added >= ?
  `).get(startOfYear) as { c: number };

  // --- Estimated playback bytes (sum play_count * size) --------------------
  const playbackBytesRow = db.prepare(`
    SELECT COALESCE(SUM(s.play_count * t.size), 0) AS b
    FROM track_plays_summary s JOIN tracks t ON t.id = s.track_id
  `).get() as { b: number };

  // --- Most-listened album -------------------------------------------------
  const topAlbRow = db.prepare(`
    SELECT al.title, ar.name AS artist, COALESCE(SUM(s.total_listened_sec), 0) AS listened
    FROM albums al
    LEFT JOIN artists ar ON ar.id = al.artist_id
    LEFT JOIN tracks t ON t.album_id = al.id
    LEFT JOIN track_plays_summary s ON s.track_id = t.id
    GROUP BY al.id
    ORDER BY listened DESC
    LIMIT 1
  `).get() as { title: string; artist: string | null; listened: number } | undefined;

  // --- Longest session + first/last play dates -----------------------------
  // Longest session we'll derive from StatsOverview logic inline — cheap enough.
  const allEv = db.prepare(`
    SELECT played_at, listened_sec FROM play_events ORDER BY played_at ASC
  `).all() as Array<{ played_at: number; listened_sec: number }>;
  const SESSION_GAP_MS = 10 * 60 * 1000;
  let longestSessionSec = 0, curSession = 0, prev = -Infinity;
  const daySet = new Set<string>();
  const monthSet = new Set<string>();
  const yearSet = new Set<number>();
  for (const p of allEv) {
    if (p.played_at - prev > SESSION_GAP_MS) {
      if (curSession > longestSessionSec) longestSessionSec = curSession;
      curSession = 0;
    }
    curSession += p.listened_sec;
    prev = p.played_at;
    const d = new Date(p.played_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    daySet.add(key);
    monthSet.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    yearSet.add(d.getFullYear());
  }
  if (curSession > longestSessionSec) longestSessionSec = curSession;

  const sortedDays = [...daySet].sort();
  const firstPlayDate = sortedDays[0] ?? null;
  const lastPlayDate = sortedDays[sortedDays.length - 1] ?? null;

  void now; // reserved for future "freshness" facts

  return {
    decadeDistribution,
    decadePlayDistribution,
    codecDistribution,
    bitrateTiers: {
      lossless: bitTiers.lossless,
      highMp3:  bitTiers.high_mp3,
      stdMp3:   bitTiers.std_mp3,
      lowMp3:   bitTiers.low_mp3,
    },
    avgBitrateKbps: Math.round(avgBitRow.avg / 1000),
    mostProlificArtistsByTracks: prolificByTracks.map((r) => ({ name: r.name, trackCount: r.c })),
    mostProlificArtistsByAlbums: prolificByAlbums.map((r) => ({ name: r.name, albumCount: r.c })),
    singleTrackArtistCount: singleTrackArtistRow.c,
    shortAlbumCount: shortAlbumRow.c,
    fullyHeardAlbumCount: fullyHeardRow.c,
    unheardAlbumCount: unheardAlbumRow.c,
    untouchedTrackCount: untouchedRow.c,
    longestTitle: longestTitleRow ? { title: longestTitleRow.title, artist: longestTitleRow.artist, length: longestTitleRow.len } : null,
    shortestTitle: shortestTitleRow ? { title: shortestTitleRow.title, artist: shortestTitleRow.artist, length: shortestTitleRow.len } : null,
    mostCommonTitleWord,
    likedRuntimeSec: likedAgg.runtime,
    likedNeverPlayed: likedAgg.never_played,
    likedAvgPlayCount: likedAgg.avg_plays,
    completionRate,
    totalPlayEvents: complRow.total,
    medianPlayCount,
    topGenrePlayShare,
    avgPlayedYear: avgYearRow.avg_year,
    tracksAddedThisYear: thisYearRow.c,
    estimatedPlaybackBytes: playbackBytesRow.b,
    mostListenedAlbum: topAlbRow && topAlbRow.listened > 0 ? { title: topAlbRow.title, artist: topAlbRow.artist, listenedSec: topAlbRow.listened } : null,
    longestSessionSec,
    firstPlayDate,
    lastPlayDate,
    activeMonthCount: monthSet.size,
    activeYearCount: yearSet.size,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function registerStatsIpc(ipcMain: IpcMain) {
  /**
   * Record a play event. Called by the renderer when a track stops (user skip,
   * auto-advance at end, track change, or manual stop) if at least 5 seconds
   * of audio were heard.
   *
   * Updates the per-track summary + inserts a row into play_events for
   * time-series queries.
   */
  ipcMain.handle(IPC.STATS_RECORD_PLAY, (_e, trackId: number, listenedSec: number, completed: boolean) => {
    if (!trackId || !(listenedSec > 0)) return false;
    const db = getDb();
    const now = Date.now();
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO play_events (track_id, played_at, listened_sec, completed)
        VALUES (?, ?, ?, ?)
      `).run(trackId, now, listenedSec, completed ? 1 : 0);

      // Upsert rollup.
      db.prepare(`
        INSERT INTO track_plays_summary (track_id, play_count, last_played_at, total_listened_sec)
        VALUES (?, 1, ?, ?)
        ON CONFLICT(track_id) DO UPDATE SET
          play_count = play_count + 1,
          last_played_at = excluded.last_played_at,
          total_listened_sec = total_listened_sec + excluded.total_listened_sec
      `).run(trackId, now, listenedSec);
    });
    tx();
    return true;
  });

  ipcMain.handle(IPC.STATS_OVERVIEW, (): StatsOverview => {
    const db = getDb();

    // Cumulative
    const cum = db.prepare(`
      SELECT
        COALESCE(SUM(listened_sec), 0) AS total_sec,
        COUNT(*) AS total_plays,
        COUNT(DISTINCT track_id) AS unique_tracks
      FROM play_events
    `).get() as { total_sec: number; total_plays: number; unique_tracks: number };

    const uniqArtistsRow = db.prepare(`
      SELECT COUNT(DISTINCT t.artist_id) AS c
      FROM play_events pe JOIN tracks t ON t.id = pe.track_id
      WHERE t.artist_id IS NOT NULL
    `).get() as { c: number };

    const uniqAlbumsRow = db.prepare(`
      SELECT COUNT(DISTINCT t.album_id) AS c
      FROM play_events pe JOIN tracks t ON t.id = pe.track_id
      WHERE t.album_id IS NOT NULL
    `).get() as { c: number };

    // Time-bucketed: start-of-today / week / month / year in *local* time.
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dow = now.getDay(); // 0=Sun
    const startOfWeek = startOfToday - dow * DAY_MS;
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const startOfYear = new Date(now.getFullYear(), 0, 1).getTime();
    const last7 = Date.now() - 7 * DAY_MS;
    const last30 = Date.now() - 30 * DAY_MS;

    const sumSince = (ms: number) =>
      (db.prepare('SELECT COALESCE(SUM(listened_sec), 0) AS s FROM play_events WHERE played_at >= ?')
        .get(ms) as { s: number }).s;

    const listenedToday = sumSince(startOfToday);
    const listenedWeek = sumSince(startOfWeek);
    const listenedMonth = sumSince(startOfMonth);
    const listenedYear = sumSince(startOfYear);
    const listenedLast7 = sumSince(last7);
    const listenedLast30 = sumSince(last30);

    // Active days + streaks. Pull all distinct YYYY-MM-DD (local) dates.
    const allPlays = db.prepare('SELECT played_at, listened_sec FROM play_events ORDER BY played_at ASC')
      .all() as Array<{ played_at: number; listened_sec: number }>;

    const daySet = new Set<string>();
    const dayTotals = new Map<string, number>();
    const hourHist = new Array<number>(24).fill(0);
    const dowHist = new Array<number>(7).fill(0);
    for (const p of allPlays) {
      const d = new Date(p.played_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      daySet.add(key);
      dayTotals.set(key, (dayTotals.get(key) ?? 0) + p.listened_sec);
      hourHist[d.getHours()] += p.listened_sec;
      dowHist[d.getDay()] += p.listened_sec;
    }
    const activeDayCount = daySet.size;
    const avgDailyListenedSec = activeDayCount > 0 ? cum.total_sec / activeDayCount : 0;

    // Streaks: scan sorted days, compute longest and current.
    const sortedDays = [...daySet].sort();
    let longestStreak = 0, currentRun = 0, lastDateObj: Date | null = null;
    for (const key of sortedDays) {
      const [y, m, d] = key.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      if (lastDateObj && Math.round((dt.getTime() - lastDateObj.getTime()) / DAY_MS) === 1) {
        currentRun++;
      } else {
        currentRun = 1;
      }
      if (currentRun > longestStreak) longestStreak = currentRun;
      lastDateObj = dt;
    }
    // Current streak: count back from today.
    let currentStreak = 0;
    const todayKey = (() => {
      const t = new Date();
      return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    })();
    if (daySet.has(todayKey)) {
      currentStreak = 1;
      let probe = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      while (true) {
        const k = `${probe.getFullYear()}-${String(probe.getMonth() + 1).padStart(2, '0')}-${String(probe.getDate()).padStart(2, '0')}`;
        if (!daySet.has(k)) break;
        currentStreak++;
        probe = new Date(probe.getFullYear(), probe.getMonth(), probe.getDate() - 1);
      }
    }

    // Most active hour / day-of-week.
    let mostActiveHour: number | null = null;
    let mostActiveDow: number | null = null;
    if (cum.total_plays > 0) {
      let maxH = -1, maxHIdx = 0;
      hourHist.forEach((v, i) => { if (v > maxH) { maxH = v; maxHIdx = i; } });
      mostActiveHour = maxHIdx;
      let maxD = -1, maxDIdx = 0;
      dowHist.forEach((v, i) => { if (v > maxD) { maxD = v; maxDIdx = i; } });
      mostActiveDow = maxDIdx;
    }

    // Biggest single listening day.
    let mostPlayedDay: { date: string; sec: number } | null = null;
    for (const [key, sec] of dayTotals) {
      if (!mostPlayedDay || sec > mostPlayedDay.sec) mostPlayedDay = { date: key, sec };
    }

    // Top tracks / artists / albums / genres by plays.
    const topTracks = db.prepare(`
      SELECT t.id, t.title, ar.name AS artist, al.title AS album, s.play_count AS playCount,
             al.cover_art_path AS coverArtPath
      FROM track_plays_summary s
      JOIN tracks t ON t.id = s.track_id
      LEFT JOIN artists ar ON ar.id = t.artist_id
      LEFT JOIN albums al ON al.id = t.album_id
      ORDER BY s.play_count DESC
      LIMIT 10
    `).all() as StatsOverview['topTracks'];

    const topArtists = db.prepare(`
      SELECT ar.id, ar.name, SUM(s.play_count) AS playCount, SUM(s.total_listened_sec) AS listenedSec
      FROM track_plays_summary s
      JOIN tracks t ON t.id = s.track_id
      JOIN artists ar ON ar.id = t.artist_id
      GROUP BY ar.id
      ORDER BY playCount DESC
      LIMIT 10
    `).all() as StatsOverview['topArtists'];

    const topAlbums = db.prepare(`
      SELECT al.id, al.title, ar.name AS artist, SUM(s.play_count) AS playCount,
             al.cover_art_path AS coverArtPath
      FROM track_plays_summary s
      JOIN tracks t ON t.id = s.track_id
      JOIN albums al ON al.id = t.album_id
      LEFT JOIN artists ar ON ar.id = al.artist_id
      GROUP BY al.id
      ORDER BY playCount DESC
      LIMIT 10
    `).all() as StatsOverview['topAlbums'];

    const topGenres = db.prepare(`
      SELECT t.genre AS genre, SUM(s.play_count) AS playCount
      FROM track_plays_summary s
      JOIN tracks t ON t.id = s.track_id
      WHERE t.genre IS NOT NULL AND t.genre <> ''
      GROUP BY t.genre
      ORDER BY playCount DESC
      LIMIT 10
    `).all() as StatsOverview['topGenres'];

    // First / last play.
    const firstLast = db.prepare(`
      SELECT MIN(played_at) AS first_at, MAX(played_at) AS last_at FROM play_events
    `).get() as { first_at: number | null; last_at: number | null };

    const firstPlayed = firstLast.first_at != null ? db.prepare(`
      SELECT t.id, t.title, ar.name AS artist
      FROM play_events pe
      JOIN tracks t ON t.id = pe.track_id
      LEFT JOIN artists ar ON ar.id = t.artist_id
      WHERE pe.played_at = ? LIMIT 1
    `).get(firstLast.first_at) as { id: number; title: string; artist: string | null } | undefined : undefined;

    const lastPlayed = firstLast.last_at != null ? db.prepare(`
      SELECT t.id, t.title, ar.name AS artist
      FROM play_events pe
      JOIN tracks t ON t.id = pe.track_id
      LEFT JOIN artists ar ON ar.id = t.artist_id
      WHERE pe.played_at = ? LIMIT 1
    `).get(firstLast.last_at) as { id: number; title: string; artist: string | null } | undefined : undefined;

    // Sessions: gaps > 10 min between consecutive play_events start a new session.
    const SESSION_GAP_MS = 10 * 60 * 1000;
    let sessionCount = 0;
    let longestSessionSec = 0;
    let curSessionSec = 0;
    let prevAt = -Infinity;
    for (const p of allPlays) {
      if (p.played_at - prevAt > SESSION_GAP_MS) {
        sessionCount++;
        if (curSessionSec > longestSessionSec) longestSessionSec = curSessionSec;
        curSessionSec = 0;
      }
      curSessionSec += p.listened_sec;
      prevAt = p.played_at;
    }
    if (curSessionSec > longestSessionSec) longestSessionSec = curSessionSec;
    const avgSessionSec = sessionCount > 0 ? cum.total_sec / sessionCount : 0;

    return {
      totalListenedSec: cum.total_sec,
      totalPlays: cum.total_plays,
      uniqueTracksPlayed: cum.unique_tracks,
      uniqueArtistsPlayed: uniqArtistsRow.c,
      uniqueAlbumsPlayed: uniqAlbumsRow.c,

      listenedTodaySec: listenedToday,
      listenedThisWeekSec: listenedWeek,
      listenedThisMonthSec: listenedMonth,
      listenedThisYearSec: listenedYear,
      listenedLast7DaysSec: listenedLast7,
      listenedLast30DaysSec: listenedLast30,

      avgDailyListenedSec,
      activeDayCount,
      currentStreakDays: currentStreak,
      longestStreakDays: longestStreak,

      mostActiveHour,
      mostActiveDayOfWeek: mostActiveDow,
      hourHistogram: hourHist,
      dayOfWeekHistogram: dowHist,

      topTracks,
      topArtists,
      topAlbums,
      topGenres,

      firstPlayAt: firstLast.first_at,
      lastPlayAt: firstLast.last_at,
      firstPlayedTrack: firstPlayed ?? null,
      lastPlayedTrack: lastPlayed ?? null,

      longestSessionSec,
      sessionCount,
      avgSessionSec,
      mostPlayedDay,
    };
  });

  // Fun-fact data dump. One heavy aggregate query set; called on demand
  // from the library stats panel, never on a timer.
  ipcMain.handle(IPC.STATS_NEAT, (): NeatStats => computeNeatStats());
}
