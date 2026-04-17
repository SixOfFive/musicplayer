import type { IpcMain } from 'electron';
import { IPC, type StatsOverview } from '../../shared/types';
import { getDb } from '../services/db';

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
}
