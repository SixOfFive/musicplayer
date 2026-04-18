// AudioEngine wires a single HTMLAudioElement through Web Audio so that
// (a) we still get native codec support (mp3/flac/wav/m4a/opus/ogg) and
// (b) visualizer plugins get frequency/waveform/beat data every frame.

import Hls from 'hls.js';

export interface AudioFrame {
  // Time
  timeSec: number;           // audio element currentTime
  deltaSec: number;          // seconds since last frame

  // Waveform: floats in [-1, 1], length = fftSize
  waveform: Float32Array;
  // Frequency magnitudes normalised 0..1, length = fftSize / 2
  frequency: Float32Array;
  // Raw byte frequency, length = fftSize / 2 (what butterchurn wants)
  frequencyBytes: Uint8Array;
  // Raw byte waveform, length = fftSize (what butterchurn wants)
  waveformBytes: Uint8Array;

  // Band energies in [0, 1]
  bass: number;
  mid: number;
  treble: number;
  loudness: number;          // overall perceptual loudness

  // Beat detection
  beat: boolean;             // true on the frame a beat was detected
  beatIntensity: number;     // 0..1 strength of this beat
  bpm: number | null;        // running estimate
  phase: number;             // 0..1 position within current beat
}

export type FrameListener = (f: AudioFrame) => void;

/**
 * 10-band graphic equalizer centers (Hz). ISO third-octave standard spacing
 * (each step is 2× the previous — the same spacing used by foobar2000,
 * Winamp, and car stereos). Q ≈ 1.414 gives smooth inter-band overlap.
 */
export const EQ_BANDS_HZ = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_BAND_COUNT = EQ_BANDS_HZ.length;
const EQ_Q = 1.414;
const EQ_MIN_DB = -12;
const EQ_MAX_DB = +12;

export class AudioEngine {
  readonly element: HTMLAudioElement;
  readonly context: AudioContext;
  readonly analyser: AnalyserNode;
  readonly source: MediaElementAudioSourceNode;
  readonly gain: GainNode;
  // Pre-amp before the EQ chain (lets users pull hot masters down before
  // boosting bands, to avoid clipping).
  readonly preamp: GainNode;
  // Ten BiquadFilterNodes in series (one peaking filter per band).
  readonly eqBands: BiquadFilterNode[];

  private readonly freqBytes: Uint8Array<ArrayBuffer>;
  private readonly waveBytes: Uint8Array<ArrayBuffer>;
  private readonly freqFloat: Float32Array<ArrayBuffer>;
  private readonly waveFloat: Float32Array<ArrayBuffer>;

  // hls.js instance — lazily created when the source is an HLS playlist.
  // Chromium's HTMLMediaElement doesn't support HLS natively (only Safari
  // does), so we need MSE-based playback via hls.js for .m3u8 URLs. Kept
  // as a field so we can tear it down when switching sources.
  private hls: Hls | null = null;

  private listeners = new Set<FrameListener>();
  private rafId: number | null = null;
  private lastTs = 0;
  private lastAudioTime = 0;

  // Beat detector state (simple energy/flux onset with running BPM estimate)
  private bassHistory: number[] = [];
  private lastBeatTime = 0;
  private intervalsMs: number[] = [];
  private sensitivity = 0.7;
  private smoothing = 0.6;

  constructor(opts?: { fftSize?: 512 | 1024 | 2048 | 4096 }) {
    const fftSize = opts?.fftSize ?? 2048;

    this.element = new Audio();
    this.element.crossOrigin = 'anonymous';
    this.element.preload = 'metadata';
    this.element.addEventListener('error', () => {
      const e = this.element.error;
      const codeName = ['', 'ABORTED', 'NETWORK', 'DECODE', 'SRC_NOT_SUPPORTED'][e?.code ?? 0] ?? 'UNKNOWN';
      // Stringify inline — electron console-message forwarding flattens objects to "[object Object]".
      console.error(`[AudioEngine] audio element error | src=${this.element.src} | code=${e?.code} (${codeName}) | msg=${e?.message ?? ''}`);
    });

    // AudioContext created lazily on first play (browsers need a gesture).
    this.context = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.source = this.context.createMediaElementSource(this.element);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = fftSize;
    this.analyser.smoothingTimeConstant = this.smoothing;
    this.preamp = this.context.createGain();
    this.preamp.gain.value = 1.0;
    this.gain = this.context.createGain();

    // Build the EQ chain: 10 peaking biquads in series. Starts flat (0 dB).
    this.eqBands = EQ_BANDS_HZ.map((hz) => {
      const b = this.context.createBiquadFilter();
      b.type = 'peaking';
      b.frequency.value = hz;
      b.Q.value = EQ_Q;
      b.gain.value = 0;
      return b;
    });

    // Signal path:  source → analyser → preamp → eqBand[0..9] → gain → destination
    // Analyser is upstream of the EQ so visualizers react to the original
    // audio, not the user's EQ'd version (otherwise pulling treble down
    // would starve the visualizer's treble bin).
    this.source.connect(this.analyser);
    this.analyser.connect(this.preamp);
    let node: AudioNode = this.preamp;
    for (const b of this.eqBands) {
      node.connect(b);
      node = b;
    }
    node.connect(this.gain);
    this.gain.connect(this.context.destination);

    // Back each typed array with an explicit ArrayBuffer so TS 5.7+ infers
    // `Uint8Array<ArrayBuffer>` (AnalyserNode methods reject the wider
    // `ArrayBufferLike` variant).
    this.freqBytes = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    this.waveBytes = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    this.freqFloat = new Float32Array(new ArrayBuffer(this.analyser.frequencyBinCount * 4));
    this.waveFloat = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
  }

  setSrc(url: string) {
    // Always tear down any prior hls.js instance first — attaching a new
    // source while one is live leaks listeners and glitches the element.
    if (this.hls) {
      try { this.hls.destroy(); } catch { /* noop */ }
      this.hls = null;
    }

    // HLS playlists (.m3u8) aren't natively playable in Chromium. Route them
    // through hls.js, which feeds MPEG-TS / fMP4 segments into the element
    // via MediaSource Extensions. The element sees a blob: URL that Web Audio
    // treats as same-origin, so the visualizer analyser keeps working.
    const isHls = /\.m3u8(\?|$)/i.test(url);
    if (isHls && Hls.isSupported()) {
      console.log(`[AudioEngine] HLS source detected — using hls.js | url=${url}`);
      // hls.js fetches segments over XHR/fetch and feeds them into an MSE
      // SourceBuffer, producing a blob: URL that Web Audio treats as
      // same-origin — so the MediaElementSource muting that bites raw
      // non-CORS streams doesn't apply here. Put crossOrigin back in case
      // the player store dropped it for a previous raw-stream attempt.
      this.element.crossOrigin = 'anonymous';
      const hls = new Hls({
        // Keep latency reasonable for live radio; these are conservative
        // defaults and can be tuned later if specific stations misbehave.
        lowLatencyMode: false,
        enableWorker: true,
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (data.fatal) {
          console.error(`[AudioEngine] hls.js fatal error | type=${data.type} | details=${data.details}`);
        }
      });
      hls.loadSource(url);
      hls.attachMedia(this.element);
      this.hls = hls;
      return;
    }

    this.element.src = url;
    this.element.load();
  }

  async play() {
    try {
      if (this.context.state === 'suspended') await this.context.resume();
      await this.element.play();
    } catch (err: any) {
      console.error(`[AudioEngine] play failed | src=${this.element.src} | ctxState=${this.context.state} | errName=${err?.name} | errMessage=${err?.message} | elementCode=${this.element.error?.code}`);
      throw err;
    }
    this.startLoop();
  }

  pause() { this.element.pause(); }
  stop() { this.element.pause(); this.element.currentTime = 0; }
  seek(t: number) { this.element.currentTime = t; }
  setVolume(v: number) { this.gain.gain.value = Math.max(0, Math.min(1, v)); }

  /**
   * Set band gains (dB). Pass length-10 array matching EQ_BANDS_HZ. Out-of-range
   * values are clamped to [-12, +12] dB. When `enabled` is false, all bands
   * are forced to 0 dB (effectively bypassed) regardless of the gains array.
   */
  setEq(enabled: boolean, gainsDb: number[], preampDb: number) {
    for (let i = 0; i < this.eqBands.length; i++) {
      const raw = gainsDb[i] ?? 0;
      const clamped = Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, raw));
      this.eqBands[i].gain.value = enabled ? clamped : 0;
    }
    // Preamp expressed in dB, converted to linear gain. Negative = quieter.
    const preampClamped = Math.max(-12, Math.min(6, preampDb));
    this.preamp.gain.value = enabled ? Math.pow(10, preampClamped / 20) : 1.0;
  }
  setSensitivity(v: number) { this.sensitivity = Math.max(0, Math.min(1, v)); }
  setSmoothing(v: number) {
    this.smoothing = Math.max(0, Math.min(1, v));
    this.analyser.smoothingTimeConstant = this.smoothing;
  }

  onFrame(fn: FrameListener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private startLoop() {
    if (this.rafId != null) return;
    const tick = (ts: number) => {
      this.rafId = requestAnimationFrame(tick);
      if (this.element.paused) return;

      const dt = this.lastTs ? (ts - this.lastTs) / 1000 : 0;
      this.lastTs = ts;

      this.analyser.getByteFrequencyData(this.freqBytes);
      this.analyser.getByteTimeDomainData(this.waveBytes);
      this.analyser.getFloatFrequencyData(this.freqFloat);
      this.analyser.getFloatTimeDomainData(this.waveFloat);

      const bins = this.freqBytes.length;
      // Approx band splits: bass 0-8%, mid 8-40%, treble 40-100%
      const bassEnd = Math.floor(bins * 0.08);
      const midEnd = Math.floor(bins * 0.40);
      let bass = 0, mid = 0, treble = 0;
      for (let i = 0; i < bassEnd; i++) bass += this.freqBytes[i];
      for (let i = bassEnd; i < midEnd; i++) mid += this.freqBytes[i];
      for (let i = midEnd; i < bins; i++) treble += this.freqBytes[i];
      bass /= (bassEnd || 1) * 255;
      mid /= (midEnd - bassEnd || 1) * 255;
      treble /= (bins - midEnd || 1) * 255;
      const loudness = (bass * 0.5 + mid * 0.35 + treble * 0.15);

      // Beat detection: compare current bass to rolling average.
      const histLen = 43; // ~0.7s at 60fps
      this.bassHistory.push(bass);
      if (this.bassHistory.length > histLen) this.bassHistory.shift();
      const avg = this.bassHistory.reduce((s, v) => s + v, 0) / this.bassHistory.length;
      const variance = this.bassHistory.reduce((s, v) => s + (v - avg) ** 2, 0) / this.bassHistory.length;
      const threshold = avg + Math.max(0.12, Math.sqrt(variance) * (2.2 - this.sensitivity * 1.5));
      const now = performance.now();
      let beat = false;
      let beatIntensity = 0;
      if (bass > threshold && now - this.lastBeatTime > 260) {
        beat = true;
        beatIntensity = Math.min(1, (bass - avg) / Math.max(0.05, avg));
        if (this.lastBeatTime !== 0) {
          this.intervalsMs.push(now - this.lastBeatTime);
          if (this.intervalsMs.length > 16) this.intervalsMs.shift();
        }
        this.lastBeatTime = now;
      }
      let bpm: number | null = null;
      if (this.intervalsMs.length >= 4) {
        const sorted = [...this.intervalsMs].sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        bpm = Math.round(60000 / med);
      }
      const phase = this.lastBeatTime
        ? Math.min(1, (now - this.lastBeatTime) / (bpm ? 60000 / bpm : 500))
        : 0;

      const frame: AudioFrame = {
        timeSec: this.element.currentTime,
        deltaSec: dt || Math.max(0, this.element.currentTime - this.lastAudioTime),
        waveform: this.waveFloat,
        frequency: this.freqFloat,
        frequencyBytes: this.freqBytes,
        waveformBytes: this.waveBytes,
        bass, mid, treble, loudness,
        beat, beatIntensity, bpm, phase,
      };
      this.lastAudioTime = this.element.currentTime;
      this.listeners.forEach((l) => l(frame));
    };
    this.rafId = requestAnimationFrame(tick);
  }
}

// Singleton shared between playback and visualizer.
let engine: AudioEngine | null = null;
export function getAudioEngine(): AudioEngine {
  if (!engine) engine = new AudioEngine();
  return engine;
}
