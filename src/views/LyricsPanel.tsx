import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePlayer } from '../store/player';
import { mediaUrl } from '../lib/mediaUrl';

/**
 * LyricsPanel — full-page view of the currently-playing track's lyrics
 * with optional timed highlight + auto-scroll.
 *
 * Data flow:
 *   - Subscribes to usePlayer for queue[index] (current track) and
 *     position (current playback time).
 *   - On track change, fetches lyrics via window.mp.lyrics.get(trackId).
 *     The IPC is cache-first so repeat opens are instant.
 *   - Renders timed lines as a list. The active line is computed from
 *     position vs. each line's `time` and gets a highlight class +
 *     scrollIntoView.
 *
 * Edge cases handled:
 *   - No track playing → empty state ("Start playing something").
 *   - Track has no artist tag → can't query LRCLib, shows "no artist
 *     metadata" hint with link to retag the file.
 *   - LRCLib returned plain-only lyrics (no timestamps) → render the
 *     plain text block without highlight.
 *   - Track changed while a fetch is in flight → stale-response guard
 *     compares trackId in the response to the current track.
 *   - User clicked "Set lyrics manually" → modal textarea, save into
 *     the manual cache slot.
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

export default function LyricsPanel() {
  const nav = useNavigate();
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const position = usePlayer((s) => s.position);
  const cur = queue[index] ?? null;

  const [data, setData] = useState<LyricsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [manualText, setManualText] = useState('');
  const [settings, setSettings] = useState<{ showTimedHighlight: boolean; autoScroll: boolean }>({
    showTimedHighlight: true,
    autoScroll: true,
  });

  // Pull lyrics settings once on mount. Live-updates on settings change
  // are out of scope — re-opening the panel re-reads them.
  useEffect(() => {
    window.mp.settings.get().then((s: any) => {
      setSettings({
        showTimedHighlight: s?.lyrics?.showTimedHighlight !== false,
        autoScroll: s?.lyrics?.autoScroll !== false,
      });
    }).catch(() => { /* defaults are fine */ });
  }, []);

  // Fetch (cache-first) when the current track changes.
  useEffect(() => {
    if (!cur || cur.id <= 0) { setData(null); return; }
    setLoading(true);
    let cancelled = false;
    const requestedId = cur.id;
    (window.mp as any).lyrics.get(requestedId).then((r: LyricsResult | null) => {
      if (cancelled) return;
      // Stale-response guard: another track took over while we were
      // fetching. Drop the response on the floor; the new useEffect
      // run will fetch the right track.
      if (usePlayer.getState().queue[usePlayer.getState().index]?.id !== requestedId) return;
      setData(r);
      // Tell NowPlayingBar to re-peek so the icon tint reflects the
      // new state — particularly important on a fresh LRCLib fetch
      // where the icon was grey before this call and should now be
      // green.
      if (r) {
        window.dispatchEvent(new CustomEvent('mp-lyrics-changed', { detail: { trackId: requestedId } }));
      }
    }).catch((err: any) => {
      console.warn('[LyricsPanel] get failed', err?.message ?? err);
      if (!cancelled) setData(null);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [cur?.id]);

  // Compute the active line index from current position. Memoised
  // against `position` so it recomputes every timeupdate tick (every
  // ~250ms in the engine), but doesn't re-render the whole list when
  // unrelated state changes.
  const activeIdx = useMemo(() => {
    if (!data || !data.lines.length) return -1;
    if (!settings.showTimedHighlight) return -1;
    // Find the last line whose timestamp is <= current position. Lines
    // are pre-sorted by parseLrc, so a linear scan from the end is
    // O(n) worst-case (acceptable — songs have <500 lines typically)
    // but typically O(1) since the active line moves forward by one
    // step per timeupdate.
    let lo = 0, hi = data.lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (data.lines[mid].time <= position) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }, [data, position, settings.showTimedHighlight]);

  // Auto-scroll the active line into view. Throttled to once per line
  // change — without that we'd call scrollIntoView 4× per second.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<Array<HTMLDivElement | null>>([]);
  const lastScrolledIdx = useRef<number>(-1);
  useEffect(() => {
    if (!settings.autoScroll) return;
    if (activeIdx < 0) return;
    if (activeIdx === lastScrolledIdx.current) return;
    lastScrolledIdx.current = activeIdx;
    const el = lineRefs.current[activeIdx];
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeIdx, settings.autoScroll]);

  async function refetch() {
    if (!cur || cur.id <= 0) return;
    setLoading(true);
    try {
      const r = await (window.mp as any).lyrics.refetch(cur.id);
      if (usePlayer.getState().queue[usePlayer.getState().index]?.id === cur.id) {
        setData(r);
      }
      window.dispatchEvent(new CustomEvent('mp-lyrics-changed', { detail: { trackId: cur.id } }));
    } finally {
      setLoading(false);
    }
  }

  async function saveManual() {
    if (!cur || cur.id <= 0) return;
    setLoading(true);
    try {
      const r = await (window.mp as any).lyrics.setManual(cur.id, manualText);
      setData(r);
      setShowManual(false);
      setManualText('');
      window.dispatchEvent(new CustomEvent('mp-lyrics-changed', { detail: { trackId: cur.id } }));
    } finally {
      setLoading(false);
    }
  }

  async function clearLyrics() {
    if (!cur || cur.id <= 0) return;
    await (window.mp as any).lyrics.clear(cur.id);
    setData(null);
    window.dispatchEvent(new CustomEvent('mp-lyrics-changed', { detail: { trackId: cur.id } }));
  }

  // -------- Render branches --------

  if (!cur) {
    return (
      <section className="p-8">
        <h1 className="text-3xl font-bold mb-6">Lyrics</h1>
        <div className="text-text-muted">Start playing a song to see lyrics here.</div>
      </section>
    );
  }

  return (
    <section className="p-8 max-w-3xl mx-auto">
      {/* Track header — cover + title + artist + close-back button */}
      <div className="flex items-center gap-4 mb-6">
        {cur.coverArtPath ? (
          <img src={mediaUrl(cur.coverArtPath)} className="w-20 h-20 rounded shadow" alt="" />
        ) : (
          <div className="w-20 h-20 rounded bg-bg-highlight" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-2xl font-bold truncate">{cur.title}</div>
          <div className="text-text-muted truncate">
            {cur.artist ?? 'Unknown artist'}
            {cur.album ? ` · ${cur.album}` : ''}
          </div>
          {data && (
            <div className="text-xs text-text-muted mt-1">
              Source: <span className="text-text-secondary">{labelForSource(data.source)}</span>
              {data.fromCache && ' · cached'}
            </div>
          )}
        </div>
        <button
          onClick={() => nav(-1)}
          className="text-text-muted hover:text-white text-sm px-3 py-1 rounded hover:bg-bg-elev-2"
          title="Back"
        >
          Close
        </button>
      </div>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2 mb-4 text-sm">
        <button
          onClick={refetch}
          disabled={loading}
          className="px-3 py-1.5 rounded bg-bg-elev-2 hover:bg-bg-elev-1 disabled:opacity-50"
          title="Re-query LRCLib (bypass cache)"
        >
          {loading ? 'Fetching…' : 'Re-fetch'}
        </button>
        <button
          onClick={() => { setManualText(data?.syncedText || data?.plainText || ''); setShowManual(true); }}
          className="px-3 py-1.5 rounded bg-bg-elev-2 hover:bg-bg-elev-1"
          title="Paste your own lyrics"
        >
          Set manually
        </button>
        {data && data.source !== 'none' && (
          <button
            onClick={clearLyrics}
            className="px-3 py-1.5 rounded bg-bg-elev-2 hover:bg-bg-elev-1 text-text-muted"
            title="Clear cached lyrics so the next open re-runs the lookup"
          >
            Clear
          </button>
        )}
        {!cur.artist && (
          <span className="text-xs text-amber-400">
            No artist tag — LRCLib lookup disabled. Fix tags or paste manually.
          </span>
        )}
      </div>

      {/* Body */}
      <div ref={containerRef} className="bg-bg-elev-1/40 rounded p-6 min-h-[400px]">
        {loading && !data && (
          <div className="text-text-muted">Looking up lyrics…</div>
        )}
        {!loading && data?.source === 'none' && (
          <div className="text-text-muted space-y-2">
            <div>No lyrics found.</div>
            <div className="text-xs">
              Tried local <code>{cur.title}.lrc</code> and LRCLib.
              You can paste lyrics manually with the button above.
            </div>
          </div>
        )}
        {data && data.source !== 'none' && data.lines.length > 0 && (
          <div className="space-y-2 leading-relaxed">
            {data.lines.map((ln, i) => {
              const active = i === activeIdx;
              return (
                <div
                  key={`${i}-${ln.time}`}
                  ref={(el) => { lineRefs.current[i] = el; }}
                  className={
                    active
                      ? 'text-white text-lg font-semibold transition-colors'
                      : i < activeIdx
                        ? 'text-text-muted text-base transition-colors'
                        : 'text-text-secondary text-base transition-colors'
                  }
                >
                  {ln.text || <span className="opacity-40">♪</span>}
                </div>
              );
            })}
          </div>
        )}
        {data && data.source !== 'none' && data.lines.length === 0 && data.plainText && (
          // Plain-only fallback (LRCLib has plain but not synced for this
          // track, or user pasted untimed lyrics). Render as a flat block.
          <pre className="whitespace-pre-wrap text-text-secondary leading-relaxed font-sans">
            {data.plainText}
          </pre>
        )}
      </div>

      {/* Manual paste modal */}
      {showManual && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={() => setShowManual(false)}
        >
          <div
            className="bg-bg-elev-1 rounded-lg p-6 max-w-2xl w-full max-h-[80vh] flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="font-bold text-lg">Paste lyrics</div>
            <div className="text-xs text-text-muted">
              LRC format with <code>[mm:ss.cc]</code> timestamps for synced highlight,
              or plain text for untimed display.
            </div>
            <textarea
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              className="flex-1 min-h-[300px] font-mono text-sm bg-bg-base p-3 rounded border border-white/10 focus:outline-none focus:border-accent"
              placeholder={'[00:12.34]First line of lyrics\n[00:18.10]Second line\n…'}
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowManual(false)}
                className="px-4 py-2 rounded bg-bg-elev-2 hover:bg-bg-base text-sm"
              >
                Cancel
              </button>
              <button
                onClick={saveManual}
                disabled={loading}
                className="px-4 py-2 rounded bg-accent text-black hover:bg-accent/90 text-sm disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function labelForSource(s: string): string {
  switch (s) {
    case 'local-lrc': return 'local .lrc file';
    case 'lrclib':    return 'LRCLib';
    case 'manual':    return 'manual';
    case 'none':      return 'not found';
    default:          return s;
  }
}
