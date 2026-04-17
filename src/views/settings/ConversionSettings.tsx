import { useEffect, useState } from 'react';
import type { AppSettings, Mp3Quality } from '../../../shared/types';

const QUALITY_LABELS: Record<Mp3Quality, { label: string; blurb: string }> = {
  V0:     { label: 'VBR V0 (archival, ~245 kbps avg)',   blurb: 'Best quality MP3. Transparent to most listeners, same tools audiophiles use for long-term MP3 storage.' },
  V2:     { label: 'VBR V2 (~190 kbps avg)',             blurb: 'Noticeably smaller files, still very good quality. Good if you\'re tight on space.' },
  CBR320: { label: 'CBR 320 kbps (max constant bitrate)', blurb: 'Largest MP3. No benefit over V0 except legacy-device compatibility.' },
  CBR256: { label: 'CBR 256 kbps',                        blurb: 'Middle ground CBR.' },
};

export default function ConversionSettings() {
  const [s, setS] = useState<AppSettings | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    window.mp.settings.get().then(setS);
    window.mp.convert.checkAvailable().then((r: any) => setAvailable(!!r?.available));
  }, []);

  if (!s) return null;
  const c = s.conversion ?? {
    enabled: true, quality: 'V0', sizePercentileThreshold: 66, moveOriginalsToTrash: true,
  };

  async function patch(p: Partial<AppSettings['conversion']>) {
    const next = await window.mp.settings.set({ conversion: p } as any);
    setS(next as AppSettings);
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold mb-1">Shrink oversized albums</h2>
        <p className="text-sm text-text-muted mb-3">
          Convert FLAC tracks on big albums to high-quality MP3 to reclaim disk space.
          Never automatic — only runs when you click the 🗜 button on an album page.
          Tags and cover art are preserved. FLAC originals are moved to trash only after every new MP3 is verified.
        </p>

        <div className="bg-bg-elev-2 rounded p-4 space-y-4 text-sm">
          <div className={`text-xs ${available === false ? 'text-red-400' : available ? 'text-accent' : 'text-text-muted'}`}>
            {available === null && 'Checking for bundled ffmpeg…'}
            {available === true && '✓ Bundled ffmpeg ready (via ffmpeg-static).'}
            {available === false && '✗ ffmpeg binary not available. Run `npm install` (ffmpeg-static ships the right binary per platform).'}
          </div>

          <label className="flex items-start gap-2">
            <input
              type="checkbox" className="mt-1"
              checked={c.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            <span>
              <span className="font-medium">Enable conversion feature</span>
              <p className="text-xs text-text-muted mt-0.5">When off, the 🗜 buttons are hidden.</p>
            </span>
          </label>

          <div>
            <div className="font-medium mb-2">MP3 quality</div>
            <div className="space-y-2">
              {(Object.keys(QUALITY_LABELS) as Mp3Quality[]).map((q) => (
                <label key={q} className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio" name="mp3-quality" className="mt-1"
                    checked={c.quality === q}
                    onChange={() => patch({ quality: q })}
                  />
                  <span>
                    <span className="font-medium">{QUALITY_LABELS[q].label}</span>
                    <p className="text-xs text-text-muted mt-0.5">{QUALITY_LABELS[q].blurb}</p>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="font-medium mb-2">Oversized threshold</div>
            <p className="text-xs text-text-muted mb-2">
              Shows the 🗜 badge on albums whose total size is at or above the Nth percentile by bytes.
              <strong className="text-white"> 66</strong> = top third (default). <strong className="text-white">0</strong> = every album qualifies.
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range" min={0} max={99} step={1}
                value={c.sizePercentileThreshold}
                onChange={(e) => patch({ sizePercentileThreshold: Number(e.target.value) })}
                className="flex-1 accent-accent"
              />
              <span className="w-20 text-right tabular-nums">{c.sizePercentileThreshold}th pct</span>
            </div>
          </div>

          <label className="flex items-start gap-2">
            <input
              type="checkbox" className="mt-1"
              checked={c.moveOriginalsToTrash}
              onChange={(e) => patch({ moveOriginalsToTrash: e.target.checked })}
            />
            <span>
              <span className="font-medium">Move originals to the system trash</span>
              <p className="text-xs text-text-muted mt-0.5">
                Highly recommended. Off = permanently delete FLACs immediately after MP3 verification (no recovery).
              </p>
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}
