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
        <div className="flex items-center gap-4">
          <button
            onClick={toggleShuffle}
            className={`text-lg transition ${shuffle ? 'text-accent' : 'text-text-secondary hover:text-white'}`}
            title={shuffle ? 'Shuffle on — click to turn off' : 'Shuffle (one-time randomization, keeps current track playing)'}
            aria-label="Shuffle"
          >
            ⇄
            {shuffle && <span className="block w-1 h-1 rounded-full bg-accent mx-auto -mt-1" />}
          </button>
          <button onClick={prev} className="text-text-secondary hover:text-white text-xl" title="Previous">⏮</button>
          <button
            onClick={toggle}
            className="w-9 h-9 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 transition"
          >
            {isPlaying ? '❚❚' : '▶'}
          </button>
          <button onClick={next} className="text-text-secondary hover:text-white text-xl" title="Next">⏭</button>
          <button
            onClick={cycleRepeat}
            className={`text-lg transition ${repeatMode !== 'off' ? 'text-accent' : 'text-text-secondary hover:text-white'}`}
            title={repeatTitle}
            aria-label="Repeat"
          >
            {repeatMode === 'one' ? '🔂' : '🔁'}
            {repeatMode !== 'off' && <span className="block w-1 h-1 rounded-full bg-accent mx-auto -mt-1" />}
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
