import { useEffect, useState } from 'react';
import type { AppSettings, VisualizerPlugin } from '../../../shared/types';
import { listBundledMilkdrop } from '../../visualizer/preset-list';

export default function VisualizerSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [plugins, setPlugins] = useState<VisualizerPlugin[]>([]);

  async function refresh() {
    setSettings(await window.mp.settings.get());
    const [ipc, milk] = await Promise.all([
      window.mp.visualizer.list(),
      listBundledMilkdrop(),
    ]);
    setPlugins([...(ipc as VisualizerPlugin[]), ...milk]);
  }
  useEffect(() => { refresh(); }, []);

  if (!settings) return <div className="text-text-muted">Loading…</div>;

  async function patch(p: Partial<AppSettings['visualizer']>) {
    const next = await window.mp.settings.set({ visualizer: p });
    setSettings(next as AppSettings);
  }

  const grouped: Record<string, VisualizerPlugin[]> = {};
  for (const pl of plugins) (grouped[pl.kind] ||= []).push(pl);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold mb-1">Visualizer</h2>
        <div className="bg-bg-elev-2 rounded p-4 space-y-3 text-sm">
          <div className="flex items-center gap-3">
            <label className="w-32 text-text-muted">Target FPS</label>
            <select
              value={settings.visualizer.fps}
              onChange={(e) => patch({ fps: Number(e.target.value) as 30 | 60 | 120 })}
              className="bg-bg-base px-2 py-1 rounded"
            >
              <option value={30}>30</option><option value={60}>60</option><option value={120}>120</option>
            </select>
          </div>
          <div className="flex items-center gap-3">
            <label className="w-32 text-text-muted">Beat sensitivity</label>
            <input type="range" min={0} max={1} step={0.05}
              value={settings.visualizer.sensitivity}
              onChange={(e) => patch({ sensitivity: parseFloat(e.target.value) })}
              className="flex-1 accent-accent" />
            <span className="w-10 text-right tabular-nums">{settings.visualizer.sensitivity.toFixed(2)}</span>
          </div>
          <div className="flex items-center gap-3">
            <label className="w-32 text-text-muted">Smoothing</label>
            <input type="range" min={0} max={0.95} step={0.01}
              value={settings.visualizer.smoothing}
              onChange={(e) => patch({ smoothing: parseFloat(e.target.value) })}
              className="flex-1 accent-accent" />
            <span className="w-10 text-right tabular-nums">{settings.visualizer.smoothing.toFixed(2)}</span>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={settings.visualizer.fullscreenOnPlay} onChange={(e) => patch({ fullscreenOnPlay: e.target.checked })} />
            Fullscreen when playback starts
          </label>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-1">Plugin folders</h2>
        <p className="text-sm text-text-muted mb-3">
          Drop <code className="font-mono">.milk</code> Milkdrop presets in any of these folders to use them as visualizers.
          Windows-only <code className="font-mono">vis_*.dll</code> Winamp plugins can be listed here too but are not loadable today — see README.
        </p>
        <div className="bg-bg-elev-2 rounded divide-y divide-white/5">
          {settings.visualizer.pluginSearchPaths.map((p, i) => (
            <div key={i} className="px-4 py-3 text-sm flex justify-between items-center">
              <span className="font-mono truncate">{p}</span>
              <button onClick={() => window.mp.visualizer.openDir(p)} className="text-xs text-accent hover:underline">Open folder</button>
            </div>
          ))}
        </div>
        <button
          onClick={async () => {
            const d = await window.mp.library.pickDir();
            if (!d) return;
            patch({ pluginSearchPaths: [...settings.visualizer.pluginSearchPaths, d] });
          }}
          className="mt-3 bg-white/10 hover:bg-white/20 px-4 py-1.5 rounded-full text-sm"
        >+ Add folder</button>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-1">Available plugins ({plugins.length})</h2>
        <div className="bg-bg-elev-2 rounded divide-y divide-white/5 max-h-96 overflow-y-auto">
          {Object.entries(grouped).map(([kind, list]) => (
            <div key={kind}>
              <div className="px-4 py-2 text-xs uppercase tracking-wider text-text-muted bg-black/20">
                {kind === 'builtin' ? 'Built-in' : kind === 'milkdrop' ? 'Milkdrop / butterchurn' : kind === 'avs' ? 'AVS' : 'Winamp (.dll, Windows only — disabled)'}
              </div>
              {list.map((p) => (
                <label key={p.id} className="px-4 py-2 text-sm flex items-center gap-3 hover:bg-white/5">
                  <input
                    type="radio" name="active-plugin"
                    disabled={p.kind === 'native-winamp'}
                    checked={settings.visualizer.activePluginId === p.id}
                    onChange={() => patch({ activePluginId: p.id })}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{p.name}</div>
                    {p.author && <div className="text-xs text-text-muted">by {p.author}</div>}
                  </div>
                  {p.kind === 'native-winamp' && <span className="text-xs text-text-muted">not loadable</span>}
                </label>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
