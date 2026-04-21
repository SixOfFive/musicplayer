import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LibraryStats, StatsOverview, NeatStats } from '../../shared/types';
import { useLibraryRefresh } from '../hooks/useLibraryRefresh';
import { formatBytes } from '../hooks/useScanProgress';
import { buildFunFacts, formatDuration, shuffleFacts } from '../lib/funFacts';

// Session-stable shuffle seed. Captured ONCE when this module first
// loads — every LibraryStatsPanel mount within the same app session
// uses the same seed, so navigating away and back doesn't reshuffle
// in a way that feels jittery. Fresh seed per app launch, which is
// the "randomised per startup" behaviour the user asked for.
const SESSION_SHUFFLE_SEED = Date.now();

export default function LibraryStatsPanel() {
  const [s, setS] = useState<LibraryStats | null>(null);
  const [o, setO] = useState<StatsOverview | null>(null);
  const [n, setN] = useState<NeatStats | null>(null);
  const [factIndex, setFactIndex] = useState(() => Math.floor(Math.random() * 1000));

  const load = useCallback(() => {
    window.mp.library.stats().then(setS);
    // stats.overview / stats.neat may not exist on older preloads —
    // gracefully ignore so a version skew doesn't blank the panel.
    if (window.mp.stats?.overview) window.mp.stats.overview().then(setO).catch(() => {});
    if ((window.mp as any).stats?.neat) (window.mp as any).stats.neat().then(setN).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  useLibraryRefresh(load);

  // Auto-rotate the fact every 12s, in addition to click-to-cycle.
  useEffect(() => {
    const t = setInterval(() => setFactIndex((i) => i + 1), 12000);
    return () => clearInterval(t);
  }, []);

  // Build the fact catalogue once whenever the underlying stats change,
  // then shuffle with the session-stable seed so the display order is
  // random per app launch but deterministic across re-renders within
  // the session (so click-to-advance walks the same sequence).
  const facts = useMemo(() => {
    if (!s) return [];
    const built = buildFunFacts(s, o, n);
    return shuffleFacts(built, SESSION_SHUFFLE_SEED);
  }, [s, o, n]);

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

      {/* Fun fact banner. Hover reveals the total count so the user can
          see how deep the catalogue goes; click cycles to the next
          (shuffled) fact. */}
      {currentFact && (
        <div
          className="mt-4 p-4 rounded-xl bg-gradient-to-r from-purple-900/40 to-blue-900/30 border border-purple-500/20 flex items-start gap-3 cursor-pointer hover:border-purple-500/40 transition"
          onClick={() => setFactIndex((i) => i + 1)}
          title={`Click for another fact — ${facts.length} possible`}
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
