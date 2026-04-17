import { useEffect, useState } from 'react';
import type { AppSettings } from '../../../shared/types';

export default function PlaybackSettings() {
  const [s, setS] = useState<AppSettings | null>(null);
  useEffect(() => { window.mp.settings.get().then(setS); }, []);
  if (!s) return null;

  async function patch(p: Partial<AppSettings['playback']>) {
    setS((await window.mp.settings.set({ playback: p })) as AppSettings);
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">Playback</h2>
      <div className="bg-bg-elev-2 rounded p-4 space-y-3 text-sm">
        <div className="flex items-center gap-3">
          <label className="w-40 text-text-muted">Crossfade (ms)</label>
          <input type="number" min={0} max={12000} step={100}
            value={s.playback.crossfadeMs}
            onChange={(e) => patch({ crossfadeMs: Number(e.target.value) })}
            className="bg-bg-base px-2 py-1 rounded w-24" />
        </div>
        <div className="flex items-center gap-3">
          <label className="w-40 text-text-muted">ReplayGain</label>
          <select
            value={s.playback.replayGain}
            onChange={(e) => patch({ replayGain: e.target.value as any })}
            className="bg-bg-base px-2 py-1 rounded"
          >
            <option value="off">Off</option>
            <option value="track">Track</option>
            <option value="album">Album</option>
          </select>
        </div>
      </div>
    </div>
  );
}
