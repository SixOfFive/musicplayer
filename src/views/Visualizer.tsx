import { useEffect, useRef, useState } from 'react';
import type { VisualizerPlugin } from '../../shared/types';
import { getAudioEngine } from '../audio/AudioEngine';
import { VisualizerHost } from '../visualizer/host';
import { listBundledMilkdrop } from '../visualizer/preset-list';
import { usePlayer } from '../store/player';

export default function Visualizer() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<VisualizerHost | null>(null);
  const [plugins, setPlugins] = useState<VisualizerPlugin[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [bpm, setBpm] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      const [ipcList, milk] = await Promise.all([
        window.mp.visualizer.list(),
        listBundledMilkdrop(),
      ]);
      const merged = [...(ipcList as VisualizerPlugin[]), ...milk];
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
      <div className="flex-1 min-h-0 bg-black relative">
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      </div>
    </section>
  );
}
