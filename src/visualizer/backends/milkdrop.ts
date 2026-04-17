// Milkdrop/butterchurn backend. butterchurn is a WebGL port of Milkdrop 2
// that accepts the same .milk preset format Winamp used. It consumes an
// AnalyserNode directly — we pass our shared one from AudioEngine.

import type { AudioEngine, AudioFrame } from '../../audio/AudioEngine';
import type { VisualizerBackend } from '../plugin-api';

export async function makeMilkdrop(pluginId: string, source: string): Promise<VisualizerBackend> {
  const [butterchurnMod, presetsMod]: [any, any] = await Promise.all([
    import('butterchurn' as any),
    import('butterchurn-presets' as any),
  ]);
  const butterchurn = butterchurnMod.default ?? butterchurnMod;
  const presets = presetsMod.default ?? presetsMod;

  let visualizer: any = null;
  let w = 0, h = 0;

  async function resolvePreset(src: string) {
    // 1) If src is an absolute file path (user-supplied .milk), read it via IPC.
    if (/[\\/]/.test(src)) {
      const res = await window.mp.visualizer.readPreset(src);
      if (res.ok) {
        try { return JSON.parse(res.content); } catch { /* not JSON, ignore */ }
      }
    }
    // 2) Otherwise assume it's a key into the bundled butterchurn presets map.
    const all = presets.getPresets?.() ?? presets;
    const key = Object.keys(all).find((k) => k.toLowerCase() === src.toLowerCase())
             ?? Object.keys(all)[0];
    return all[key];
  }

  return {
    id: pluginId,
    name: `Milkdrop: ${source}`,
    async init(canvas: HTMLCanvasElement, engine: AudioEngine) {
      w = canvas.width; h = canvas.height;
      visualizer = butterchurn.createVisualizer(engine.context, canvas, {
        width: w, height: h, pixelRatio: window.devicePixelRatio || 1,
      });
      visualizer.connectAudio(engine.analyser);
      const preset = await resolvePreset(source);
      if (preset) visualizer.loadPreset(preset, 0.0);
    },
    render(_frame: AudioFrame, width, height) {
      if (!visualizer) return;
      if (width !== w || height !== h) { w = width; h = height; visualizer.setRendererSize(w, h); }
      visualizer.render();
    },
    resize(width, height) { w = width; h = height; visualizer?.setRendererSize(w, h); },
    dispose() { visualizer = null; },
  };
}
