import type { AudioEngine } from '../audio/AudioEngine';
import { getBackendFactory, registerBackend, type VisualizerBackend } from './plugin-api';
import { makeBuiltin } from './backends/builtin';
import { makeMilkdrop } from './backends/milkdrop';

registerBackend('builtin', makeBuiltin);
registerBackend('milkdrop', makeMilkdrop);
// 'avs' and 'native-winamp' would be registered here when implemented.

export class VisualizerHost {
  private backend: VisualizerBackend | null = null;
  private canvas: HTMLCanvasElement;
  private engine: AudioEngine;
  private raf = 0;
  private unsub: (() => void) | null = null;
  private lastFrame: any = null;

  constructor(canvas: HTMLCanvasElement, engine: AudioEngine) {
    this.canvas = canvas;
    this.engine = engine;
    this.unsub = this.engine.onFrame((f) => { this.lastFrame = f; });
  }

  async load(kind: string, pluginId: string, source: string) {
    this.backend?.dispose();
    const fac = getBackendFactory(kind);
    if (!fac) throw new Error(`No backend registered for kind: ${kind}`);
    this.backend = await fac(pluginId, source);
    await this.backend.init(this.canvas, this.engine);
    this.startLoop();
  }

  resize(w: number, h: number) {
    this.canvas.width = w;
    this.canvas.height = h;
    this.backend?.resize(w, h);
  }

  private startLoop() {
    if (this.raf) return;
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      if (!this.backend || !this.lastFrame) return;
      this.backend.render(this.lastFrame, this.canvas.width, this.canvas.height);
    };
    this.raf = requestAnimationFrame(tick);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.backend?.dispose();
    this.backend = null;
    this.unsub?.();
  }
}
