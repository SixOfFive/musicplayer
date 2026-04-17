import { useCallback, useEffect, useState } from 'react';
import { EQ_BAND_COUNT, EQ_BANDS_HZ, getAudioEngine } from '../audio/AudioEngine';

const PRESETS: Record<string, number[]> = {
  Flat:       [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Bass:       [+6, +5, +3, +1, 0, 0, 0, 0, 0, 0],
  Treble:     [0, 0, 0, 0, 0, +1, +3, +5, +6, +6],
  'Bass + Treble': [+5, +4, +2, 0, -1, -1, +1, +3, +5, +5],
  Vocal:      [-2, -2, -1, +2, +4, +4, +2, 0, -1, -2],
  Rock:       [+4, +3, +2, 0, -1, -1, +1, +3, +4, +4],
  Classical:  [+4, +3, +2, +1, 0, 0, -1, -1, +2, +3],
  Electronic: [+5, +4, +1, 0, -2, +1, 0, +1, +3, +5],
  Podcast:    [-4, -3, -1, +2, +4, +4, +3, +1, -2, -4],
  Loudness:   [+6, +4, 0, 0, -2, -2, 0, 0, +4, +6],
};

function formatHz(hz: number): string {
  if (hz >= 1000) return `${hz / 1000}k`;
  return `${hz}`;
}

/**
 * 10-band graphic equalizer + preamp + enable toggle.
 * Sliders are vertical and write directly into the shared AudioEngine on
 * every change (Web Audio parameter changes are dezippered in hardware,
 * so slider drags don't cause audible stepping).
 *
 * Every change also debounce-persists to settings so your curve comes back
 * across sessions.
 */
export default function EqualizerPanel() {
  const [enabled, setEnabled] = useState(false);
  const [gains, setGains] = useState<number[]>(Array(EQ_BAND_COUNT).fill(0));
  const [preamp, setPreamp] = useState(0);

  // Load saved EQ state once on mount + push it into the audio engine.
  useEffect(() => {
    (async () => {
      const s: any = await window.mp.settings.get();
      const p = s?.playback ?? {};
      const initG = (p.eqGainsDb && p.eqGainsDb.length === EQ_BAND_COUNT) ? p.eqGainsDb : Array(EQ_BAND_COUNT).fill(0);
      const initEnabled = !!p.eqEnabled;
      const initPre = typeof p.eqPreamp === 'number' ? p.eqPreamp : 0;
      setGains(initG);
      setEnabled(initEnabled);
      setPreamp(initPre);
      getAudioEngine().setEq(initEnabled, initG, initPre);
    })();
  }, []);

  // Debounced persistence — dragging a slider shouldn't hit the JSON file 60 times/sec.
  const save = useCallback((e: boolean, g: number[], p: number) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = (save as any)._t as ReturnType<typeof setTimeout> | undefined;
    if (timer) clearTimeout(timer);
    (save as any)._t = setTimeout(() => {
      void window.mp.settings.set({ playback: { eqEnabled: e, eqGainsDb: g, eqPreamp: p } } as any);
    }, 300);
  }, []);

  function apply(next: { enabled?: boolean; gains?: number[]; preamp?: number }) {
    const e = next.enabled ?? enabled;
    const g = next.gains ?? gains;
    const p = next.preamp ?? preamp;
    if (next.enabled !== undefined) setEnabled(next.enabled);
    if (next.gains) setGains(next.gains);
    if (next.preamp !== undefined) setPreamp(next.preamp);
    getAudioEngine().setEq(e, g, p);
    save(e, g, p);
  }

  function setBand(i: number, db: number) {
    const ng = [...gains];
    ng[i] = db;
    apply({ gains: ng });
  }

  function applyPreset(name: string) {
    const g = PRESETS[name];
    if (!g) return;
    apply({ gains: [...g], enabled: true });
  }

  return (
    <div className="border-t border-white/5 bg-black/40">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => apply({ enabled: e.target.checked })}
            />
            <span className={enabled ? 'text-accent font-semibold' : 'text-text-muted'}>Equalizer</span>
          </label>
        </div>
        <select
          value=""
          onChange={(e) => e.target.value && applyPreset(e.target.value)}
          className="bg-bg-elev-2 text-xs px-2 py-0.5 rounded"
          title="Preset"
        >
          <option value="">Preset…</option>
          {Object.keys(PRESETS).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      <div className="flex items-end gap-1.5 px-3 pb-3">
        {/* Preamp slider */}
        <div className="flex flex-col items-center gap-1">
          <span className={`text-[9px] tabular-nums h-3 ${preamp === 0 ? 'text-text-muted' : 'text-accent'}`}>
            {preamp > 0 ? `+${preamp}` : preamp}
          </span>
          <input
            type="range" min={-12} max={6} step={1} value={preamp}
            onChange={(e) => apply({ preamp: Number(e.target.value) })}
            disabled={!enabled}
            className="vertical-slider accent-accent"
            style={{ writingMode: 'vertical-lr' as any, direction: 'rtl', width: '16px', height: '96px' }}
            title={`Preamp (${preamp} dB)`}
          />
          <span className="text-[9px] text-text-muted">Pre</span>
        </div>

        <div className="w-px bg-white/10 self-stretch mx-0.5" />

        {EQ_BANDS_HZ.map((hz, i) => {
          const val = gains[i] ?? 0;
          return (
            <div key={hz} className="flex flex-col items-center gap-1">
              <span className={`text-[9px] tabular-nums h-3 ${val === 0 ? 'text-text-muted' : 'text-accent'}`}>
                {val > 0 ? `+${val}` : val}
              </span>
              <input
                type="range" min={-12} max={12} step={1} value={val}
                onChange={(e) => setBand(i, Number(e.target.value))}
                disabled={!enabled}
                style={{ writingMode: 'vertical-lr' as any, direction: 'rtl', width: '16px', height: '96px' }}
                className="accent-accent"
                title={`${hz} Hz: ${val > 0 ? '+' : ''}${val} dB`}
              />
              <span className="text-[9px] text-text-muted">{formatHz(hz)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
