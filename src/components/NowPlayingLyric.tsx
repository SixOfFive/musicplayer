import { useEffect, useMemo, useState } from 'react';
import { usePlayer } from '../store/player';

/**
 * Inline lyric strip for the NowPlayingBar — shows the currently
 * active line of synced lyrics whenever the playing track has them
 * cached (or available on disk as a side-by-side .lrc).
 *
 * Behaviour:
 *   - Cache-first IPC (`lyrics:get`) on track change. The IPC returns
 *     instantly when a row exists; otherwise it kicks off the local-
 *     disk + LRCLib lookup and we render the result on resolve.
 *   - Subscribes to `usePlayer.position` so the active line updates
 *     in step with playback (timeupdate fires ~4 Hz).
 *   - Returns null when:
 *       - no current track / track id is < 0 (radio / DLNA push)
 *       - the lookup returned `source: 'none'`
 *       - lyrics are plain-text only (no synced timestamps to follow)
 *     so the bar layout doesn't reserve empty space when nothing
 *     useful can be shown.
 *   - Active-line lookup is a binary search against the timestamp
 *     array; cheap to recompute on every render.
 *   - Text is single-line + truncated. Long phrases get the standard
 *     ellipsis. Click-target opens the full LyricsPanel (mirrors the
 *     icon button so users get to the full view either way).
 *
 * Mounted unconditionally inside NowPlayingBar; rendering the null
 * branch costs effectively nothing and keeps the call site simple.
 *
 * Re-fetches when the user saves / clears lyrics from LyricsPanel
 * (listens for `mp-lyrics-changed`) so the strip lights up
 * immediately after a successful manual paste / LRCLib hit.
 */

interface LyricLine { time: number; text: string; }
interface LyricsResult {
  source: 'local-lrc' | 'lrclib' | 'manual' | 'none';
  lines: LyricLine[];
  plainText: string;
  syncedText: string;
  fromCache: boolean;
  trackId: number;
}

interface Props {
  trackId: number;
  /** Click handler — usually navigates to /lyrics. */
  onClick?: () => void;
}

export default function NowPlayingLyric({ trackId, onClick }: Props) {
  const position = usePlayer((s) => s.position);
  const [data, setData] = useState<LyricsResult | null>(null);

  // Fetch on track change. Stale-response guard against rapid track
  // switches: only commit data whose trackId still matches the prop.
  useEffect(() => {
    if (!trackId || trackId <= 0) { setData(null); return; }
    let cancelled = false;
    const requestedId = trackId;
    (window.mp as any).lyrics?.get(requestedId).then((r: LyricsResult | null) => {
      if (cancelled) return;
      if (!r || r.trackId !== requestedId) return;
      setData(r);
    }).catch(() => { /* swallow — strip just stays hidden */ });

    // Re-fetch on save / clear / refetch from the LyricsPanel.
    const onChange = (e: Event) => {
      const ce = e as CustomEvent<{ trackId?: number }>;
      if (ce.detail?.trackId !== requestedId) return;
      (window.mp as any).lyrics?.get(requestedId).then((r: LyricsResult | null) => {
        if (cancelled || !r || r.trackId !== requestedId) return;
        setData(r);
      }).catch(() => { /* ignore */ });
    };
    window.addEventListener('mp-lyrics-changed', onChange);
    return () => { cancelled = true; window.removeEventListener('mp-lyrics-changed', onChange); };
  }, [trackId]);

  // Resolve the active line via binary search. Lines are pre-sorted
  // by parseLrc; we just want the last line whose timestamp is <=
  // current position.
  const activeIdx = useMemo(() => {
    if (!data || data.lines.length === 0) return -1;
    let lo = 0, hi = data.lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (data.lines[mid].time <= position) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }, [data, position]);

  // Hide entirely when we can't show a useful synced line. Plain-only
  // lyrics aren't useful in a thin strip — we'd just show the same
  // text forever. Users get the full plain text in /lyrics.
  if (!data || data.source === 'none' || data.lines.length === 0) return null;

  // Before the first timestamp fires, show the very first line dimmed
  // so the strip doesn't flash empty for the song's intro.
  const showIdx = activeIdx >= 0 ? activeIdx : 0;
  const line = data.lines[showIdx]?.text ?? '';
  if (!line || !line.trim()) {
    // Pure beat marker (♪ in the panel). Show a thin dot instead of
    // empty space so the strip stays visually anchored.
    return (
      <button
        onClick={onClick}
        className="min-w-0 max-w-md text-text-muted text-xs truncate text-left hover:text-text-primary"
        title="Open lyrics"
      >
        ♪
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      className={`min-w-0 max-w-md text-sm truncate text-left transition-opacity hover:opacity-100 ${
        activeIdx >= 0 ? 'text-text-primary opacity-100' : 'text-text-muted opacity-70'
      }`}
      title="Open lyrics"
    >
      {line}
    </button>
  );
}
