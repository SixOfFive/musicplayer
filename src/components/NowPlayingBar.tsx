import { usePlayer } from '../store/player';
import { mediaUrl } from '../lib/mediaUrl';

function fmt(sec: number) {
  if (!Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60); const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function NowPlayingBar() {
  const {
    queue, index, isPlaying, toggle, next, prev, position, duration,
    volume, setVolume, seek, likedIds, toggleLike,
    shuffle, toggleShuffle, repeatMode, cycleRepeat,
  } = usePlayer();
  const cur = queue[index];
  const liked = cur ? likedIds.has(cur.id) : false;

  const repeatTitle =
    repeatMode === 'off' ? 'Repeat: off'
    : repeatMode === 'all' ? 'Repeat all'
    : 'Repeat one (current song loops)';

  return (
    <footer className="h-20 bg-bg-elev-1 border-t border-white/5 grid grid-cols-3 items-center px-4">
      <div className="flex items-center gap-3 min-w-0">
        {cur?.coverArtPath ? (
          <img src={mediaUrl(cur.coverArtPath)} className="w-14 h-14 rounded" alt="" />
        ) : (
          <div className="w-14 h-14 rounded bg-bg-highlight" />
        )}
        <div className="min-w-0">
          <div className="text-sm text-text-primary truncate">{cur?.title ?? 'Nothing playing'}</div>
          <div className="text-xs text-text-muted truncate">{cur?.artist ?? ''}</div>
        </div>
        {cur && (
          <button
            onClick={() => toggleLike(cur.id)}
            className={`ml-3 text-lg ${liked ? 'text-accent' : 'text-text-muted hover:text-text-primary'}`}
            title={liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}
          >
            {liked ? '♥' : '♡'}
          </button>
        )}
      </div>

      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center gap-3">
          {/* Shuffle */}
          <button
            onClick={toggleShuffle}
            className={`w-9 h-9 rounded-full flex items-center justify-center transition ${
              shuffle ? 'bg-accent/20 text-accent' : 'text-text-secondary hover:text-white'
            }`}
            title={shuffle ? 'Shuffle: on (one-time randomization; click to turn off)' : 'Shuffle: off'}
            aria-label="Shuffle"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 3h5v5" />
              <path d="M4 20L21 3" />
              <path d="M21 16v5h-5" />
              <path d="M15 15l6 6" />
              <path d="M4 4l5 5" />
            </svg>
          </button>

          <button onClick={prev} className="text-text-secondary hover:text-white text-xl" title="Previous">⏮</button>
          <button
            onClick={toggle}
            className="w-10 h-10 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 transition"
          >
            {isPlaying ? '❚❚' : '▶'}
          </button>
          <button onClick={next} className="text-text-secondary hover:text-white text-xl" title="Next">⏭</button>

          {/* Repeat: always-visible loop glyph, mode badge bottom-right */}
          <button
            onClick={cycleRepeat}
            className={`relative w-9 h-9 rounded-full flex items-center justify-center transition ${
              repeatMode !== 'off' ? 'bg-accent/20 text-accent' : 'text-text-secondary hover:text-white'
            }`}
            title={repeatTitle}
            aria-label="Repeat"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 2l4 4-4 4" />
              <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
              <path d="M7 22l-4-4 4-4" />
              <path d="M21 13v1a4 4 0 0 1-4 4H3" />
            </svg>
            {repeatMode === 'one' && (
              <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-accent text-black text-[10px] leading-none font-black flex items-center justify-center ring-2 ring-bg-elev-1">1</span>
            )}
            {repeatMode === 'all' && (
              <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-accent text-black text-[10px] leading-none font-black flex items-center justify-center ring-2 ring-bg-elev-1">∞</span>
            )}
          </button>
        </div>
        <div className="flex items-center gap-2 w-full max-w-lg text-[11px] text-text-muted">
          <span className="w-10 text-right">{fmt(position)}</span>
          <input
            type="range" min={0} max={duration || 0} step={0.1} value={position}
            onChange={(e) => seek(parseFloat(e.target.value))}
            className="flex-1 accent-accent"
          />
          <span className="w-10">{fmt(duration)}</span>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 text-text-secondary">
        <span className="text-xs">Vol</span>
        <input
          type="range" min={0} max={1} step={0.01} value={volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          className="w-28 accent-accent"
        />
      </div>
    </footer>
  );
}
