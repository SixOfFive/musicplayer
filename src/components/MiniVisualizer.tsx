import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAudioEngine } from '../audio/AudioEngine';
import { VisualizerHost } from '../visualizer/host';
import { listBundledMilkdrop } from '../visualizer/preset-list';
import type { VisualizerPlugin } from '../../shared/types';

/**
 * Miniature of whichever visualizer is currently selected in Settings.
 * Mounts its own VisualizerHost pointed at the shared AudioEngine, so this
 * runs in parallel with the full /visualizer view if both are open — but in
 * practice only one is on-screen at a time (React unmounts the other).
 *
 * Clicking opens the full-screen version.
 */
interface Props {
  className?: string;
}

export default function MiniVisualizer({ className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<VisualizerHost | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = containerRef.current;
    if (!canvas || !parent) return;

    const host = new VisualizerHost(canvas, getAudioEngine());
    hostRef.current = host;

    let cancelled = false;
    (async () => {
      try {
        const [ipcList, milk] = await Promise.all([
          window.mp.visualizer.list(),
          listBundledMilkdrop(),
        ]);
        if (cancelled) return;
        const merged = [...(ipcList as VisualizerPlugin[]), ...milk];
        const s: any = await window.mp.settings.get();
        if (cancelled) return;
        const activeId: string | null = s?.visualizer?.activePluginId ?? merged[0]?.id ?? null;
        const pl = merged.find((p) => p.id === activeId) ?? merged.find((p) => p.kind !== 'native-winamp');
        if (pl && pl.kind !== 'native-winamp') {
          await host.load(pl.kind, pl.id, pl.source);
        }
      } catch (err) {
        console.error('[MiniVisualizer] load failed', err);
      }
    })();

    const resize = () => {
      const rect = parent.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      host.resize(w, h);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);

    return () => {
      cancelled = true;
      ro.disconnect();
      host.dispose();
      hostRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`group relative rounded bg-black overflow-hidden shadow-lg cursor-pointer ${className ?? 'w-60 h-[135px]'}`}
      onClick={() => nav('/visualizer')}
      title="Open full visualizer"
    >
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition" />
      <button
        onClick={(e) => { e.stopPropagation(); nav('/visualizer'); }}
        className="absolute top-1.5 right-1.5 w-7 h-7 rounded bg-black/70 hover:bg-black text-white flex items-center justify-center text-sm opacity-0 group-hover:opacity-100 transition"
        title="Full screen"
        aria-label="Open full visualizer"
      >
        {/* Expand-to-fullscreen glyph */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 9V4h5" />
          <path d="M20 9V4h-5" />
          <path d="M4 15v5h5" />
          <path d="M20 15v5h-5" />
        </svg>
      </button>
    </div>
  );
}
