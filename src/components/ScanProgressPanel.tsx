import {
  formatBytes, formatEta, formatRateBytes, useScanProgress, type ScanPhase, type ArtSubProgress,
} from '../hooks/useScanProgress';

const PHASE_INFO: Record<Exclude<ScanPhase, 'idle'>, { label: string; description: string }> = {
  enumerating: {
    label: 'Finding music files',
    description: 'Walking your music folders recursively, collecting every file with a supported extension.',
  },
  'reading-tags': {
    label: 'Reading tags & embedded art',
    description: 'Parsing ID3, Vorbis, APE and MP4 tags; extracting embedded cover art; inserting into the library.',
  },
  'fetching-art': {
    label: 'Fetching cover art from providers',
    description: 'Albums without art are looked up on MusicBrainz + Cover Art Archive, then Deezer as a fallback. Runs in the background — rate-limited to respect provider policies.',
  },
  done: {
    label: 'Scan complete',
    description: 'Your library is up to date.',
  },
  error: {
    label: 'Scan error',
    description: 'Something went wrong. Check the message below or try again.',
  },
};

export default function ScanProgressPanel() {
  const p = useScanProgress();

  // Hide entirely when nothing is happening AND no background art task is active.
  if (p.phase === 'idle' && !p.art?.active) return null;

  // Main card is the tag-scan status, except suppress it when the tag scan is done
  // and the only thing still going is background art fetching.
  const showMain = !(p.phase === 'done' && p.art?.active);

  return (
    <div className="space-y-3 mb-8">
      {showMain && <MainCard p={p} />}
      {p.art?.active && <ArtCard art={p.art} />}
    </div>
  );
}

function MainCard({ p }: { p: ReturnType<typeof useScanProgress> }) {
  const info = PHASE_INFO[p.phase as Exclude<ScanPhase, 'idle'>];
  if (!info) return null;
  const pct = p.filesSeen > 0 ? Math.min(100, Math.round((p.filesProcessed / p.filesSeen) * 100)) : 0;
  const active = p.phase !== 'done' && p.phase !== 'error';

  return (
    <div className={`rounded-xl p-5 border ${p.phase === 'error' ? 'border-red-500/40 bg-red-950/30' : p.phase === 'done' ? 'border-accent/40 bg-accent/10' : 'border-white/10 bg-bg-elev-1'}`}>
      <div className="flex items-start gap-4">
        {active && (
          <div className="w-10 h-10 border-4 border-accent border-t-transparent rounded-full animate-spin flex-shrink-0" />
        )}
        {p.phase === 'done' && (
          <div className="w-10 h-10 rounded-full bg-accent text-black flex items-center justify-center text-xl font-bold flex-shrink-0">✓</div>
        )}
        {p.phase === 'error' && (
          <div className="w-10 h-10 rounded-full bg-red-500 text-white flex items-center justify-center text-xl font-bold flex-shrink-0">!</div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h2 className="text-xl font-bold">{info.label}</h2>
            {active && p.filesSeen > 0 && (
              <span className="text-text-muted tabular-nums text-sm">
                {p.filesProcessed.toLocaleString()} / {p.filesSeen.toLocaleString()} files
                <span className="ml-2 text-white font-semibold">{pct}%</span>
              </span>
            )}
            {active && p.bytesSeen > 0 && (
              <span className="text-text-muted tabular-nums text-sm">
                · {formatBytes(p.bytesProcessed)} / {formatBytes(p.bytesSeen)}
              </span>
            )}
          </div>
          <p className="text-sm text-text-secondary mt-1">{info.description}</p>

          {active && p.filesSeen > 0 && (
            <div className="mt-3 h-2 bg-black/40 rounded overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}

          {active && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-4 text-xs">
              <Stat label="Rate" value={p.ratePerSec > 0 ? `${p.ratePerSec.toFixed(1)} /s` : '—'} />
              <Stat label="Throughput" value={formatRateBytes(p.bytesPerSec)} />
              <Stat label="Scanned" value={formatBytes(p.bytesProcessed)} />
              <Stat label="ETA" value={formatEta(p.etaSec)} />
              <Stat label="Elapsed" value={formatEta(Math.round(p.phaseElapsedSec))} />
            </div>
          )}

          {p.currentFile && active && (
            <div className="mt-3 text-xs font-mono text-text-muted truncate">
              {p.currentFile}
            </div>
          )}

          {p.message && (
            <div className={`mt-2 text-xs ${p.phase === 'error' ? 'text-red-300' : 'text-text-muted'}`}>
              {p.message}
            </div>
          )}

          {active && (
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => window.mp.scan.cancel()}
                className="text-sm px-4 py-1.5 rounded-full bg-white/10 hover:bg-white/20"
              >Cancel scan</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ArtCard({ art }: { art: ArtSubProgress }) {
  const pct = art.albumsTotal > 0 ? Math.round((art.albumsDone / art.albumsTotal) * 100) : 0;
  return (
    <div className="rounded-xl p-4 border border-purple-500/30 bg-purple-500/10">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 border-4 border-purple-400 border-t-transparent rounded-full animate-spin flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h3 className="text-sm font-semibold">Fetching cover art</h3>
            <span className="text-xs text-text-muted tabular-nums">
              {art.albumsDone} / {art.albumsTotal} albums · {pct}%
            </span>
            <span className="text-xs text-text-muted">· running in background</span>
          </div>
          <div className="mt-2 h-1.5 bg-black/40 rounded overflow-hidden">
            <div className="h-full bg-purple-400 transition-all duration-200" style={{ width: `${pct}%` }} />
          </div>
          {art.currentAlbum && (
            <div className="text-xs text-text-muted truncate mt-2">{art.currentAlbum}</div>
          )}
        </div>
        <button
          onClick={() => window.mp.scan.cancel()}
          className="text-xs px-3 py-1 rounded-full bg-white/10 hover:bg-white/20"
          title="Stop background art fetch"
        >Stop</button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-black/30 rounded p-2">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="text-sm font-semibold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}
