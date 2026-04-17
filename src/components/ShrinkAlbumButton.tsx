import { useEffect, useState } from 'react';
import type { ConvertProgress } from '../../shared/types';
import { formatBytes } from '../hooks/useScanProgress';

interface Props {
  albumId: number;
  albumTitle: string;
  flacCount: number;
  bytes: number;
}

/**
 * Button that offers to convert all FLAC tracks on an album to MP3 (archival V0
 * by default, set in Settings) and remove the originals after verification.
 *
 * Runs through the convert:* IPC family. Progress events draw an inline bar.
 */
export default function ShrinkAlbumButton({ albumId, albumTitle, flacCount, bytes }: Props) {
  const [progress, setProgress] = useState<ConvertProgress | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [available, setAvailable] = useState(true);
  const isBusy = progress != null &&
    progress.phase !== 'idle' && progress.phase !== 'done' && progress.phase !== 'error';

  useEffect(() => {
    window.mp.convert.checkAvailable().then((r: any) => setAvailable(!!r?.available));
    const off = window.mp.convert.onProgress((p: any) => {
      // Only reflect progress for OUR album (other buttons might be mounted).
      if (p?.albumId === albumId) setProgress(p);
    });
    return () => { off?.(); };
  }, [albumId]);

  async function start() {
    setConfirming(false);
    setProgress({
      phase: 'starting', albumId, tracksTotal: flacCount, tracksDone: 0,
      currentFile: null, bytesBefore: bytes, bytesAfter: 0, message: 'Starting…',
    });
    const res: any = await window.mp.convert.albumToMp3(albumId);
    if (res?.ok === false && res?.error) {
      setProgress({
        phase: 'error', albumId, tracksTotal: flacCount, tracksDone: 0,
        currentFile: null, bytesBefore: bytes, bytesAfter: 0, message: res.error,
      });
    }
    // Fire library refresh so lists update with new codec/sizes/paths.
    window.dispatchEvent(new CustomEvent('mp-library-changed'));
  }

  if (flacCount === 0) return null;

  return (
    <div className="inline-flex flex-col items-start gap-2">
      {!isBusy && (
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

      {progress && (progress.phase === 'starting' || progress.phase === 'converting' || progress.phase === 'verifying' || progress.phase === 'removing-originals') && (
        <ProgressBar p={progress} onCancel={() => window.mp.convert.cancel()} />
      )}

      {progress?.phase === 'done' && (
        <div className="mt-1 text-xs text-accent">✓ {progress.message ?? `Saved ${formatBytes(progress.bytesBefore - progress.bytesAfter)}`}</div>
      )}
      {progress?.phase === 'error' && (
        <div className="mt-1 text-xs text-red-400">✗ {progress.message ?? 'Failed'}</div>
      )}
    </div>
  );
}

function ProgressBar({ p, onCancel }: { p: ConvertProgress; onCancel: () => void }) {
  const pct = p.tracksTotal > 0 ? Math.round((p.tracksDone / p.tracksTotal) * 100) : 0;
  const label = {
    starting: 'Starting…',
    converting: `Encoding track ${p.tracksDone + 1} / ${p.tracksTotal}`,
    verifying: 'Verifying outputs…',
    'removing-originals': 'Removing FLAC originals…',
  }[p.phase as 'starting' | 'converting' | 'verifying' | 'removing-originals'] ?? p.phase;

  return (
    <div className="mt-1 bg-bg-elev-2 border border-white/10 rounded p-2 text-xs w-80">
      <div className="flex items-center gap-2">
        <div className="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <span className="flex-1">{label}</span>
        <button onClick={onCancel} className="text-text-muted hover:text-white">Cancel</button>
      </div>
      <div className="h-1 bg-black/40 rounded mt-2 overflow-hidden">
        <div className="h-full bg-accent transition-all duration-200" style={{ width: `${pct}%` }} />
      </div>
      {p.currentFile && <div className="text-[10px] text-text-muted truncate mt-1">{p.currentFile}</div>}
    </div>
  );
}
