// AudioEngine wires a single HTMLAudioElement through Web Audio so that
// (a) we still get native codec support (mp3/flac/wav/m4a/opus/ogg) and
// (b) visualizer plugins get frequency/waveform/beat data every frame.

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

export class AudioEngine {
  readonly element: HTMLAudioElement;
  readonly context: AudioContext;
  readonly analyser: AnalyserNode;
  readonly source: MediaElementAudioSourceNode;
  readonly gain: GainNode;

  private readonly freqBytes: Uint8Array<ArrayBuffer>;
  private readonly waveBytes: Uint8Array<ArrayBuffer>;
  private readonly freqFloat: Float32Array<ArrayBuffer>;
  private readonly waveFloat: Float32Array<ArrayBuffer>;

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

    // AudioContext created lazily on first play (browsers need a gesture).
    this.context = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.source = this.context.createMediaElementSource(this.element);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = fftSize;
    this.analyser.smoothingTimeConstant = this.smoothing;
    this.gain = this.context.createGain();

    this.source.connect(this.analyser);
    this.analyser.connect(this.gain);
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
    this.element.src = url;
    this.element.load();
  }

  async play() {
    if (this.context.state === 'suspended') await this.context.resume();
    await this.element.play();
    this.startLoop();
  }

  pause() { this.element.pause(); }
  stop() { this.element.pause(); this.element.currentTime = 0; }
  seek(t: number) { this.element.currentTime = t; }
  setVolume(v: number) { this.gain.gain.value = Math.max(0, Math.min(1, v)); }
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
