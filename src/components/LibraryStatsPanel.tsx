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

/** Integer pluralize helper — "1 track" / "2 tracks". */
function p(n: number, word: string, plural?: string): string {
  return `${n.toLocaleString()} ${n === 1 ? word : (plural ?? word + 's')}`;
}

/** "X out of Y (Z%)" given a numerator and denominator. */
function pctOf(num: number, denom: number): string {
  if (denom <= 0) return `${num.toLocaleString()}`;
  const p = Math.round((num / denom) * 1000) / 10;
  return `${p}%`;
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

  // --- Library "size equivalents" — everybody loves a goofy unit conversion ---
  if (s.totalBytes > 0) {
    // CD = 700 MB of audio. Funny to see how many you'd need.
    const cds = s.totalBytes / (700 * 1024 * 1024);
    if (cds >= 1) out.push(`Your library would fill ${p(Math.round(cds), 'audio CD')} — one per album cover, clattering onto the floor.`);
    // Original 5 GB first-gen iPod (2001). Great milestone.
    const ipods = s.totalBytes / (5 * 1024 * 1024 * 1024);
    if (ipods >= 1) out.push(`That's ${p(Math.round(ipods), 'first-generation 5 GB iPod', 'first-generation 5 GB iPods')} worth of music.`);
    // 3.5" floppies. Absurd deliberately.
    const floppies = s.totalBytes / (1.44 * 1024 * 1024);
    if (floppies >= 1000) out.push(`Or ${Math.round(floppies).toLocaleString()} floppy disks. Bring a station wagon.`);
    // Dual-layer Blu-ray (50 GB).
    const blurays = s.totalBytes / (50 * 1024 * 1024 * 1024);
    if (blurays >= 1) out.push(`Or ${p(Math.round(blurays * 10) / 10, 'dual-layer Blu-ray')} of music.`);
  }

  // --- Library duration equivalents ---
  if (s.totalDurationSec > 3600) {
    const hours = s.totalDurationSec / 3600;
    // A typical sleeper — 8 h nights.
    if (hours >= 8) out.push(`Playing it straight through, you'd sleep about ${p(Math.round(hours / 8), 'night')} to the sound of your own library.`);
    // Avg commercial flight ~3 h.
    if (hours >= 3) out.push(`Enough to soundtrack ${p(Math.round(hours / 3), 'three-hour flight')}.`);
    // Marathon world record: ~2 h.
    if (hours >= 2) out.push(`Or ${p(Math.round(hours / 2), 'back-to-back marathon')} for the elite runners.`);
    // Full Lord of the Rings extended trilogy ~11.5 h.
    if (hours >= 11.5) out.push(`You could watch the Lord of the Rings extended trilogy ${p(Math.round(hours / 11.5), 'time', 'times')} and still have music left.`);
    // A standard work week is ~40 h.
    if (hours >= 40) out.push(`That's ${p(Math.round(hours / 40), 'full work week')} of non-stop music.`);
  }

  // --- Library structure facts ---
  if (s.trackCount > 0 && s.albumCount > 0) {
    const avgTracks = s.trackCount / s.albumCount;
    out.push(`Your average album has ${avgTracks.toFixed(1)} tracks — ${avgTracks > 12 ? 'meaty LPs.' : avgTracks > 8 ? 'classic-length records.' : 'compact EPs-to-LPs.'}`);
  }
  if (s.totalDurationSec > 0 && s.trackCount > 0) {
    const avgTrackSec = s.totalDurationSec / s.trackCount;
    const m = Math.floor(avgTrackSec / 60);
    const sec = Math.round(avgTrackSec % 60);
    out.push(`The average track in your library is ${m}:${sec.toString().padStart(2, '0')} long.`);
  }
  if (s.totalBytes > 0 && s.trackCount > 0) {
    const avgMB = s.totalBytes / s.trackCount / (1024 * 1024);
    if (avgMB >= 20) out.push(`Your average file is ${avgMB.toFixed(1)} MB — pretty hi-res.`);
    else if (avgMB >= 8) out.push(`Your average file is ${avgMB.toFixed(1)} MB — lossless-ish territory.`);
    else out.push(`Your average file is ${avgMB.toFixed(1)} MB — efficiently encoded.`);
  }
  if (s.newestYear != null) {
    const currentYear = new Date().getFullYear();
    const decadesBack = Math.floor((currentYear - s.newestYear) / 10);
    if (decadesBack === 0 && s.newestYear === currentYear) {
      out.push(`Your newest album is from ${s.newestYear} — fresh off the press.`);
    }
  }
  if (s.oldestYear != null) {
    const currentYear = new Date().getFullYear();
    const age = currentYear - s.oldestYear;
    if (age > 50) out.push(`Your oldest album is from ${s.oldestYear} — that's ${age} years of music history in your library.`);
  }
  if (s.artistCount >= 100) {
    out.push(`${s.artistCount.toLocaleString()} different artists. That's more acts than most music festivals book.`);
  }
  if (s.playlistCount > 0 && s.trackCount > 0) {
    out.push(`You've curated ${p(s.playlistCount, 'playlist')} across your ${s.trackCount.toLocaleString()}-track library.`);
  }
  // Year-distribution joke: if the span touches a decade boundary
  if (s.oldestYear && s.newestYear && (Math.floor(s.newestYear / 10) - Math.floor(s.oldestYear / 10)) >= 5) {
    out.push(`Your music crosses ${Math.floor(s.newestYear / 10) - Math.floor(s.oldestYear / 10) + 1} different decades. Time-travel playlist material.`);
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

    // --- Listening-time wild equivalents ---
    const hoursListened = o.totalListenedSec / 3600;
    if (hoursListened >= 1) {
      // A typical person reads ~250 words per minute; avg novel ~80,000 words ≈ 5.3 hours.
      const books = Math.floor(hoursListened / 5.3);
      if (books >= 1) out.push(`If you'd been reading instead, you could've finished about ${p(books, 'novel')} in that time.`);
      // Avg movie ~2 h.
      const movies = Math.floor(hoursListened / 2);
      if (movies >= 1) out.push(`That's enough time to watch ${p(movies, 'feature-length film')} back to back.`);
      // NYC→LA flight ≈ 6 h.
      const flights = Math.floor(hoursListened / 6);
      if (flights >= 1) out.push(`You could have flown NYC→LA ${p(flights, 'time', 'times')} while listening to all that.`);
      // Avg walking pace ~3 mph.
      const milesWalked = hoursListened * 3;
      if (milesWalked >= 5) out.push(`At a casual walking pace, you'd have covered ${Math.round(milesWalked).toLocaleString()} miles by now.`);
      // Earth rotation: 24 h.
      const earthDays = hoursListened / 24;
      if (earthDays >= 1) out.push(`${earthDays.toFixed(1)} full Earth rotations worth of music has passed through your speakers.`);
      // Avg workday ~8 h.
      const workdays = Math.floor(hoursListened / 8);
      if (workdays >= 5) out.push(`You've logged ${p(workdays, 'workday')} of listening — essentially a second job.`);
      // Dark Side of the Moon: 42:59. Compare to classic albums.
      const dsotm = Math.floor(o.totalListenedSec / (43 * 60));
      if (dsotm >= 10) out.push(`That's ${dsotm.toLocaleString()} full spins of Dark Side of the Moon's runtime.`);
      // Wagner's Ring cycle: ~15 h.
      const rings = hoursListened / 15;
      if (rings >= 1) out.push(`You could've sat through Wagner's Ring cycle ${p(Math.round(rings * 10) / 10, 'time', 'times')}. Brünnhilde approves.`);
    }

    // --- Playback-rate / behavior insights ---
    if (o.activeDayCount >= 3 && o.avgDailyListenedSec >= 60) {
      const avgHour = o.avgDailyListenedSec / 3600;
      if (avgHour >= 8) out.push(`On an active day you log ${avgHour.toFixed(1)}+ hours of music — basically a full workday in headphones.`);
      else if (avgHour >= 3) out.push(`Your active-day average is ${avgHour.toFixed(1)} hours — long commute, long work session, or very dedicated chore playlist.`);
    }
    if (o.totalPlays > 0 && o.activeDayCount >= 2) {
      const playsPerActiveDay = o.totalPlays / o.activeDayCount;
      out.push(`On the days you listen, you average ${playsPerActiveDay.toFixed(1)} tracks played.`);
    }
    if (o.topTracks.length >= 2) {
      const t1 = o.topTracks[0], t2 = o.topTracks[1];
      if (t1.playCount > t2.playCount * 2) {
        out.push(`"${t1.title}" is in heavy rotation — you've played it ${t1.playCount}× vs ${t2.playCount}× for your #2. Obsessed much?`);
      }
    }
    if (o.topTracks[0] && o.topTracks[0].playCount >= 10) {
      const t = o.topTracks[0];
      // Assume ~3:30 avg if not known — we don't have duration here.
      const approxMinListened = t.playCount * 3.5;
      if (approxMinListened >= 60) {
        const hours = (approxMinListened / 60).toFixed(1);
        out.push(`You've put roughly ${hours} hours into "${t.title}" alone.`);
      }
    }
    if (o.uniqueArtistsPlayed > 0 && s.artistCount > 0) {
      const unplayed = s.artistCount - o.uniqueArtistsPlayed;
      if (unplayed > 0) {
        out.push(`You haven't played a single track from ${p(unplayed, 'artist')} in your library. Rediscovery time?`);
      }
    }
    if (o.uniqueTracksPlayed > 0 && s.trackCount > 0) {
      const unplayed = s.trackCount - o.uniqueTracksPlayed;
      if (unplayed > 50) {
        out.push(`${p(unplayed, 'track')} in your collection have never been played here. Treasure hunt?`);
      }
    }
    if (o.totalPlays >= 100 && s.likedCount > 0 && s.trackCount > 0) {
      const likePct = (s.likedCount / s.trackCount) * 100;
      if (likePct < 2) out.push(`Only ${likePct.toFixed(1)}% of your library is liked — a tough critic.`);
      else if (likePct > 30) out.push(`${likePct.toFixed(0)}% of your library is liked — you love generously.`);
    }
    if (o.mostActiveHour != null && o.mostActiveHour >= 0 && o.mostActiveHour < 5) {
      out.push(`Peak listening hour: ${formatHour(o.mostActiveHour)}. Night owl tendencies confirmed.`);
    } else if (o.mostActiveHour != null && o.mostActiveHour >= 5 && o.mostActiveHour < 9) {
      out.push(`Peak listening hour: ${formatHour(o.mostActiveHour)}. Morning person with impeccable taste.`);
    }
    if (o.hourHistogram && o.hourHistogram.length === 24) {
      const nightSec = o.hourHistogram.slice(0, 6).reduce((n, v) => n + v, 0);
      const daySec = o.hourHistogram.slice(9, 17).reduce((n, v) => n + v, 0);
      if (nightSec > daySec && nightSec > 600) {
        out.push(`You listen to more music between midnight and 6am than during a typical workday. Vampire playlist approved.`);
      }
    }
    if (o.dayOfWeekHistogram && o.dayOfWeekHistogram.length === 7) {
      const weekend = o.dayOfWeekHistogram[0] + o.dayOfWeekHistogram[6];
      const weekday = o.dayOfWeekHistogram[1] + o.dayOfWeekHistogram[2] + o.dayOfWeekHistogram[3] + o.dayOfWeekHistogram[4] + o.dayOfWeekHistogram[5];
      const weekdayAvg = weekday / 5;
      const weekendAvg = weekend / 2;
      if (weekdayAvg > weekendAvg * 1.5) out.push(`You listen ~${((weekdayAvg / Math.max(1, weekendAvg)) * 100 / 100).toFixed(1)}× more on weekdays than weekends. Office soundtrack life.`);
      else if (weekendAvg > weekdayAvg * 1.5) out.push(`Weekends get ~${((weekendAvg / Math.max(1, weekdayAvg)) * 100 / 100).toFixed(1)}× more listening time than weekdays. Saturday vibes.`);
    }
    if (o.currentStreakDays >= 7) {
      out.push(`Seven days and counting. A full week of daily music — ${o.currentStreakDays >= 30 ? 'you\'ve built a habit.' : 'keep it rolling.'}`);
    }
    if (o.currentStreakDays >= 100) {
      out.push(`${o.currentStreakDays} consecutive days of listening. That's a serious commitment to the craft.`);
    }
    if (o.longestSessionSec >= 3 * 3600) {
      out.push(`Your longest unbroken session: ${formatDuration(o.longestSessionSec)}. Someone was in the zone.`);
    }
    if (o.mostPlayedDay && o.mostPlayedDay.sec >= 6 * 3600) {
      const h = (o.mostPlayedDay.sec / 3600).toFixed(1);
      out.push(`Your heaviest listening day hit ${h} hours on ${o.mostPlayedDay.date}. What were you doing?`);
    }
    if (o.uniqueTracksPlayed > 0 && o.totalPlays > 0) {
      const repeatRatio = o.totalPlays / o.uniqueTracksPlayed;
      if (repeatRatio >= 3) out.push(`You replay tracks ${repeatRatio.toFixed(1)}× on average — you know what you like.`);
      else if (repeatRatio < 1.5 && o.totalPlays >= 50) out.push(`You rarely replay tracks (${repeatRatio.toFixed(1)}× avg). Always exploring?`);
    }
  }

  // Suppress unused-var warnings for the inner `p` vs top-level `pctOf` —
  // kept around for future percentage-flavored facts.
  void pctOf;

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
