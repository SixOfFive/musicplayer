import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LibraryStats, StatsOverview } from '../../shared/types';
import { useLibraryRefresh } from '../hooks/useLibraryRefresh';
import { formatBytes } from '../hooks/useScanProgress';

function formatDuration(sec: number): string {
  if (!sec || sec < 1) return '0 sec';
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${m}m`;
  if (m >= 1) return `${m}m`;
  return `${Math.round(sec)}s`;
}

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function formatHour(h: number): string {
  const ampm = h < 12 ? 'am' : 'pm';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}${ampm}`;
}

function buildFunFacts(s: LibraryStats, o: StatsOverview | null): string[] {
  const out: string[] = [];

  // --- Library facts (no play history required) ---
  if (s.totalDurationSec > 3600) {
    out.push(`Back-to-back, your library would play for ${formatDuration(s.totalDurationSec)} straight.`);
  }
  if (s.topGenre) {
    out.push(`Your top genre is ${s.topGenre} — it shows up on ${s.topGenreCount.toLocaleString()} tracks.`);
  }
  if (s.oldestYear && s.newestYear && s.newestYear > s.oldestYear) {
    out.push(`Your collection spans ${s.newestYear - s.oldestYear} years, from ${s.oldestYear} to ${s.newestYear}.`);
  }
  if (s.biggestAlbum) {
    out.push(`Your chunkiest album is "${s.biggestAlbum.title}" by ${s.biggestAlbum.artist ?? 'Unknown'} — ${formatBytes(s.biggestAlbum.bytes)}.`);
  }
  if (s.longestTrack) {
    const mins = Math.floor(s.longestTrack.seconds / 60);
    out.push(`Your longest track is "${s.longestTrack.title}" by ${s.longestTrack.artist ?? 'Unknown'} at ${mins} minutes.`);
  }
  if (s.albumCount > 0) {
    const pct = Math.round(s.coverArtCoverage * 100);
    out.push(`${pct}% of your albums have cover art${pct < 100 ? ' — the rest will fill in as the art fetch continues.' : '.'}`);
  }
  if (s.trackCount > 0 && s.artistCount > 0) {
    const avg = (s.trackCount / s.artistCount).toFixed(1);
    out.push(`On average, each artist has ${avg} tracks in your library.`);
  }
  if (s.likedCount > 0) {
    out.push(`You've liked ${s.likedCount.toLocaleString()} track${s.likedCount === 1 ? '' : 's'} so far.`);
  }

  // --- Play-history facts ---
  if (o && o.totalPlays > 0) {
    out.push(`You've played ${o.totalPlays.toLocaleString()} tracks for a total of ${formatDuration(o.totalListenedSec)}.`);
    if (o.listenedTodaySec > 60) out.push(`Listened today: ${formatDuration(o.listenedTodaySec)}.`);
    if (o.listenedThisWeekSec > 60) out.push(`This week: ${formatDuration(o.listenedThisWeekSec)} of music.`);
    if (o.listenedThisMonthSec > 60) out.push(`This month: ${formatDuration(o.listenedThisMonthSec)} listened.`);
    if (o.listenedThisYearSec > 60) out.push(`So far this year: ${formatDuration(o.listenedThisYearSec)}.`);
    if (o.listenedLast30DaysSec > 60) out.push(`In the last 30 days you logged ${formatDuration(o.listenedLast30DaysSec)} of listening.`);

    if (o.activeDayCount >= 2) {
      out.push(`You average ${formatDuration(o.avgDailyListenedSec)} per active day over ${o.activeDayCount} distinct days.`);
    }
    if (o.currentStreakDays > 1) out.push(`You're on a ${o.currentStreakDays}-day listening streak 🔥`);
    if (o.longestStreakDays > o.currentStreakDays && o.longestStreakDays > 1) {
      out.push(`Your longest listening streak so far: ${o.longestStreakDays} consecutive days.`);
    }
    if (o.mostActiveHour != null) {
      out.push(`Your most musical hour of the day is ${formatHour(o.mostActiveHour)}.`);
    }
    if (o.mostActiveDayOfWeek != null) {
      out.push(`${DOW_NAMES[o.mostActiveDayOfWeek]} is your biggest listening day of the week.`);
    }
    if (o.topTracks[0]) {
      const t = o.topTracks[0];
      out.push(`Your most-played track: "${t.title}" by ${t.artist ?? 'Unknown'} — ${t.playCount} play${t.playCount === 1 ? '' : 's'}.`);
    }
    if (o.topArtists[0]) {
      const a = o.topArtists[0];
      out.push(`Top artist on rotation: ${a.name} (${formatDuration(a.listenedSec)} listened).`);
    }
    if (o.topAlbums[0]) {
      const a = o.topAlbums[0];
      out.push(`Your go-to album is "${a.title}" by ${a.artist ?? 'Unknown'}.`);
    }
    if (o.topGenres[0]) {
      out.push(`You've played ${o.topGenres[0].genre} the most — ${o.topGenres[0].playCount} track plays.`);
    }
    if (o.uniqueArtistsPlayed > 0) {
      out.push(`You've played music from ${o.uniqueArtistsPlayed.toLocaleString()} different artists.`);
    }
    if (o.uniqueTracksPlayed > 0 && s.trackCount > 0) {
      const pct = Math.round((o.uniqueTracksPlayed / s.trackCount) * 100);
      out.push(`You've sampled ${pct}% of your library (${o.uniqueTracksPlayed.toLocaleString()} / ${s.trackCount.toLocaleString()} tracks).`);
    }
    if (o.longestSessionSec > 600) {
      out.push(`Your longest continuous listening session: ${formatDuration(o.longestSessionSec)}.`);
    }
    if (o.sessionCount >= 2) {
      out.push(`You've had ${o.sessionCount.toLocaleString()} listening sessions, averaging ${formatDuration(o.avgSessionSec)} each.`);
    }
    if (o.mostPlayedDay && o.mostPlayedDay.sec > 600) {
      out.push(`Your biggest single listening day was ${o.mostPlayedDay.date}: ${formatDuration(o.mostPlayedDay.sec)}.`);
    }
    if (o.firstPlayedTrack && o.firstPlayAt) {
      const when = new Date(o.firstPlayAt).toLocaleDateString();
      out.push(`The first track you ever played here: "${o.firstPlayedTrack.title}" on ${when}.`);
    }
  }

  return out;
}

export default function LibraryStatsPanel() {
  const [s, setS] = useState<LibraryStats | null>(null);
  const [o, setO] = useState<StatsOverview | null>(null);
  const [factIndex, setFactIndex] = useState(() => Math.floor(Math.random() * 1000));

  const load = useCallback(() => {
    window.mp.library.stats().then(setS);
    // stats.overview may not exist on older preloads — gracefully ignore.
    if (window.mp.stats?.overview) window.mp.stats.overview().then(setO).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  useLibraryRefresh(load);

  // Auto-rotate the fact every 12s, in addition to click-to-cycle.
  useEffect(() => {
    const t = setInterval(() => setFactIndex((i) => i + 1), 12000);
    return () => clearInterval(t);
  }, []);

  const facts = useMemo(() => (s ? buildFunFacts(s, o) : []), [s, o]);

  if (!s) return null;
  if (s.trackCount === 0) return null;

  const currentFact = facts.length > 0 ? facts[factIndex % facts.length] : null;

  return (
    <div className="mb-8">
      {/* Big stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat label="Tracks" value={s.trackCount.toLocaleString()} />
        <Stat label="Albums" value={s.albumCount.toLocaleString()} />
        <Stat label="Artists" value={s.artistCount.toLocaleString()} />
        <Stat label="Library size" value={formatBytes(s.totalBytes)} />
        <Stat label="Total runtime" value={formatDuration(s.totalDurationSec)} />
        <Stat label="Playlists" value={s.playlistCount.toLocaleString()} highlight={`${s.likedCount.toLocaleString()} liked`} />
      </div>

      {/* Fun fact */}
      {currentFact && (
        <div
          className="mt-4 p-4 rounded-xl bg-gradient-to-r from-purple-900/40 to-blue-900/30 border border-purple-500/20 flex items-start gap-3 cursor-pointer hover:border-purple-500/40 transition"
          onClick={() => setFactIndex((i) => i + 1)}
          title="Click for another fact"
        >
          <div className="text-2xl">💡</div>
          <div className="flex-1 text-sm text-text-primary">{currentFact}</div>
          <div className="text-xs text-text-muted">↻</div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: string }) {
  return (
    <div className="bg-bg-elev-1 rounded-lg p-3">
      <div className="text-xs uppercase tracking-wider text-text-muted">{label}</div>
      <div className="text-2xl font-bold tabular-nums mt-1">{value}</div>
      {highlight && <div className="text-xs text-text-muted mt-0.5">{highlight}</div>}
    </div>
  );
}
