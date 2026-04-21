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

import { useEffect, useState } from 'react';
import { usePlayer } from '../store/player';
import { mediaUrl } from '../lib/mediaUrl';
import type { SuggestionEntry } from '../../shared/types';

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
  const play = usePlayer((s) => s.play);
  const toggleLike = usePlayer((s) => s.toggleLike);
  const likedIds = usePlayer((s) => s.likedIds);

  async function refresh() {
    setErr(null);
    try {
      const r: SuggestionEntry[] = await (window.mp as any).suggestions.get(100);
      setItems(r);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  useEffect(() => { void refresh(); }, []);

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
            Top {items?.length ?? 100} tracks ranked by what you've played,
            liked, and the genres / artists / years you lean toward. Pure local
            scoring — nothing leaves your machine.
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
        <div className="space-y-1">
          {items.map((e, i) => {
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
      )}
    </section>
  );
}
