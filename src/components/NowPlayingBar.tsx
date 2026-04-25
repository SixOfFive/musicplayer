import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePlayer } from '../store/player';
import { mediaUrl } from '../lib/mediaUrl';
import { parseRadioTitle } from '../lib/parseRadioTitle';
import OutputDevicePicker from './OutputDevicePicker';

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
    radio,
  } = usePlayer();
  const nav = useNavigate();
  const loc = useLocation();
  const cur = queue[index];
  const liked = cur ? likedIds.has(cur.id) : false;
  const isRadio = radio != null;
  const onLyricsView = loc.pathname === '/lyrics';

  // Mirror the lyrics-enabled setting so we can hide the button when
  // the user has fully disabled the feature. Live-poll once on mount;
  // settings changes outside this component require a route revisit
  // to pick up.
  const [lyricsEnabled, setLyricsEnabled] = useState(true);
  const [autoShowLyrics, setAutoShowLyrics] = useState(false);
  useEffect(() => {
    window.mp.settings.get().then((s: any) => {
      setLyricsEnabled(s?.lyrics?.enabled !== false);
      setAutoShowLyrics(!!s?.lyrics?.autoShow);
    }).catch(() => { /* defaults are fine */ });
  }, []);

  // Lyrics-availability tint for the icon. 'cached' or 'disk' →
  // green, 'none' → grey. Re-probes whenever:
  //   - the current track id changes
  //   - the LyricsPanel signals it just saved/cleared lyrics
  //     (window event 'mp-lyrics-changed' with detail.trackId)
  //
  // Cheap IPC (no network), so re-running on every track change is
  // fine. Stale-response guard discards a probe that resolves after
  // the user has navigated to a different track.
  const [lyricsAvail, setLyricsAvail] = useState<'cached' | 'disk' | 'none'>('none');
  useEffect(() => {
    if (!cur || cur.id <= 0 || isRadio || !lyricsEnabled) {
      setLyricsAvail('none');
      return;
    }
    let cancelled = false;
    const requestedId = cur.id;
    (window.mp as any).lyrics.peek(requestedId).then((r: 'cached' | 'disk' | 'none') => {
      if (cancelled) return;
      if (cur.id !== requestedId) return;
      setLyricsAvail(r ?? 'none');
    }).catch(() => { /* fail closed (grey) */ if (!cancelled) setLyricsAvail('none'); });
    // Re-probe when the panel saves / clears.
    const onChange = (e: Event) => {
      const ce = e as CustomEvent<{ trackId?: number }>;
      if (ce.detail?.trackId === requestedId) {
        (window.mp as any).lyrics.peek(requestedId).then((r: 'cached' | 'disk' | 'none') => {
          if (!cancelled && cur.id === requestedId) setLyricsAvail(r ?? 'none');
        }).catch(() => { /* ignore */ });
      }
    };
    window.addEventListener('mp-lyrics-changed', onChange);
    return () => {
      cancelled = true;
      window.removeEventListener('mp-lyrics-changed', onChange);
    };
  }, [cur?.id, isRadio, lyricsEnabled]);

  // Auto-show lyrics on track change when the setting is on. Only
  // fires when we're not already on the lyrics route (to avoid
  // navigation loops) and only for real tracks (not radio / DLNA-
  // pushed -1 ids).
  useEffect(() => {
    if (!autoShowLyrics) return;
    if (!cur || cur.id <= 0) return;
    if (isRadio) return;
    if (onLyricsView) return;
    nav('/lyrics');
    // We deliberately depend only on cur.id — re-firing on every
    // navigation back from /lyrics would lock the user inside the
    // panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.id, autoShowLyrics]);

  // Like-from-radio: parse the ICY StreamTitle into artist + track name and
  // navigate to /search with those fields as URL params. SearchView's
  // cascading fallback takes it from there (title+artist → title → artist).
  function likeRadioTrack() {
    if (!radio?.nowPlaying) return;
    const parsed = parseRadioTitle(radio.nowPlaying);
    const qp = new URLSearchParams();
    if (parsed.title) qp.set('title', parsed.title);
    if (parsed.artist) qp.set('artist', parsed.artist);
    // Album isn't available from ICY — cascade will skip tier 1 (title+
    // artist+album) and start at tier 2 (title+artist). Kept as a param
    // placeholder for the day we support stations that do advertise it.
    nav(`/search?${qp.toString()}`);
  }

  const repeatTitle =
    repeatMode === 'off' ? 'Repeat: off'
    : repeatMode === 'all' ? 'Repeat all'
    : 'Repeat one (current song loops)';

  return (
    <footer className="h-20 bg-bg-elev-1 border-t border-white/5 grid grid-cols-3 items-center px-4">
      <div className="flex items-center gap-3 min-w-0">
        {isRadio ? (
          radio!.favicon ? (
            <img src={radio!.favicon} onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} className="w-14 h-14 rounded object-contain bg-bg-highlight" alt="" />
          ) : (
            <div className="w-14 h-14 rounded bg-bg-highlight flex items-center justify-center text-xl">📻</div>
          )
        ) : cur?.coverArtPath ? (
          <img src={mediaUrl(cur.coverArtPath)} className="w-14 h-14 rounded" alt="" />
        ) : (
          <div className="w-14 h-14 rounded bg-bg-highlight" />
        )}
        <div className="min-w-0">
          {isRadio ? (
            <>
              {/* When ICY metadata is available, promote the on-air track to
                  the main line (like a normal song title) and relegate the
                  station name + codec details to the subtitle. Before any
                  metadata has arrived (or on HLS/non-ICY streams), the
                  station name stays up top so the UI isn't blank. */}
              <div className="text-sm text-text-primary truncate flex items-center gap-2">
                <span className="truncate">{radio!.nowPlaying || radio!.station}</span>
                {radio!.nowPlaying && (
                  <button
                    onClick={likeRadioTrack}
                    className="text-text-muted hover:text-accent text-base flex-shrink-0"
                    title={`Find "${radio!.nowPlaying}" in your library`}
                    aria-label="Find this song in library"
                  >
                    ♡
                  </button>
                )}
              </div>
              <div className="text-xs text-text-muted truncate">
                <span className="text-accent font-semibold">LIVE</span>
                {radio!.nowPlaying ? ` · ${radio!.station}` : ''}
                {radio!.country ? ` · ${radio!.country}` : ''}
                {radio!.codec ? ` · ${radio!.codec}` : ''}
                {radio!.bitrate ? ` · ${radio!.bitrate}kbps` : ''}
              </div>
            </>
          ) : (
            <>
              <div className="text-sm text-text-primary truncate">{cur?.title ?? 'Nothing playing'}</div>
              <div className="text-xs text-text-muted truncate">{cur?.artist ?? ''}</div>
            </>
          )}
        </div>
        {!isRadio && cur && (
          <button
            onClick={() => toggleLike(cur.id)}
            className={`ml-3 text-lg ${liked ? 'text-accent' : 'text-text-muted hover:text-text-primary'}`}
            title={liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}
          >
            {liked ? '♥' : '♡'}
          </button>
        )}
        {/* Lyrics toggle. Hidden when:
            - radio mode (no track id to look up)
            - DLNA-pushed track (id < 0)
            - lyrics feature globally disabled in settings
            Clicking toggles between the lyrics route and going back
            (history-based, so the user lands wherever they were
            before opening lyrics). */}
        {!isRadio && cur && cur.id > 0 && lyricsEnabled && (
          <button
            onClick={() => onLyricsView ? nav(-1) : nav('/lyrics')}
            // Tint priorities:
            //   - on the lyrics view → accent (Spotify-blue), to show
            //     where you are
            //   - lyrics are available (cache or disk) → emerald, so
            //     you know there's something to read before clicking
            //   - nothing yet → muted grey, click anyway to trigger
            //     the LRCLib lookup
            className={
              `ml-2 text-base ${
                onLyricsView
                  ? 'text-accent'
                  : lyricsAvail !== 'none'
                    ? 'text-emerald-400 hover:text-emerald-300'
                    : 'text-text-muted hover:text-text-primary'
              }`
            }
            title={
              onLyricsView
                ? 'Hide lyrics'
                : lyricsAvail === 'cached' ? 'Show lyrics (cached)'
                : lyricsAvail === 'disk'   ? 'Show lyrics (.lrc on disk)'
                : 'Show lyrics (will look up online)'
            }
            aria-label="Toggle lyrics panel"
          >
            {/* Speech-bubble glyph for "lyrics". Inline SVG so it
                takes the currentColor + scales cleanly. */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              <line x1="7" y1="9" x2="17" y2="9" />
              <line x1="7" y1="13" x2="13" y2="13" />
            </svg>
          </button>
        )}
      </div>

      <div className="flex flex-col items-center gap-1">
        {isRadio ? (
          <div className="flex items-center gap-3">
            <button
              onClick={toggle}
              className="w-10 h-10 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 transition"
              title={isPlaying ? 'Stop stream' : 'Resume stream'}
            >
              {isPlaying ? '❚❚' : '▶'}
            </button>
            <span className="text-[11px] text-text-muted">
              Live radio — no scrubbing, next/prev, or repeat
            </span>
          </div>
        ) : <>
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
        </>}
      </div>

      <div className="flex items-center justify-end gap-2 text-text-secondary">
        {/* Output-device picker — sits just before the volume slider so
            they're grouped as "audio routing" controls. Click the speaker
            icon to pick between System default / any local audio output. */}
        <OutputDevicePicker />
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
