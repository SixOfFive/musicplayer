// Visualizer plugin contract. Every backend (built-in canvas, butterchurn/Milkdrop,
// AVS port, or a future Windows-only Winamp bridge) implements this.
//
// A plugin is stateless from the app's perspective: it's given a canvas + the
// shared AudioEngine reference, and receives an AudioFrame every animation frame
// with FFT data, waveform data, band energies, and beat info. This is the
// "audio bus" that ties playback → visuals.

import type { AudioEngine, AudioFrame } from '../audio/AudioEngine';

export interface VisualizerBackend {
  /** Stable id matching VisualizerPlugin.id */
  id: string;
  /** Human-readable name */
  name: string;
  /** Called once with the canvas + audio engine when activated */
  init(canvas: HTMLCanvasElement, engine: AudioEngine): Promise<void> | void;
  /** Called every animation frame with synced audio data */
  render(frame: AudioFrame, width: number, height: number): void;
  /** Called when the container resizes */
  resize(width: number, height: number): void;
  /** Called when the backend is being swapped out — dispose GL resources etc. */
  dispose(): void;
}

/**
 * Registry of backend constructors. Each plugin kind (builtin, milkdrop, avs,
 * native-winamp) exports a factory that takes the plugin's `source` string and
 * returns a VisualizerBackend.
 */
export type BackendFactory = (pluginId: string, source: string) => Promise<VisualizerBackend>;

const factories = new Map<string, BackendFactory>();

export function registerBackend(kind: string, factory: BackendFactory) {
  factories.set(kind, factory);
}

export function getBackendFactory(kind: string): BackendFactory | undefined {
  return factories.get(kind);
}
