import type { AudioFrame, AudioEngine } from '../../audio/AudioEngine';
import type { VisualizerBackend } from '../plugin-api';

// A small set of zero-dependency Canvas2D visualizers. These react to the
// AudioFrame bus — bass/mid/treble energies and the `beat` flag — so they're
// a useful reference for anyone writing their own plugin.

export async function makeBuiltin(pluginId: string, source: string): Promise<VisualizerBackend> {
  let ctx: CanvasRenderingContext2D | null = null;
  let w = 0, h = 0;
  let hue = 200;
  const particles: { x: number; y: number; vx: number; vy: number; life: number; color: string }[] = [];

  function bars(frame: AudioFrame, mirror: boolean) {
    if (!ctx) return;
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(0, 0, w, h);
    const bins = frame.frequencyBytes;
    const count = Math.min(128, bins.length);
    const step = Math.floor(bins.length / count);
    const bw = w / count;
    for (let i = 0; i < count; i++) {
      const v = bins[i * step] / 255;
      const bh = v * h * 0.9;
      const gradient = ctx.createLinearGradient(0, h, 0, h - bh);
      gradient.addColorStop(0, `hsl(${(hue + i * 2) % 360}, 90%, 50%)`);
      gradient.addColorStop(1, `hsl(${(hue + i * 2 + 60) % 360}, 90%, 65%)`);
      ctx.fillStyle = gradient;
      if (mirror) {
        ctx.fillRect(i * bw, (h - bh) / 2, bw - 1, bh);
      } else {
        ctx.fillRect(i * bw, h - bh, bw - 1, bh);
      }
    }
    hue = (hue + 0.4 + frame.bass * 3) % 360;
  }

  function wave(frame: AudioFrame) {
    if (!ctx) return;
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(0, 0, w, h);
    const d = frame.waveformBytes;
    ctx.lineWidth = 2;
    ctx.strokeStyle = `hsl(${hue}, 80%, 60%)`;
    ctx.beginPath();
    for (let i = 0; i < d.length; i++) {
      const x = (i / d.length) * w;
      const y = (d[i] / 255) * h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    hue = (hue + 1 + frame.mid * 2) % 360;
  }

  function radial(frame: AudioFrame) {
    if (!ctx) return;
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const bins = frame.frequencyBytes;
    const count = 96;
    const step = Math.floor(bins.length / count);
    const r0 = Math.min(w, h) * 0.15 + frame.bass * 60;
    for (let i = 0; i < count; i++) {
      const v = bins[i * step] / 255;
      const a = (i / count) * Math.PI * 2;
      const r1 = r0 + v * Math.min(w, h) * 0.35;
      ctx.strokeStyle = `hsl(${(hue + i * 3) % 360}, 90%, 60%)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    }
    hue = (hue + 0.5 + frame.treble * 2) % 360;
  }

  function particlesVis(frame: AudioFrame) {
    if (!ctx) return;
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(0, 0, w, h);
    if (frame.beat) {
      const n = 20 + Math.floor(frame.beatIntensity * 60);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = 2 + Math.random() * 4 * frame.beatIntensity;
        particles.push({
          x: w / 2, y: h / 2,
          vx: Math.cos(a) * s, vy: Math.sin(a) * s,
          life: 1, color: `hsl(${Math.floor(Math.random() * 360)}, 85%, 60%)`,
        });
      }
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx; p.y += p.vy; p.life -= 0.012;
      if (p.life <= 0 || p.x < -10 || p.y < -10 || p.x > w + 10 || p.y > h + 10) {
        particles.splice(i, 1); continue;
      }
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5 + frame.treble * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  return {
    id: pluginId,
    name: `Built-in: ${source}`,
    async init(canvas: HTMLCanvasElement, _engine: AudioEngine) {
      ctx = canvas.getContext('2d');
      w = canvas.width; h = canvas.height;
    },
    render(frame, width, height) {
      w = width; h = height;
      switch (source) {
        case 'bars': return bars(frame, false);
        case 'bars-mirror': return bars(frame, true);
        case 'wave': return wave(frame);
        case 'radial': return radial(frame);
        case 'particles': return particlesVis(frame);
      }
    },
    resize(width, height) { w = width; h = height; },
    dispose() { particles.length = 0; ctx = null; },
  };
}
