import { useEffect, useRef, useState } from 'react';
import type { VisualizerPlugin } from '../../shared/types';
import { getAudioEngine } from '../audio/AudioEngine';
import { VisualizerHost } from '../visualizer/host';
import { listBundledMilkdrop } from '../visualizer/preset-list';
import { usePlayer } from '../store/player';

export default function Visualizer() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<VisualizerHost | null>(null);
  const [plugins, setPlugins] = useState<VisualizerPlugin[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [bpm, setBpm] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    (async () => {
      const [ipcList, milk] = await Promise.all([
        window.mp.visualizer.list(),
        listBundledMilkdrop(),
      ]);
      const merged = [...(ipcList as VisualizerPlugin[]), ...milk];
      // Sort alphabetically by display name, case-insensitive with
      // natural digit ordering ("2" before "10"). Keeps the picker
      // browsable now that the list is 400+ entries long.
      merged.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
      setPlugins(merged);
      const s = await window.mp.settings.get();
      setActiveId(s.visualizer.activePluginId ?? merged[0]?.id ?? null);
    })();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const host = new VisualizerHost(canvas, getAudioEngine());
    hostRef.current = host;
    const resize = () => {
      const rect = canvas.parentElement!.getBoundingClientRect();
      host.resize(Math.floor(rect.width), Math.floor(rect.height));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);
    return () => { ro.disconnect(); host.dispose(); hostRef.current = null; };
  }, []);

  useEffect(() => {
    if (!activeId || !hostRef.current) return;
    const pl = plugins.find((p) => p.id === activeId);
    if (!pl || pl.kind === 'native-winamp') return;
    hostRef.current.load(pl.kind, pl.id, pl.source);
    window.mp.settings.set({ visualizer: { activePluginId: pl.id } } as any);
  }, [activeId, plugins]);

  // Surface BPM from the shared audio bus. Throttle state updates to ~2/sec
  // so we don't thrash React with every frame. No `bpm` dep → subscribe once.
  useEffect(() => {
    const eng = getAudioEngine();
    let last = 0;
    const off = eng.onFrame((f) => {
      const now = performance.now();
      if (now - last > 500) { last = now; setBpm(f.bpm); }
    });
    return () => { off(); };
  }, []);

  const isPlaying = usePlayer((s) => s.isPlaying);
  const cur = usePlayer((s) => s.queue[s.index] ?? null);

  // Keep our React state in sync with the real fullscreen state. The user
  // might exit fullscreen via the browser's built-in ESC handler (or F11 on
  // Windows), which we DON'T control — but `fullscreenchange` fires either
  // way, so we listen and update.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement != null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Force a canvas resize after the stage element swaps to fullscreen. The
  // ResizeObserver already attached in the earlier effect catches this, but
  // belt-and-suspenders — if the browser batches the resize poorly, the
  // canvas can end up smaller than the now-fullscreen viewport.
  useEffect(() => {
    if (!hostRef.current) return;
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    hostRef.current.resize(Math.floor(rect.width), Math.floor(rect.height));
  }, [isFullscreen]);

  /**
   * Toggle browser fullscreen on the visualizer stage. Standard
   * requestFullscreen() gives us the OS-level experience the user asked for:
   * covers the entire screen (not just the renderer viewport), hides the
   * Electron title bar + taskbar, ESC exits. Double-click on the stage and
   * the corner icon both call this.
   */
  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch { /* noop */ }
    } else if (stageRef.current) {
      try { await stageRef.current.requestFullscreen(); } catch (err) {
        console.error('[visualizer] requestFullscreen failed', err);
      }
    }
  };

  return (
    <section className="h-full flex flex-col">
      <div className="flex items-center gap-3 px-6 py-3 border-b border-white/5">
        <select
          value={activeId ?? ''}
          onChange={(e) => setActiveId(e.target.value)}
          className="bg-bg-elev-2 text-sm px-3 py-1.5 rounded max-w-xs"
        >
          {plugins.map((p) => (
            <option key={p.id} value={p.id} disabled={p.kind === 'native-winamp'}>
              {p.kind === 'milkdrop' ? '🌀 ' : p.kind === 'builtin' ? '◆ ' : '🎛 '}
              {p.name}{p.kind === 'native-winamp' ? ' (unavailable)' : ''}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <div className="text-xs text-text-muted">
          {cur ? <>▶ {cur.title} — {cur.artist}</> : 'No track'}
          {bpm ? <span className="ml-4">BPM: <span className="text-white tabular-nums">{bpm}</span></span> : null}
          {!isPlaying && <span className="ml-4 text-text-muted">Start playback to drive the visualizer</span>}
        </div>
      </div>
      <div
        ref={stageRef}
        className="flex-1 min-h-0 bg-black relative group"
        onDoubleClick={toggleFullscreen}
        // Discovery hint only in windowed mode. In fullscreen the user already
        // knows how they got here, and we don't want a hover-tooltip popping
        // over their visualizer. The on-canvas "ESC or double-click to exit"
        // callout in the top-left corner covers the exit path.
        title={isFullscreen ? undefined : 'Double-click to go fullscreen'}
      >
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
        {/* Fullscreen toggle. Bottom-right so it's in the natural "expand"
            corner the user asked for; also mirrored top-right so whichever
            they reach for works. Both fade down to 30% opacity and come back
            on hover, so they don't distract in fullscreen but stay findable. */}
        <FullscreenButton isFullscreen={isFullscreen} onClick={toggleFullscreen} corner="top-right" />
        <FullscreenButton isFullscreen={isFullscreen} onClick={toggleFullscreen} corner="bottom-right" />
        {isFullscreen && (
          <div className="absolute top-4 left-4 text-xs text-white/40 pointer-events-none select-none">
            ESC or double-click to exit
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Expand / contract icon pinned to a corner of the visualizer stage. Uses
 * the conventional "four corner arrows" glyphs — out-facing for enter-
 * fullscreen, in-facing for exit. Title attribute doubles as the screen-
 * reader label.
 */
function FullscreenButton({
  isFullscreen,
  onClick,
  corner,
}: {
  isFullscreen: boolean;
  onClick: () => void;
  corner: 'top-right' | 'bottom-right';
}) {
  const pos = corner === 'top-right' ? 'top-3 right-3' : 'bottom-3 right-3';
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`absolute ${pos} w-9 h-9 rounded bg-black/40 hover:bg-black/70 text-white/70 hover:text-white flex items-center justify-center transition opacity-30 hover:opacity-100 group-hover:opacity-70`}
      // Drop the hover tooltip while fullscreen — the glyph (contract arrows)
      // is unambiguous and a floating rectangle of text over the visualizer
      // is exactly the sort of thing the user asked to get rid of.
      title={isFullscreen ? undefined : 'Enter fullscreen'}
      aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
    >
      {isFullscreen ? (
        // Contract — arrows pointing in from each corner
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 3v6H3" /><path d="M3 3l6 6" />
          <path d="M15 3v6h6" /><path d="M21 3l-6 6" />
          <path d="M9 21v-6H3" /><path d="M3 21l6-6" />
          <path d="M15 21v-6h6" /><path d="M21 21l-6-6" />
        </svg>
      ) : (
        // Expand — arrows pointing out to each corner
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9V3h6" /><path d="M3 3l6 6" />
          <path d="M21 9V3h-6" /><path d="M21 3l-6 6" />
          <path d="M3 15v6h6" /><path d="M3 21l6-6" />
          <path d="M21 15v6h-6" /><path d="M21 21l-6-6" />
        </svg>
      )}
    </button>
  );
}
