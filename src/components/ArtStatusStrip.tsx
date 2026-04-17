import { formatEta, useScanProgress } from '../hooks/useScanProgress';

/**
 * Persistent bottom strip shown whenever the background art-fetch is running.
 * Mounts above the NowPlayingBar so it's visible no matter which view the user
 * is on — Home, Settings, Visualizer, Playlist, etc.
 *
 * Updates at 4Hz because the underlying hook runs its own interval tick.
 */
export default function ArtStatusStrip() {
  const p = useScanProgress();
  if (!p.art?.active) return null;

  const art = p.art;
  const pct = art.albumsTotal > 0 ? Math.round((art.albumsDone / art.albumsTotal) * 100) : 0;

  // Derive a rough per-album ETA from elapsed / albumsDone.
  const perAlbumSec =
    art.albumsDone > 0 && p.phaseElapsedSec > 0 ? p.phaseElapsedSec / art.albumsDone : null;
  const remainingAlbums = Math.max(0, art.albumsTotal - art.albumsDone);
  const etaSec = perAlbumSec != null ? Math.round(remainingAlbums * perAlbumSec) : null;

  return (
    <div className="h-10 bg-purple-950/60 border-t border-purple-500/30 flex items-center px-4 gap-3 text-xs">
      <div className="w-4 h-4 border-2 border-purple-300 border-t-transparent rounded-full animate-spin flex-shrink-0" />
      <div className="flex-shrink-0 font-semibold text-purple-200">Fetching cover art</div>
      <div className="tabular-nums text-text-muted flex-shrink-0">
        {art.albumsDone} / {art.albumsTotal}
        <span className="ml-2 text-white">{pct}%</span>
        {etaSec != null && <span className="ml-3">· ETA {formatEta(etaSec)}</span>}
      </div>
      <div className="flex-1 min-w-0 truncate text-text-muted">
        {art.currentAlbum && <>· {art.currentAlbum}</>}
      </div>
      <div className="w-40 h-1.5 bg-black/40 rounded overflow-hidden flex-shrink-0">
        <div className="h-full bg-purple-400 transition-all duration-150" style={{ width: `${pct}%` }} />
      </div>
      <button
        onClick={() => window.mp.scan.cancel()}
        className="text-text-muted hover:text-white flex-shrink-0 px-2"
        title="Stop art fetch"
      >✕</button>
    </div>
  );
}
