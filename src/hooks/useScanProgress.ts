import { useEffect, useRef, useState } from 'react';

export type ScanPhase = 'idle' | 'enumerating' | 'reading-tags' | 'fetching-art' | 'done' | 'error';

export interface ArtSubProgress {
  active: boolean;
  albumsTotal: number;
  albumsDone: number;
  currentAlbum: string | null;
}

export interface ScanProgress {
  phase: ScanPhase;
  filesSeen: number;
  filesProcessed: number;
  bytesSeen: number;
  bytesProcessed: number;
  currentFile: string | null;
  message: string | null;
  art: ArtSubProgress | null;
  // Derived (client-side):
  ratePerSec: number;          // rolling files/sec
  bytesPerSec: number;         // rolling bytes/sec
  etaSec: number | null;       // estimated seconds remaining
  startedAt: number | null;    // epoch ms when this phase started
  phaseElapsedSec: number;     // seconds since phase started
}

const EMPTY: ScanProgress = {
  phase: 'idle',
  filesSeen: 0,
  filesProcessed: 0,
  bytesSeen: 0,
  bytesProcessed: 0,
  currentFile: null,
  message: null,
  art: null,
  ratePerSec: 0,
  bytesPerSec: 0,
  etaSec: null,
  startedAt: null,
  phaseElapsedSec: 0,
};

/**
 * Subscribe to scan:progress events and enrich them with throughput + ETA.
 * Single hook so every consumer stays in sync.
 */
export function useScanProgress(): ScanProgress {
  const [p, setP] = useState<ScanProgress>(EMPTY);

  // Rolling samples: [timestampMs, filesProcessed, bytesProcessed]. Windowed to
  // the last ~5s so rate reflects current throughput, not cumulative average.
  const samples = useRef<Array<[number, number, number]>>([]);
  const phaseStart = useRef<number | null>(null);
  const lastPhase = useRef<ScanPhase>('idle');

  useEffect(() => {
    const off = window.mp.scan.onProgress((raw: any) => {
      const now = Date.now();

      // Reset window on phase transitions.
      if (raw.phase !== lastPhase.current) {
        samples.current = [];
        phaseStart.current = now;
        lastPhase.current = raw.phase;
      }

      samples.current.push([now, raw.filesProcessed, raw.bytesProcessed ?? 0]);
      // Trim to last 5s window.
      while (samples.current.length > 1 && now - samples.current[0][0] > 5000) {
        samples.current.shift();
      }

      let ratePerSec = 0;
      let bytesPerSec = 0;
      if (samples.current.length >= 2) {
        const [t0, n0, b0] = samples.current[0];
        const dtSec = (now - t0) / 1000;
        if (dtSec > 0) {
          ratePerSec = Math.max(0, (raw.filesProcessed - n0) / dtSec);
          bytesPerSec = Math.max(0, ((raw.bytesProcessed ?? 0) - b0) / dtSec);
        }
      }

      const remaining = Math.max(0, raw.filesSeen - raw.filesProcessed);
      const etaSec = ratePerSec > 0.1 ? Math.round(remaining / ratePerSec) : null;
      const phaseElapsedSec = phaseStart.current ? (now - phaseStart.current) / 1000 : 0;

      setP({
        phase: raw.phase,
        filesSeen: raw.filesSeen,
        filesProcessed: raw.filesProcessed,
        bytesSeen: raw.bytesSeen ?? 0,
        bytesProcessed: raw.bytesProcessed ?? 0,
        currentFile: raw.currentFile,
        message: raw.message,
        art: raw.art ?? null,
        ratePerSec,
        bytesPerSec,
        etaSec,
        startedAt: phaseStart.current,
        phaseElapsedSec,
      });
    });
    return () => { off?.(); };
  }, []);

  return p;
}

export function formatEta(sec: number | null): string {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatBytes(b: number): string {
  if (!b || b < 1024) return `${b | 0} B`;
  const kb = b / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  if (gb < 1024) return `${gb.toFixed(2)} GB`;
  return `${(gb / 1024).toFixed(2)} TB`;
}

export function formatRateBytes(bps: number): string {
  if (!bps) return '—';
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}
