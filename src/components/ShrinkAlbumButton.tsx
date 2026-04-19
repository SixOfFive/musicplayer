import { useEffect, useRef, useState } from 'react';
import { formatBytes } from '../hooks/useScanProgress';
import { useConvert } from '../store/convert';

/**
 * Format a second count as "m:ss" — consistent with how the scrubber renders
 * track time. Guards against NaN / negatives / Infinity; returns `null` so
 * callers can decide to hide the display instead of showing "--:--".
 */
function fmtEta(sec: number): string | null {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

interface Props {
  albumId: number;
  albumTitle: string;
  flacCount: number;
  bytes: number;
}

/**
 * Compact "Shrink album" button. Converts all FLAC tracks on an album to MP3
 * (quality picked in Settings) and removes the originals after verification.
 *
 * Progress state lives in the `useConvert` zustand store, NOT in this
 * component — so navigating away and back keeps the live progress bar in
 * sync with the main-process worker. The bar is a single line to fit the
 * user's "quick glance" goal.
 *
 * The button disappears once conversion succeeds: the library refresh event
 * fires after completion, the parent re-fetches tracks, `flacCount` drops
 * to 0, and the early-return at the top kills the render.
 */
export default function ShrinkAlbumButton({ albumId, albumTitle, flacCount, bytes }: Props) {
  const progress = useConvert((s) => s.byAlbum.get(albumId) ?? null);
  const startedAt = useConvert((s) => s.startedAt.get(albumId) ?? null);
  const clear = useConvert((s) => s.clear);

  const [confirming, setConfirming] = useState(false);
  const [available, setAvailable] = useState(true);
  const isBusy = progress != null &&
    progress.phase !== 'idle' && progress.phase !== 'done' && progress.phase !== 'error';

  useEffect(() => {
    window.mp.convert.checkAvailable().then((r: any) => setAvailable(!!r?.available));
  }, []);

  // Auto-clear terminal states after a grace period so the store doesn't
  // leak Map entries over time. The `done` flash stays visible for ~3s so
  // the user sees the saved-bytes callout before the library refresh
  // unmounts the button.
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!progress) return;
    if (progress.phase === 'done' || progress.phase === 'error') {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(() => clear(albumId), 4000);
    }
    return () => {
      if (clearTimerRef.current) { clearTimeout(clearTimerRef.current); clearTimerRef.current = null; }
    };
  }, [progress, albumId, clear]);

  async function start() {
    setConfirming(false);
    // Seed the store with a 'starting' snapshot so ALL mounted buttons for
    // this album show progress immediately, before the first IPC event.
    useConvert.getState().setProgress({
      phase: 'starting', albumId, tracksTotal: flacCount, tracksDone: 0,
      currentFile: null, bytesBefore: bytes, bytesAfter: 0, message: 'Starting…',
    });
    const res: any = await window.mp.convert.albumToMp3(albumId);
    if (res?.ok === false && res?.error) {
      useConvert.getState().setProgress({
        phase: 'error', albumId, tracksTotal: flacCount, tracksDone: 0,
        currentFile: null, bytesBefore: bytes, bytesAfter: 0, message: res.error,
      });
    }
    // Fire library refresh so lists update with new codec/sizes/paths.
    // The album view remounts with flacCount=0 and this button disappears.
    window.dispatchEvent(new CustomEvent('mp-library-changed'));
  }

  if (flacCount === 0) return null;

  return (
    <div className="inline-flex flex-col items-start gap-2">
      {!isBusy && !progress && (
        <button
          onClick={() => setConfirming(true)}
          disabled={!available}
          className="px-4 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-sm inline-flex items-center gap-2 disabled:opacity-50"
          title={available ? 'Convert FLAC tracks to MP3 to reclaim space' : 'ffmpeg binary not available — reinstall dependencies'}
        >
          🗜  Shrink album
          <span className="text-xs text-text-muted">({flacCount} FLAC · {formatBytes(bytes)})</span>
        </button>
      )}

      {confirming && (
        <div className="mt-1 bg-bg-elev-2 border border-white/10 rounded p-3 text-sm max-w-md">
          <div className="font-medium mb-2">Convert FLAC tracks to MP3?</div>
          <p className="text-xs text-text-muted mb-3">
            Re-encodes {flacCount} FLAC track{flacCount === 1 ? '' : 's'} on <em>{albumTitle}</em> to MP3 (quality picked in Settings).
            Tags and cover art are preserved. Originals move to the system trash only after every new .mp3 is verified.
          </p>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setConfirming(false)} className="px-3 py-1 rounded-full bg-white/5 text-xs">Cancel</button>
            <button onClick={start} className="px-3 py-1 rounded-full bg-accent text-black font-semibold text-xs">Convert</button>
          </div>
        </div>
      )}

      {isBusy && progress && <CompactProgress p={progress} startedAt={startedAt} onCancel={() => window.mp.convert.cancel()} />}

      {progress?.phase === 'done' && (
        <div className="inline-flex items-center gap-2 text-xs text-accent bg-accent/10 border border-accent/30 rounded-full px-3 py-1">
          <span>✓</span>
          <span>Saved {formatBytes(Math.max(0, progress.bytesBefore - progress.bytesAfter))}</span>
        </div>
      )}
      {progress?.phase === 'error' && (
        <div className="inline-flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-full px-3 py-1">
          <span>✗</span>
          <span className="truncate max-w-xs" title={progress.message ?? 'Failed'}>{progress.message ?? 'Failed'}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Single-line conversion indicator. Designed to be glance-able: spinner,
 * tiny track counter, 48px bar, ETA, cancel ✕. Fits in about 240px.
 *
 * ETA is derived from throughput: (tracksRemaining * elapsed / tracksDone).
 * This assumes roughly-equal-sized tracks — fine for most albums, slightly
 * off for compilations where a 9-minute epic mixes with 2-minute cuts.
 * We re-render every 1s via the local `tick` so the countdown updates
 * even when no new IPC progress event is flowing (e.g. partway through
 * a long track).
 */
function CompactProgress({
  p, startedAt, onCancel,
}: {
  p: import('../../shared/types').ConvertProgress;
  startedAt: number | null;
  onCancel: () => void;
}) {
  const pct = p.tracksTotal > 0 ? Math.round((p.tracksDone / p.tracksTotal) * 100) : 0;

  // 1-second ticker so the ETA "ticks down" between actual progress events.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Compute ETA from elapsed wall time vs tracks completed.
  let etaStr: string | null = null;
  if (startedAt && p.tracksDone >= 1 && p.tracksTotal > p.tracksDone && p.phase === 'converting') {
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const secPerTrack = elapsedSec / p.tracksDone;
    const remainingSec = secPerTrack * (p.tracksTotal - p.tracksDone);
    etaStr = fmtEta(remainingSec);
  }

  // Phase-specific short verb. "Shrinking" is friendlier than "Encoding".
  const verb =
    p.phase === 'starting' ? 'Starting'
    : p.phase === 'converting' ? 'Shrinking'
    : p.phase === 'verifying' ? 'Verifying'
    : p.phase === 'removing-originals' ? 'Cleaning up'
    : p.phase;

  // Long-form title used for hover so the one-line readout doesn't drop
  // information the power user might want.
  const fullTitle = [
    `${verb} ${p.tracksDone}/${p.tracksTotal} tracks (${pct}%)`,
    etaStr ? `~${etaStr} remaining` : null,
    p.currentFile ? `Current: ${p.currentFile}` : null,
    p.message ? p.message : null,
  ].filter(Boolean).join('\n');

  return (
    <div
      className="inline-flex items-center gap-2 text-xs bg-bg-elev-2 border border-white/10 rounded-full px-3 py-1"
      title={fullTitle}
    >
      <div className="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin flex-shrink-0" />
      <span className="tabular-nums">{verb} {p.tracksDone}/{p.tracksTotal}</span>
      <div className="h-1 w-12 bg-black/40 rounded-full overflow-hidden flex-shrink-0">
        <div className="h-full bg-accent transition-all duration-200" style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-text-muted">{pct}%</span>
      {etaStr && (
        <span className="tabular-nums text-text-muted" title="Estimated time remaining">~{etaStr}</span>
      )}
      <button
        onClick={onCancel}
        className="text-text-muted hover:text-white ml-1"
        title="Cancel conversion"
        aria-label="Cancel conversion"
      >
        ✕
      </button>
    </div>
  );
}
