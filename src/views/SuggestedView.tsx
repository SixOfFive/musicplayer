// "Suggested for you" — top-N tracks ranked by affinity to the user's
// listening + liking history. Pure local scoring (see
// electron/ipc/suggestions.ts for the algorithm); no external APIs,
// no ML. A small "why?" chip in each row names the dominant signal
// behind the rank so it doesn't feel like a black box.
//
// The list renders as a lightweight alternative to the library
// TrackRow because we want two things TrackRow doesn't have:
//   1. A rank number at the far left (1..100)
//   2. A reason chip to the right of the title line
// Everything else — click to play, right-click context menu — would
// be pure duplication of TrackRow. For now we render a simple row
// ourselves and call play() directly; a future refactor could unify
// this with TrackRow via a "extraColumns" prop.

import { useEffect, useRef, useState } from 'react';
import { usePlayer } from '../store/player';
import { mediaUrl } from '../lib/mediaUrl';
import type { SuggestionEntry } from '../../shared/types';

// How many rows appear on first render, and how many more we reveal
// each time the user scrolls near the bottom. Paging by 100 keeps the
// rendered DOM small on small libraries (where 500 suggestions would
// be overkill anyway) and gives a clean progressive feel on large ones.
const PAGE = 100;
// Hard cap — the scoring engine can rank more, but there's no real
// value in browsing past 500 for a "suggested" list. Anything deeper
// is tail-noise.
const MAX = 500;

function fmtDur(sec: number | null): string {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function reasonLabel(e: SuggestionEntry): string {
  // Chip text. Short so it fits a single row without truncating the
  // title. "More <artist>" reads naturally; "Genre: x" is the clearest
  // label for genre affinity without being preachy.
  switch (e.reason) {
    case 'artist': return e.reasonDetail ? `More ${e.reasonDetail}` : 'Artist match';
    case 'genre':  return e.reasonDetail ? `Genre: ${e.reasonDetail}` : 'Genre match';
    case 'album':  return e.reasonDetail ? `From ${e.reasonDetail}` : 'Album match';
    case 'era':    return e.reasonDetail ? `${e.reasonDetail} era` : 'Era match';
  }
}

// Tint the chip by reason so the eye can quickly scan the list and
// understand the mix. Subtle — same dark palette as the rest of the app.
function reasonTint(reason: SuggestionEntry['reason']): string {
  switch (reason) {
    case 'artist': return 'bg-accent/10 text-accent';
    case 'genre':  return 'bg-emerald-400/10 text-emerald-300';
    case 'album':  return 'bg-amber-400/10 text-amber-300';
    case 'era':    return 'bg-purple-400/10 text-purple-300';
  }
}

export default function SuggestedView() {
  const [items, setItems] = useState<SuggestionEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Progressive reveal — start at PAGE (100), grow by PAGE each time
  // the sentinel below enters the viewport, capped at the fetched
  // list length. Kept in state so scroll-driven increments re-render.
  const [visible, setVisible] = useState<number>(PAGE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const play = usePlayer((s) => s.play);
  const toggleLike = usePlayer((s) => s.toggleLike);
  const likedIds = usePlayer((s) => s.likedIds);

  async function refresh() {
    setErr(null);
    setVisible(PAGE);
    try {
      // Fetch up to MAX (500) in a single call — the scorer has to
      // walk every track in the library anyway to compute the ranking,
      // so paging at the IPC layer would just do the same work twice.
      // At ~250 bytes per entry this is ~125KB over IPC, negligible.
      const r: SuggestionEntry[] = await (window.mp as any).suggestions.get(MAX);
      setItems(r);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  useEffect(() => { void refresh(); }, []);

  // Reveal the next 100 when the sentinel (an invisible div after the
  // last row) scrolls into view. IntersectionObserver is cheaper than
  // a scroll listener — no layout thrash, no throttling needed.
  // rootMargin 600px means we start fetching-to-render a bit before
  // the sentinel is actually visible, so the user doesn't see the
  // "loading more" flash in the middle of a scroll.
  useEffect(() => {
    if (!sentinelRef.current) return;
    if (!items) return;
    if (visible >= items.length) return;
    const el = sentinelRef.current;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      setVisible((v) => Math.min(items.length, v + PAGE));
    }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [items, visible]);

  function playFrom(i: number) {
    if (!items) return;
    // Feed the whole ranked list into the queue so Next / Prev walk
    // through the user's top picks rather than snapping back to
    // nothing. Start at the clicked index.
    play(
      items.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        path: t.path,
        durationSec: t.duration_sec,
        coverArtPath: t.cover_art_path ?? null,
      })),
      i,
    );
  }

  return (
    <section className="p-6 max-w-6xl">
      <header className="mb-6 flex items-end gap-4">
        <div className="flex-1">
          <h1 className="text-3xl font-bold">Suggested for you</h1>
          <p className="text-text-muted text-sm mt-1">
            {items && items.length > 0 ? (
              <>Showing <span className="text-text-primary">{Math.min(visible, items.length)}</span> of {items.length} ranked picks. Scroll for more.</>
            ) : (
              <>Top {MAX} tracks ranked by what you've played, liked, and the genres / artists / years you lean toward. Pure local scoring — nothing leaves your machine.</>
            )}
          </p>
        </div>
        <button
          onClick={refresh}
          className="px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 text-xs"
          title="Recompute the ranking from your latest play history"
        >
          Refresh
        </button>
      </header>

      {err && (
        <div className="mb-4 p-3 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-300">
          Couldn't compute suggestions: {err}
        </div>
      )}

      {items === null && !err && (
        <div className="text-text-muted text-sm">Computing…</div>
      )}

      {items && items.length === 0 && !err && (
        <div className="text-text-muted text-sm">
          Not enough listening history yet. Play some tracks and like what you
          enjoy — suggestions sharpen as you listen.
        </div>
      )}

      {items && items.length > 0 && (
        <>
        <div className="space-y-1">
          {items.slice(0, visible).map((e, i) => {
            const liked = likedIds.has(e.id);
            return (
              <div
                key={e.id}
                onClick={() => playFrom(i)}
                className="grid grid-cols-[32px_40px_minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1fr)_64px_32px] gap-3 items-center px-3 py-1.5 rounded hover:bg-white/5 cursor-pointer text-sm"
              >
                <div className="text-text-muted tabular-nums text-right text-xs">{i + 1}</div>
                {e.cover_art_path ? (
                  <img
                    src={mediaUrl(e.cover_art_path)}
                    loading="lazy"
                    decoding="async"
                    className="w-10 h-10 rounded flex-shrink-0"
                    alt=""
                  />
                ) : (
                  <div className="w-10 h-10 rounded bg-bg-highlight flex-shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="truncate text-text-primary">{e.title}</div>
                  <div className="truncate text-xs text-text-muted">{e.artist ?? ''}</div>
                </div>
                <div className="min-w-0 truncate text-text-secondary text-xs">{e.album ?? ''}</div>
                <div className="min-w-0">
                  <span
                    className={`inline-block px-2 py-0.5 rounded text-[10px] truncate max-w-full ${reasonTint(e.reason)}`}
                    title={`Score ${e.score.toFixed(3)} — dominant signal: ${e.reason}${e.reasonDetail ? ` (${e.reasonDetail})` : ''}`}
                  >
                    {reasonLabel(e)}
                  </span>
                </div>
                <div className="text-text-muted tabular-nums text-right text-xs">{fmtDur(e.duration_sec)}</div>
                <button
                  onClick={(ev) => { ev.stopPropagation(); toggleLike(e.id); }}
                  className={`text-base ${liked ? 'text-accent' : 'text-text-muted hover:text-text-primary'}`}
                  title={liked ? 'Unlike' : 'Like'}
                >
                  {liked ? '♥' : '♡'}
                </button>
              </div>
            );
          })}
        </div>

        {/* Sentinel that triggers the next +100 reveal when it enters
            the viewport. Skipped once we've revealed everything —
            IntersectionObserver in the useEffect above also bails in
            that case, so the rAF churn stops naturally. */}
        {visible < items.length && (
          <>
            <div ref={sentinelRef} className="h-1" aria-hidden />
            <div className="text-center py-4 text-text-muted text-xs">
              Loading more suggestions…
            </div>
          </>
        )}

        {/* End-of-list label — tells the user they've seen everything
            and makes the truncation at MAX feel deliberate rather than
            broken. */}
        {visible >= items.length && (
          <div className="text-center py-6 text-text-muted text-xs">
            {items.length >= MAX
              ? `That's the top ${MAX}. Lower-scored picks beyond here are noise more than signal.`
              : `End of list — ${items.length} suggestion${items.length === 1 ? '' : 's'} from your library.`}
          </div>
        )}
        </>
      )}
    </section>
  );
}
