// Massive library of fun-fact templates for the home-screen banner.
//
// Each template inspects one or more fields across LibraryStats /
// StatsOverview / NeatStats and emits a string when its preconditions
// are met. Total catalogue: 200+ possible facts. On any given run only
// the subset whose preconditions are satisfied will render, so a
// brand-new user with 50 tracks and zero plays still sees a reasonable
// non-empty banner (~30-40 library-only facts).
//
// Structure:
//   - `buildFunFacts(s, o, n)` is the single entry point
//   - Facts are organised by category inside it (library basics, silly
//     unit conversions, decade analysis, codec/format, listening
//     patterns, top items, discovery/diversity, liked, behavior)
//   - Each category section emits its facts with localised guards so
//     the ordering is readable and individual categories can be
//     edited/extended without worrying about the rest
//   - `shuffleFacts(facts, seed)` does a seeded Fisher-Yates so the
//     caller can randomise order once per mount while keeping the
//     sequence stable for click-to-advance
//
// Adding a new fact is trivial — pick a category block, write an
// `if (...) out.push(...)`. That's it. The panel picks it up.

import type { LibraryStats, StatsOverview, NeatStats } from '../../shared/types';
import { formatBytes } from '../hooks/useScanProgress';

// ============================================================================
// Formatters
// ============================================================================

export function formatDuration(sec: number): string {
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
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function formatHour(h: number): string {
  const ampm = h < 12 ? 'am' : 'pm';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}${ampm}`;
}

function p(n: number, word: string, plural?: string): string {
  return `${n.toLocaleString()} ${n === 1 ? word : (plural ?? word + 's')}`;
}

// ============================================================================
// Shuffling (seeded so once-per-session randomisation is stable while
// the component is mounted).
// ============================================================================

/** Linear congruential generator. Deterministic given a seed — we
 *  seed it with Date.now() at panel mount, so the shuffle is different
 *  every app launch but identical across re-renders within a session. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function shuffleFacts<T>(facts: T[], seed: number): T[] {
  const out = [...facts];
  const rand = lcg(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ============================================================================
// The catalogue
// ============================================================================

export function buildFunFacts(
  s: LibraryStats,
  o: StatsOverview | null,
  n: NeatStats | null,
): string[] {
  const out: string[] = [];
  const year = new Date().getFullYear();

  // ----- LIBRARY BASICS -----------------------------------------------------
  if (s.trackCount > 0)   out.push(`Your library holds ${p(s.trackCount, 'track')}.`);
  if (s.albumCount > 0)   out.push(`Across ${p(s.albumCount, 'album')}.`);
  if (s.artistCount > 0)  out.push(`By ${p(s.artistCount, 'different artist')}.`);
  if (s.playlistCount > 0) out.push(`Organised into ${p(s.playlistCount, 'playlist')}.`);
  if (s.likedCount > 0)   out.push(`You've hit ♥ on ${p(s.likedCount, 'track')}.`);
  if (s.totalBytes > 0)   out.push(`Total on-disk size: ${formatBytes(s.totalBytes)}.`);
  if (s.totalDurationSec > 3600) out.push(`Back-to-back, your library would play for ${formatDuration(s.totalDurationSec)} straight.`);
  if (s.totalDurationSec > 86400) {
    const days = s.totalDurationSec / 86400;
    out.push(`If you started playing now without stopping, you'd still be listening ${days.toFixed(1)} days from now.`);
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
    const secs = s.longestTrack.seconds % 60;
    out.push(`Your longest track is "${s.longestTrack.title}" by ${s.longestTrack.artist ?? 'Unknown'} at ${mins}:${String(Math.round(secs)).padStart(2,'0')}.`);
  }
  if (s.albumCount > 0) {
    const pct = Math.round(s.coverArtCoverage * 100);
    out.push(`${pct}% of your albums have cover art${pct < 100 ? ' — the rest will fill in as the art fetch continues.' : ' — a complete gallery.'}`);
  }
  if (s.trackCount > 0 && s.artistCount > 0) {
    const avg = (s.trackCount / s.artistCount).toFixed(1);
    out.push(`On average, each artist has ${avg} tracks in your library.`);
  }
  if (s.albumCount > 0 && s.artistCount > 0) {
    const avg = (s.albumCount / s.artistCount).toFixed(2);
    out.push(`That's ${avg} albums per artist across the shelf.`);
  }
  if (s.trackCount > 0 && s.albumCount > 0) {
    const avgTracks = s.trackCount / s.albumCount;
    out.push(`Your average album has ${avgTracks.toFixed(1)} tracks — ${avgTracks > 14 ? 'extended deluxe territory.' : avgTracks > 12 ? 'meaty LPs.' : avgTracks > 8 ? 'classic-length records.' : 'compact EPs-to-LPs.'}`);
  }
  if (s.totalDurationSec > 0 && s.trackCount > 0) {
    const avgTrackSec = s.totalDurationSec / s.trackCount;
    const m = Math.floor(avgTrackSec / 60);
    const sec = Math.round(avgTrackSec % 60);
    out.push(`The average track in your library is ${m}:${sec.toString().padStart(2, '0')} long.`);
  }
  if (s.totalBytes > 0 && s.trackCount > 0) {
    const avgMB = s.totalBytes / s.trackCount / (1024 * 1024);
    if (avgMB >= 50)       out.push(`Average file size: ${avgMB.toFixed(1)} MB — high-resolution audiophile territory.`);
    else if (avgMB >= 20)  out.push(`Average file size: ${avgMB.toFixed(1)} MB — lossless and proud.`);
    else if (avgMB >= 8)   out.push(`Average file size: ${avgMB.toFixed(1)} MB — solid high-bitrate lossy.`);
    else                    out.push(`Average file size: ${avgMB.toFixed(1)} MB — efficiently encoded for maximum collection density.`);
  }
  if (s.artistCount >= 100)  out.push(`${s.artistCount.toLocaleString()} different artists. That's more acts than most music festivals book.`);
  if (s.artistCount >= 500)  out.push(`${s.artistCount.toLocaleString()} artists. You could run your own record label from this catalogue.`);
  if (s.artistCount >= 1000) out.push(`Over a thousand unique artists. Staggering breadth.`);

  // ----- LIBRARY SIZE EQUIVALENTS (silly unit conversions) ------------------
  if (s.totalBytes > 0) {
    const mb = s.totalBytes / (1024 * 1024);
    const gb = mb / 1024;
    const cds = s.totalBytes / (700 * 1024 * 1024);
    if (cds >= 1)  out.push(`Your library would fill ${p(Math.round(cds), 'audio CD')} — one per album cover, clattering onto the floor.`);
    const ipods = s.totalBytes / (5 * 1024 * 1024 * 1024);
    if (ipods >= 1) out.push(`That's ${p(Math.round(ipods), 'first-generation 5 GB iPod', 'first-generation 5 GB iPods')} worth of music.`);
    const floppies = s.totalBytes / (1.44 * 1024 * 1024);
    if (floppies >= 1000) out.push(`Or ${Math.round(floppies).toLocaleString()} floppy disks. Bring a station wagon.`);
    if (floppies >= 10000) out.push(`At 1.44 MB each, a floppy-disk migration would take ${Math.round(floppies).toLocaleString()} disks — a literal pile.`);
    const blurays = s.totalBytes / (50 * 1024 * 1024 * 1024);
    if (blurays >= 1)  out.push(`Or ${p(Math.round(blurays * 10) / 10, 'dual-layer Blu-ray')} of music.`);
    const dvds = s.totalBytes / (4.7 * 1024 * 1024 * 1024);
    if (dvds >= 1)   out.push(`That's about ${p(Math.round(dvds * 10) / 10, 'single-layer DVD')}'s worth of audio.`);
    const minidiscs = s.totalBytes / (177 * 1024 * 1024);
    if (minidiscs >= 5)  out.push(`Or ${Math.round(minidiscs)} MiniDiscs. Sony would be proud.`);
    const cassettes = s.totalDurationSec / (90 * 60);
    if (cassettes >= 5) out.push(`That's enough music for ${Math.round(cassettes)} C-90 mixtapes.`);
    const _8tracks = s.totalDurationSec / (80 * 60);
    if (_8tracks >= 10) out.push(`Or about ${Math.round(_8tracks)} 8-track cartridges if you're feeling retro.`);
    if (mb >= 1400) {
      const cds650 = s.totalBytes / (650 * 1024 * 1024);
      if (cds650 >= 2) out.push(`Classic 650 MB CD-Rs: you'd need ${Math.round(cds650)} of them. Sharpie labels optional.`);
    }
    const zipDisks = s.totalBytes / (250 * 1024 * 1024);
    if (zipDisks >= 10) out.push(`Iomega Zip disks (250 MB): ${Math.round(zipDisks).toLocaleString()}. They'd fit in a shoebox. Barely.`);
    if (gb >= 4) out.push(`${gb.toFixed(1)} GB of music — that's a full ${(gb / 4).toFixed(1)} typical smartphone storage tiers ago.`);
    if (gb >= 32) out.push(`${gb.toFixed(1)} GB. Wouldn't fit on an early-model iPhone storage tier.`);
    if (gb >= 128) out.push(`${gb.toFixed(1)} GB — more music than a base-spec MacBook Air from 2010 had total storage.`);
    if (gb >= 500) out.push(`${gb.toFixed(1)} GB. You could back up a laptop with the leftover space from your music library.`);
    if (gb >= 1024) out.push(`Over a terabyte of music. Dedicated spinning platter territory.`);
    if (gb >= 5 * 1024) out.push(`${(gb/1024).toFixed(1)} TB — you're a digital hoarder and we respect that.`);
    const laserdiscs = s.totalBytes / (4 * 1024 * 1024 * 1024);
    if (laserdiscs >= 1) out.push(`Or around ${Math.round(laserdiscs)} LaserDiscs worth of data. (They'd weigh a ton.)`);
  }

  // ----- LIBRARY DURATION EQUIVALENTS ---------------------------------------
  if (s.totalDurationSec > 3600) {
    const hours = s.totalDurationSec / 3600;
    if (hours >= 2)    out.push(`Or ${p(Math.round(hours / 2), 'back-to-back marathon')} for the elite runners.`);
    if (hours >= 3)    out.push(`Enough to soundtrack ${p(Math.round(hours / 3), 'three-hour flight')}.`);
    if (hours >= 6)    out.push(`You could fly NYC → LA ${p(Math.round(hours / 6), 'time', 'times')} without hitting the end.`);
    if (hours >= 8)    out.push(`Playing it straight through, you'd sleep about ${p(Math.round(hours / 8), 'night')} to the sound of your own library.`);
    if (hours >= 11.5) out.push(`You could watch the Lord of the Rings extended trilogy ${p(Math.round(hours / 11.5), 'time', 'times')} and still have music left.`);
    if (hours >= 15)   out.push(`Wagner's full Ring cycle runs ~15 h. You could sit through it ${(hours/15).toFixed(1)} times back to back.`);
    if (hours >= 24)   out.push(`${(hours/24).toFixed(1)} full Earth rotations of music has passed through this library.`);
    if (hours >= 40)   out.push(`That's ${p(Math.round(hours / 40), 'full work week')} of non-stop music.`);
    if (hours >= 100)  out.push(`Over 100 hours. You could go full radio-station format and not repeat for days.`);
    if (hours >= 168)  out.push(`More than a week's worth of continuous audio. Take a break, go outside.`);
    if (hours >= 500)  out.push(`${Math.round(hours)} hours total runtime — that's over 20 straight days of music with no breaks.`);
    if (hours >= 2000) out.push(`Over ${Math.round(hours).toLocaleString()} hours. You could launch a lifestyle radio station from this collection.`);
  }

  // ----- YEAR / DECADE ANALYSIS ---------------------------------------------
  if (s.newestYear != null) {
    if (s.newestYear === year) out.push(`Your newest album is from ${s.newestYear} — fresh off the press.`);
    else if (year - s.newestYear <= 2) out.push(`Your newest album is from ${s.newestYear} — recent enough to feel current.`);
  }
  if (s.oldestYear != null) {
    const age = year - s.oldestYear;
    if (age > 50) out.push(`Your oldest album is from ${s.oldestYear} — that's ${age} years of music history in your library.`);
    if (age > 80) out.push(`Something in here predates most of your family. (${s.oldestYear}!)`);
    if (s.oldestYear < 1960) out.push(`You've got audio from before The Beatles formed (${s.oldestYear}). Serious archival energy.`);
    if (s.oldestYear < 1950) out.push(`Pre-1950 material in the library. Genuine crackle territory.`);
    if (s.oldestYear < 1930) out.push(`${s.oldestYear}? That's practically phonograph era.`);
  }
  if (s.oldestYear && s.newestYear) {
    const spanDecades = Math.floor(s.newestYear / 10) - Math.floor(s.oldestYear / 10) + 1;
    if (spanDecades >= 3) out.push(`Your music crosses ${spanDecades} different decades. Time-travel playlist material.`);
    if (spanDecades >= 7) out.push(`${spanDecades} decades on the shelves. You've got an honest history of recorded music.`);
  }

  if (n) {
    // Decade distribution — per-decade share
    const total = n.decadeDistribution.reduce((sum, d) => sum + d.trackCount, 0);
    if (total > 0) {
      // Sort by count descending for "top decade" fact
      const byCount = [...n.decadeDistribution].sort((a, b) => b.trackCount - a.trackCount);
      const top = byCount[0];
      if (top && top.trackCount > 0) {
        const pct = Math.round((top.trackCount / total) * 100);
        out.push(`${pct}% of your library comes from the ${top.decade} — your dominant era.`);
      }
      const second = byCount[1];
      if (top && second && second.trackCount > 0) {
        out.push(`Top two decades in your library: ${top.decade} and ${second.decade}.`);
      }
      // Per-decade counts for the big ones
      for (const d of byCount.slice(0, 4)) {
        if (d.trackCount >= 20) {
          const pct = Math.round((d.trackCount / total) * 100);
          out.push(`${d.decade}: ${p(d.trackCount, 'track')} (${pct}%) in your collection.`);
        }
      }
      // Size-weighted decade facts
      const bySize = [...n.decadeDistribution].sort((a, b) => b.bytes - a.bytes);
      if (bySize[0] && bySize[0].bytes > 0) {
        out.push(`The ${bySize[0].decade} occupies the most disk space: ${formatBytes(bySize[0].bytes)}.`);
      }
    }

    // Which decade do you actually listen to?
    if (n.decadePlayDistribution.length > 0 && n.decadePlayDistribution[0].playCount > 0) {
      const top = n.decadePlayDistribution[0];
      out.push(`Your most-played decade: the ${top.decade} — ${p(top.playCount, 'play')} logged.`);
      if (n.decadePlayDistribution.length > 1 && n.decadePlayDistribution[1].playCount > 0) {
        out.push(`Runner-up played decade: the ${n.decadePlayDistribution[1].decade}.`);
      }
    }

    if (n.avgPlayedYear != null) {
      const rounded = Math.round(n.avgPlayedYear);
      out.push(`Weighted by play count, your "listening centre of gravity" sits in ${rounded}.`);
      const fromNow = year - rounded;
      if (fromNow >= 20) out.push(`Your average played year is ${fromNow} years in the past. Retro default mode.`);
      else if (fromNow <= 5) out.push(`Your average played year is within 5 years of today — you follow new releases.`);
    }
    if (n.tracksAddedThisYear > 0) {
      out.push(`You've added ${p(n.tracksAddedThisYear, 'track')} to your library this year alone.`);
    }
  }

  // ----- FORMAT / CODEC -----------------------------------------------------
  if (n) {
    const codecs = Object.entries(n.codecDistribution).filter(([_, c]) => c > 0);
    if (codecs.length > 0) {
      codecs.sort((a, b) => b[1] - a[1]);
      const top = codecs[0];
      const total = codecs.reduce((sum, [, c]) => sum + c, 0);
      if (top && total > 0) {
        const pct = Math.round((top[1] / total) * 100);
        out.push(`${pct}% of your library is ${top[0].toUpperCase()}.`);
        out.push(`Top format in rotation: ${top[0].toUpperCase()} (${p(top[1], 'track')}).`);
      }
      if (codecs.length >= 3) {
        out.push(`Your library mixes ${codecs.length} different audio codecs. Format-agnostic.`);
      }
    }
    const totalWithBitrate = n.bitrateTiers.lossless + n.bitrateTiers.highMp3 + n.bitrateTiers.stdMp3 + n.bitrateTiers.lowMp3;
    if (totalWithBitrate > 0) {
      if (n.bitrateTiers.lossless > 0) {
        const pct = Math.round((n.bitrateTiers.lossless / totalWithBitrate) * 100);
        out.push(`${pct}% lossless — ${p(n.bitrateTiers.lossless, 'track')} you'd trust to a reference listen.`);
      }
      if (n.bitrateTiers.highMp3 > 0) {
        out.push(`${p(n.bitrateTiers.highMp3, 'lossy track')} at 256 kbps or higher. Proper high-bitrate encoding.`);
      }
      if (n.bitrateTiers.lowMp3 > 0 && n.bitrateTiers.lowMp3 < totalWithBitrate * 0.1) {
        out.push(`Only ${p(n.bitrateTiers.lowMp3, 'track')} below 192 kbps. Quality bar respected.`);
      }
      if (n.bitrateTiers.lowMp3 > totalWithBitrate * 0.3) {
        out.push(`${p(n.bitrateTiers.lowMp3, 'track')} are below 192 kbps. Room to upgrade if you want.`);
      }
      if (n.bitrateTiers.lossless > totalWithBitrate * 0.5) {
        out.push(`More than half your library is lossless. Audiophile in residence.`);
      }
    }
    if (n.avgBitrateKbps > 0) {
      out.push(`Average bitrate across your lossy tracks: ${n.avgBitrateKbps} kbps.`);
      if (n.avgBitrateKbps >= 280) out.push(`${n.avgBitrateKbps} kbps average — you're encoding like it's an archive, not a player.`);
      else if (n.avgBitrateKbps >= 220) out.push(`${n.avgBitrateKbps} kbps average. Good transparent-quality zone.`);
      else if (n.avgBitrateKbps < 160 && n.avgBitrateKbps > 0) out.push(`${n.avgBitrateKbps} kbps average. Legacy collection vibes.`);
    }
    // Fun codec callouts
    if (n.codecDistribution['wma'] && n.codecDistribution['wma'] > 0) {
      out.push(`${p(n.codecDistribution['wma'], 'WMA track')}. A Windows Media memento.`);
    }
    if (n.codecDistribution['opus'] && n.codecDistribution['opus'] > 0) {
      out.push(`${p(n.codecDistribution['opus'], 'Opus track')}. Modern codec choice, respect.`);
    }
    if (n.codecDistribution['ogg'] && n.codecDistribution['ogg'] > 0) {
      out.push(`${p(n.codecDistribution['ogg'], 'OGG Vorbis track')}. Open-source soldier.`);
    }
  }

  // ----- PLAY HISTORY (StatsOverview-gated) ---------------------------------
  if (o && o.totalPlays > 0) {
    out.push(`You've played ${o.totalPlays.toLocaleString()} tracks for a total of ${formatDuration(o.totalListenedSec)}.`);
    if (o.totalPlays >= 1000) out.push(`Over 1,000 track plays logged. You're a regular.`);
    if (o.totalPlays >= 10000) out.push(`Five figures of plays. Serious commitment.`);
    if (o.listenedTodaySec > 60) out.push(`Listened today: ${formatDuration(o.listenedTodaySec)}.`);
    if (o.listenedThisWeekSec > 60) out.push(`This week: ${formatDuration(o.listenedThisWeekSec)} of music.`);
    if (o.listenedThisMonthSec > 60) out.push(`This month: ${formatDuration(o.listenedThisMonthSec)} listened.`);
    if (o.listenedThisYearSec > 60) out.push(`So far this year: ${formatDuration(o.listenedThisYearSec)}.`);
    if (o.listenedLast30DaysSec > 60) out.push(`In the last 30 days you logged ${formatDuration(o.listenedLast30DaysSec)} of listening.`);
    if (o.listenedLast7DaysSec > 60) out.push(`Last 7 days: ${formatDuration(o.listenedLast7DaysSec)}.`);

    // Averages / streaks
    if (o.activeDayCount >= 2) {
      out.push(`You average ${formatDuration(o.avgDailyListenedSec)} per active day over ${o.activeDayCount} distinct days.`);
    }
    if (o.activeDayCount >= 30) out.push(`${o.activeDayCount} distinct days with logged listening. A music life.`);
    if (o.activeDayCount >= 365) out.push(`${o.activeDayCount} active listening days — the equivalent of a calendar year spread across your history.`);
    if (o.currentStreakDays > 1) out.push(`You're on a ${o.currentStreakDays}-day listening streak 🔥`);
    if (o.currentStreakDays >= 7)  out.push(`A full week of daily music — ${o.currentStreakDays >= 30 ? 'you\'ve built a habit.' : 'keep it rolling.'}`);
    if (o.currentStreakDays >= 30) out.push(`${o.currentStreakDays} consecutive days. That's a full month without a silent day.`);
    if (o.currentStreakDays >= 100) out.push(`${o.currentStreakDays} consecutive days of listening. Dedication.`);
    if (o.currentStreakDays >= 365) out.push(`A YEAR-long streak. What are you, a radio station?`);
    if (o.longestStreakDays > o.currentStreakDays && o.longestStreakDays > 1) {
      out.push(`Your longest listening streak so far: ${o.longestStreakDays} consecutive days.`);
    }

    // Time of day
    if (o.mostActiveHour != null) {
      out.push(`Your most musical hour of the day is ${formatHour(o.mostActiveHour)}.`);
      if (o.mostActiveHour >= 0 && o.mostActiveHour < 5)   out.push(`Peak listening: ${formatHour(o.mostActiveHour)}. Night owl tendencies confirmed.`);
      else if (o.mostActiveHour >= 5 && o.mostActiveHour < 9)   out.push(`Peak listening: ${formatHour(o.mostActiveHour)}. Morning person with impeccable taste.`);
      else if (o.mostActiveHour >= 9 && o.mostActiveHour < 12)  out.push(`Peak listening: ${formatHour(o.mostActiveHour)}. Morning work-session soundtrack.`);
      else if (o.mostActiveHour >= 12 && o.mostActiveHour < 17) out.push(`Peak listening: ${formatHour(o.mostActiveHour)}. Afternoon productivity playlist life.`);
      else if (o.mostActiveHour >= 17 && o.mostActiveHour < 21) out.push(`Peak listening: ${formatHour(o.mostActiveHour)}. Evening chill-out window.`);
      else                                                       out.push(`Peak listening: ${formatHour(o.mostActiveHour)}. Deep night listening warrior.`);
    }
    if (o.mostActiveDayOfWeek != null) {
      out.push(`${DOW_NAMES[o.mostActiveDayOfWeek]} is your biggest listening day of the week.`);
    }

    // Hour histogram insights
    if (o.hourHistogram && o.hourHistogram.length === 24) {
      const night = o.hourHistogram.slice(0, 6).reduce((n, v) => n + v, 0);
      const morn  = o.hourHistogram.slice(6, 12).reduce((n, v) => n + v, 0);
      const aft   = o.hourHistogram.slice(12, 18).reduce((n, v) => n + v, 0);
      const eve   = o.hourHistogram.slice(18, 24).reduce((n, v) => n + v, 0);
      const totalHist = night + morn + aft + eve;
      if (totalHist > 600) {
        const lab = [['night (midnight-6)', night], ['morning (6am-noon)', morn], ['afternoon (noon-6pm)', aft], ['evening (6pm-midnight)', eve]] as const;
        const sorted = [...lab].sort((a, b) => b[1] - a[1]);
        out.push(`Your biggest listening slice lands in the ${sorted[0][0]}.`);
        const nightPct = Math.round((night / totalHist) * 100);
        if (nightPct > 25) out.push(`${nightPct}% of your listening happens between midnight and 6am. Noir playlist energy.`);
      }
    }

    // Day-of-week insights
    if (o.dayOfWeekHistogram && o.dayOfWeekHistogram.length === 7) {
      const weekend = o.dayOfWeekHistogram[0] + o.dayOfWeekHistogram[6];
      const weekday = o.dayOfWeekHistogram.slice(1, 6).reduce((n, v) => n + v, 0);
      const wdAvg = weekday / 5;
      const weAvg = weekend / 2;
      if (wdAvg > weAvg * 1.5)      out.push(`Weekdays see ~${(wdAvg / Math.max(1, weAvg)).toFixed(1)}× more music than weekends. Office soundtrack life.`);
      else if (weAvg > wdAvg * 1.5) out.push(`Weekends get ~${(weAvg / Math.max(1, wdAvg)).toFixed(1)}× more listening time than weekdays. Saturday vibes.`);
      // Specific lightest day
      let minI = 0, minV = Infinity;
      o.dayOfWeekHistogram.forEach((v, i) => { if (v < minV) { minV = v; minI = i; } });
      if (minV < wdAvg * 0.3 && minV > 0) out.push(`${DOW_NAMES[minI]} is your quietest music day. Mid-week silence?`);
    }

    // Top items
    if (o.topTracks[0]) {
      const t = o.topTracks[0];
      out.push(`Your most-played track: "${t.title}" by ${t.artist ?? 'Unknown'} — ${p(t.playCount, 'play')}.`);
    }
    if (o.topTracks[1]) {
      const t = o.topTracks[1];
      out.push(`#2 in the rotation: "${t.title}" by ${t.artist ?? 'Unknown'} (${p(t.playCount, 'play')}).`);
    }
    if (o.topTracks[2]) {
      const t = o.topTracks[2];
      out.push(`Third favourite: "${t.title}" by ${t.artist ?? 'Unknown'}.`);
    }
    if (o.topTracks.length >= 2) {
      const t1 = o.topTracks[0], t2 = o.topTracks[1];
      if (t1.playCount > t2.playCount * 2) {
        out.push(`"${t1.title}" dominates — ${t1.playCount}× vs ${t2.playCount}× for your #2. Obsessed much?`);
      }
      if (t1.playCount > t2.playCount * 5) {
        out.push(`"${t1.title}" is more than 5× ahead of your #2 track. That's full-on hyperfixation territory.`);
      }
    }
    if (o.topTracks[0] && o.topTracks[0].playCount >= 10) {
      const approxMin = o.topTracks[0].playCount * 3.5;
      if (approxMin >= 60) {
        const hours = (approxMin / 60).toFixed(1);
        out.push(`You've put roughly ${hours} hours into "${o.topTracks[0].title}" alone.`);
      }
    }
    if (o.topArtists[0]) {
      const a = o.topArtists[0];
      out.push(`Top artist on rotation: ${a.name} (${formatDuration(a.listenedSec)} listened).`);
      out.push(`${a.name} dominates your play history with ${p(a.playCount, 'total play')}.`);
    }
    if (o.topArtists[1]) out.push(`Second-most-played artist: ${o.topArtists[1].name}.`);
    if (o.topArtists[2]) out.push(`Third-most-played artist: ${o.topArtists[2].name}.`);
    if (o.topArtists.length >= 5) {
      const top5Sec = o.topArtists.slice(0, 5).reduce((n, a) => n + a.listenedSec, 0);
      const pct = o.totalListenedSec > 0 ? Math.round((top5Sec / o.totalListenedSec) * 100) : 0;
      if (pct > 0) out.push(`Your top 5 artists account for ${pct}% of all listening.`);
    }
    if (o.topAlbums[0]) {
      out.push(`Your go-to album is "${o.topAlbums[0].title}" by ${o.topAlbums[0].artist ?? 'Unknown'}.`);
    }
    if (o.topAlbums[1]) {
      out.push(`Second-favourite album: "${o.topAlbums[1].title}".`);
    }
    if (o.topGenres[0]) {
      out.push(`You've played ${o.topGenres[0].genre} the most — ${p(o.topGenres[0].playCount, 'track play')}.`);
    }
    if (o.topGenres[1]) {
      out.push(`Second-most-played genre: ${o.topGenres[1].genre}.`);
    }

    // Discovery / diversity
    if (o.uniqueArtistsPlayed > 0) {
      out.push(`You've played music from ${p(o.uniqueArtistsPlayed, 'different artist')}.`);
    }
    if (o.uniqueAlbumsPlayed > 0) {
      out.push(`${p(o.uniqueAlbumsPlayed, 'distinct album')} have spun under your watch.`);
    }
    if (o.uniqueTracksPlayed > 0 && s.trackCount > 0) {
      const pct = Math.round((o.uniqueTracksPlayed / s.trackCount) * 100);
      out.push(`You've sampled ${pct}% of your library (${o.uniqueTracksPlayed.toLocaleString()} / ${s.trackCount.toLocaleString()} tracks).`);
      if (pct < 20) out.push(`Only ${pct}% of your library has ever played here. A lot of unexplored territory.`);
      if (pct >= 90) out.push(`You've touched ${pct}% of your library. Completionist streak.`);
    }
    if (o.uniqueArtistsPlayed > 0 && s.artistCount > 0) {
      const unplayed = s.artistCount - o.uniqueArtistsPlayed;
      if (unplayed > 0) out.push(`You haven't played a single track from ${p(unplayed, 'artist')} in your library. Rediscovery time?`);
      if (unplayed > 100) out.push(`${p(unplayed, 'artist')} in your library have never been played here. That's a whole afternoon of discovery.`);
    }
    if (o.uniqueTracksPlayed > 0 && s.trackCount > 0) {
      const unplayed = s.trackCount - o.uniqueTracksPlayed;
      if (unplayed > 50)  out.push(`${p(unplayed, 'track')} in your collection have never been played here. Treasure hunt?`);
      if (unplayed > 500) out.push(`${unplayed.toLocaleString()} unplayed tracks. Cold storage.`);
    }

    // Sessions
    if (o.longestSessionSec > 600) {
      out.push(`Your longest continuous listening session: ${formatDuration(o.longestSessionSec)}.`);
    }
    if (o.longestSessionSec >= 3 * 3600) {
      out.push(`Your longest unbroken session: ${formatDuration(o.longestSessionSec)}. Someone was in the zone.`);
    }
    if (o.longestSessionSec >= 8 * 3600) {
      out.push(`Your longest listening session was over 8 hours — a full workday.`);
    }
    if (o.sessionCount >= 2) {
      out.push(`You've had ${o.sessionCount.toLocaleString()} listening sessions, averaging ${formatDuration(o.avgSessionSec)} each.`);
    }
    if (o.sessionCount >= 100) out.push(`${o.sessionCount.toLocaleString()} distinct sessions logged. You come back to this app a lot.`);

    // Biggest day
    if (o.mostPlayedDay && o.mostPlayedDay.sec > 600) {
      out.push(`Your biggest single listening day was ${o.mostPlayedDay.date}: ${formatDuration(o.mostPlayedDay.sec)}.`);
    }
    if (o.mostPlayedDay && o.mostPlayedDay.sec >= 6 * 3600) {
      const h = (o.mostPlayedDay.sec / 3600).toFixed(1);
      out.push(`Your heaviest listening day hit ${h} hours on ${o.mostPlayedDay.date}. What were you doing?`);
    }
    if (o.mostPlayedDay && o.mostPlayedDay.sec >= 12 * 3600) {
      out.push(`Over 12 hours of music on a single day — that's literally more than half a day of non-stop audio.`);
    }

    // Firsts
    if (o.firstPlayedTrack && o.firstPlayAt) {
      const when = new Date(o.firstPlayAt).toLocaleDateString();
      out.push(`The first track you ever played here: "${o.firstPlayedTrack.title}" on ${when}.`);
    }
    if (o.firstPlayAt) {
      const daysAgo = Math.round((Date.now() - o.firstPlayAt) / 86_400_000);
      if (daysAgo >= 30)  out.push(`You've been listening through this app for ${daysAgo} days.`);
      if (daysAgo >= 365) out.push(`It's been ${Math.floor(daysAgo / 365)}+ years since your first play here.`);
    }

    // Listening time equivalents
    const hours = o.totalListenedSec / 3600;
    if (hours >= 1) {
      const books = Math.floor(hours / 5.3);
      if (books >= 1)  out.push(`If you'd been reading instead, you could've finished about ${p(books, 'novel')} in that time.`);
      const movies = Math.floor(hours / 2);
      if (movies >= 1) out.push(`That's enough time to watch ${p(movies, 'feature-length film')} back to back.`);
      const flights = Math.floor(hours / 6);
      if (flights >= 1) out.push(`You could have flown NYC→LA ${p(flights, 'time', 'times')} while listening to all that.`);
      const miles = hours * 3;
      if (miles >= 5)  out.push(`At a casual walking pace, you'd have covered ${Math.round(miles).toLocaleString()} miles.`);
      const earthDays = hours / 24;
      if (earthDays >= 1) out.push(`${earthDays.toFixed(1)} full Earth rotations worth of music has passed through your speakers.`);
      const workdays = Math.floor(hours / 8);
      if (workdays >= 5) out.push(`You've logged ${p(workdays, 'workday')} of listening — essentially a second job.`);
      const dsotm = Math.floor(o.totalListenedSec / (43 * 60));
      if (dsotm >= 10) out.push(`That's ${dsotm.toLocaleString()} full spins of Dark Side of the Moon's runtime.`);
      const rings = hours / 15;
      if (rings >= 1)  out.push(`You could've sat through Wagner's Ring cycle ${p(Math.round(rings * 10) / 10, 'time', 'times')}.`);
      const beethoven5 = Math.floor(o.totalListenedSec / (31 * 60));  // Beethoven's 5th ≈ 31min
      if (beethoven5 >= 10) out.push(`Or ${beethoven5.toLocaleString()} full performances of Beethoven's 5th.`);
      const bohemian = Math.floor(o.totalListenedSec / 355);  // Bohemian Rhapsody 5:55
      if (bohemian >= 50) out.push(`That's ${bohemian.toLocaleString()} Bohemian Rhapsodies. Just a little silhouetto of a man.`);
      const stairway = Math.floor(o.totalListenedSec / 482);  // Stairway 8:02
      if (stairway >= 30) out.push(`Or ${stairway.toLocaleString()} full climbs of Stairway to Heaven.`);
      // World's shortest national anthem: Uruguay, ~6 min — the longest
      const anthems = Math.floor(hours * 20);  // avg national anthem ~3 min
      if (anthems >= 100) out.push(`Enough time for ${anthems.toLocaleString()} national anthems (average ~3 minutes each).`);
      const daysEquiv = hours / 24;
      if (daysEquiv >= 7) out.push(`A solid ${daysEquiv.toFixed(1)} full days of music — longer than most vacations.`);
    }

    if (o.activeDayCount >= 3 && o.avgDailyListenedSec >= 60) {
      const avgHour = o.avgDailyListenedSec / 3600;
      if (avgHour >= 8)      out.push(`On an active day you log ${avgHour.toFixed(1)}+ hours of music — basically a full workday in headphones.`);
      else if (avgHour >= 3) out.push(`Your active-day average is ${avgHour.toFixed(1)} hours — long commute, long work session, or very dedicated chore playlist.`);
      else if (avgHour >= 1) out.push(`You listen about ${avgHour.toFixed(1)} hours per active day. Regular dosage.`);
    }
    if (o.totalPlays > 0 && o.activeDayCount >= 2) {
      const playsPerActiveDay = o.totalPlays / o.activeDayCount;
      out.push(`On the days you listen, you average ${playsPerActiveDay.toFixed(1)} tracks played.`);
    }

    // Repeat behavior
    if (o.uniqueTracksPlayed > 0 && o.totalPlays > 0) {
      const repeat = o.totalPlays / o.uniqueTracksPlayed;
      if (repeat >= 3)                  out.push(`You replay tracks ${repeat.toFixed(1)}× on average — you know what you like.`);
      else if (repeat < 1.5 && o.totalPlays >= 50) out.push(`You rarely replay tracks (${repeat.toFixed(1)}× avg). Always exploring?`);
      else if (repeat < 2)              out.push(`Your replay ratio is ${repeat.toFixed(1)}× — a good mix of new and familiar.`);
    }

    // Like analytics cross-referenced
    if (o.totalPlays >= 100 && s.likedCount > 0 && s.trackCount > 0) {
      const likePct = (s.likedCount / s.trackCount) * 100;
      if (likePct < 2)       out.push(`Only ${likePct.toFixed(1)}% of your library is liked — a tough critic.`);
      else if (likePct > 30) out.push(`${likePct.toFixed(0)}% of your library is liked — you love generously.`);
    }
  }

  // ----- NEATSTATS-POWERED EXTRAS -------------------------------------------
  if (n) {
    // Prolific artists
    if (n.mostProlificArtistsByTracks[0]) {
      const top = n.mostProlificArtistsByTracks[0];
      out.push(`Artist with the most tracks in your library: ${top.name} (${p(top.trackCount, 'track')}).`);
    }
    if (n.mostProlificArtistsByTracks[1]) out.push(`Second-most-represented artist: ${n.mostProlificArtistsByTracks[1].name}.`);
    if (n.mostProlificArtistsByAlbums[0]) {
      const top = n.mostProlificArtistsByAlbums[0];
      out.push(`Artist with the most albums shelved: ${top.name} (${p(top.albumCount, 'album')}).`);
    }
    if (n.mostProlificArtistsByAlbums[0] && n.mostProlificArtistsByAlbums[0].albumCount >= 10) {
      out.push(`You've got the full discography energy for ${n.mostProlificArtistsByAlbums[0].name} — ${n.mostProlificArtistsByAlbums[0].albumCount} albums.`);
    }

    // Long tail
    if (n.singleTrackArtistCount > 0) {
      out.push(`${p(n.singleTrackArtistCount, 'artist')} in your library are represented by exactly one track.`);
    }
    if (n.singleTrackArtistCount > 50) {
      out.push(`${n.singleTrackArtistCount.toLocaleString()} one-hit-wonder entries. Long tail in full effect.`);
    }
    if (n.shortAlbumCount > 0) {
      out.push(`${p(n.shortAlbumCount, 'short album/EP')} (1-2 tracks) in the collection.`);
    }
    if (n.fullyHeardAlbumCount > 0) {
      out.push(`You've listened to every track of ${p(n.fullyHeardAlbumCount, 'album')} at least once.`);
    }
    if (n.unheardAlbumCount > 0) {
      out.push(`${p(n.unheardAlbumCount, 'album')} haven't been touched yet — dinner music in waiting.`);
    }
    if (n.untouchedTrackCount > 0) {
      out.push(`${p(n.untouchedTrackCount, 'track')} have never been played AND never been liked. Pure background mass.`);
    }

    // Titles
    if (n.longestTitle && n.longestTitle.length >= 30) {
      out.push(`Your longest track title: "${n.longestTitle.title}" (${n.longestTitle.length} characters).`);
    }
    if (n.shortestTitle && n.shortestTitle.length <= 3) {
      out.push(`Your shortest title is "${n.shortestTitle.title}" — ${n.shortestTitle.length} character${n.shortestTitle.length === 1 ? '' : 's'}.`);
    }
    if (n.mostCommonTitleWord && n.mostCommonTitleWord.count >= 3) {
      out.push(`The most common word in your track titles: "${n.mostCommonTitleWord.word}" (${n.mostCommonTitleWord.count}×).`);
    }

    // Liked
    if (n.likedRuntimeSec > 0) {
      out.push(`Liked tracks total runtime: ${formatDuration(n.likedRuntimeSec)}.`);
    }
    if (n.likedNeverPlayed > 0) {
      out.push(`${p(n.likedNeverPlayed, 'liked track')} have never been played in this app. Curated but dormant.`);
    }
    if (n.likedAvgPlayCount >= 1) {
      out.push(`Liked tracks get played ${n.likedAvgPlayCount.toFixed(1)}× on average.`);
    }
    if (n.likedAvgPlayCount >= 5) {
      out.push(`You really commit to your likes — average ${n.likedAvgPlayCount.toFixed(1)} plays each.`);
    }

    // Completion / skipping
    if (n.totalPlayEvents >= 20) {
      const pct = Math.round(n.completionRate * 100);
      if (pct >= 80) out.push(`You finish ${pct}% of the tracks you start. Deliberate listener.`);
      else if (pct <= 40) out.push(`Only ${pct}% of started tracks play to completion. Skippy fingers.`);
      else out.push(`Completion rate: ${pct}% of started tracks play all the way through.`);
    }

    // Genre focus
    if (n.topGenrePlayShare >= 0.4) {
      const pct = Math.round(n.topGenrePlayShare * 100);
      out.push(`${pct}% of your plays are in a single genre. Focused listener.`);
    } else if (n.topGenrePlayShare > 0 && n.topGenrePlayShare < 0.15) {
      out.push(`Your top genre makes up less than 15% of plays — genuinely eclectic.`);
    }

    // Median vs average
    if (n.medianPlayCount >= 1) {
      out.push(`The median played track has been spun ${n.medianPlayCount.toFixed(1)}×.`);
    }

    // Estimated data moved
    if (n.estimatedPlaybackBytes > 0) {
      out.push(`Estimated ${formatBytes(n.estimatedPlaybackBytes)} of audio has streamed from disk during your playback.`);
      const cds = n.estimatedPlaybackBytes / (700 * 1024 * 1024);
      if (cds >= 1) out.push(`That's the equivalent of reading ${p(Math.round(cds), 'audio CD')} off disk.`);
    }

    // Most-listened album (by time)
    if (n.mostListenedAlbum) {
      out.push(`Most-listened album by total time: "${n.mostListenedAlbum.title}" — ${formatDuration(n.mostListenedAlbum.listenedSec)} on the clock.`);
    }

    // Calendar breadth
    if (n.activeMonthCount > 1) {
      out.push(`You've had listening activity in ${p(n.activeMonthCount, 'distinct month')}.`);
    }
    if (n.activeYearCount > 1) {
      out.push(`Your listening history spans ${p(n.activeYearCount, 'calendar year')}.`);
    }
    if (n.firstPlayDate) {
      const d = new Date(n.firstPlayDate);
      out.push(`First logged play: ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}.`);
    }

    // Longest session alt phrasings
    if (n.longestSessionSec >= 6 * 3600) {
      out.push(`Your longest single session: ${formatDuration(n.longestSessionSec)} of continuous listening.`);
    }
  }

  // ----- META -------------------------------------------------------------
  // Playlist-curation facts
  if (s.playlistCount > 0 && s.trackCount > 0) {
    out.push(`You've curated ${p(s.playlistCount, 'playlist')} across your ${s.trackCount.toLocaleString()}-track library.`);
  }
  if (s.playlistCount >= 10) {
    out.push(`${s.playlistCount} playlists. Somebody's a librarian.`);
  }
  if (s.likedCount >= 100) {
    const likedPct = s.trackCount > 0 ? Math.round((s.likedCount / s.trackCount) * 100) : 0;
    if (likedPct > 0) out.push(`${s.likedCount.toLocaleString()} liked tracks — ${likedPct}% of the library has earned a ♥.`);
  }

  return out;
}
