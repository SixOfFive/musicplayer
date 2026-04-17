import type { AudioEngine } from '../audio/AudioEngine';
import { getBackendFactory, registerBackend, type VisualizerBackend } from './plugin-api';
import { makeBuiltin } from './backends/builtin';
import { makeMilkdrop } from './backends/milkdrop';

registerBackend('builtin', makeBuiltin);
registerBackend('milkdrop', makeMilkdrop);
// 'avs' and 'native-winamp' would be registered here when implemented.

/**
 * Host for whichever visualizer backend is currently active.
 *
 * Canvas caveat: once `<canvas>.getContext('2d')` has been called, subsequent
 * `getContext('webgl')` calls return null forever — browsers one-shot the
 * binding. Our built-in backends use Canvas2D and Milkdrop uses WebGL, so
 * switching between them requires a fresh `<canvas>` element. `load()` below
 * detects the kind change and swaps canvases inside the same parent container.
 */
export class VisualizerHost {
  private backend: VisualizerBackend | null = null;
  private lastKind: string | null = null;
  private canvas: HTMLCanvasElement;
  private parent: HTMLElement;
  private engine: AudioEngine;
  private raf = 0;
  private unsub: (() => void) | null = null;
  private lastFrame: any = null;

  constructor(canvas: HTMLCanvasElement, engine: AudioEngine) {
    this.canvas = canvas;
    this.parent = canvas.parentElement!;
    this.engine = engine;
    this.unsub = this.engine.onFrame((f) => { this.lastFrame = f; });
  }

  private recreateCanvas() {
    const oldW = this.canvas.width;
    const oldH = this.canvas.height;
    const className = this.canvas.className;
    const fresh = document.createElement('canvas');
    fresh.width = oldW;
    fresh.height = oldH;
    fresh.className = className;
    this.parent.replaceChild(fresh, this.canvas);
    this.canvas = fresh;
  }

  async load(kind: string, pluginId: string, source: string) {
    // Dispose current backend FIRST so GL resources are released.
    this.backend?.dispose();
    this.backend = null;

    // If kind changed (or we had a previous backend at all), swap in a fresh
    // canvas — the old one is context-locked to whatever the previous backend
    // used.
    if (this.lastKind !== null && this.lastKind !== kind) {
      this.recreateCanvas();
    }
    this.lastKind = kind;

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
