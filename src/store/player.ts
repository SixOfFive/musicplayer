import { create } from 'zustand';
import { getAudioEngine } from '../audio/AudioEngine';

interface QueueItem {
  id: number;
  title: string;
  artist: string | null;
  album: string | null;
  path: string;
  durationSec: number | null;
  coverArtPath: string | null;
}

interface PlayerState {
  queue: QueueItem[];
  index: number;
  isPlaying: boolean;
  volume: number;
  position: number;
  duration: number;
  likedIds: Set<number>;

  play(items: QueueItem[], startIndex?: number): Promise<void>;
  toggle(): void;
  next(): void;
  prev(): void;
  seek(sec: number): void;
  setVolume(v: number): void;
  setLikedIds(ids: number[]): void;
  toggleLike(trackId: number): Promise<void>;
}

async function makeUrl(p: string) {
  return window.mp.library.fileUrl(p);
}

export const usePlayer = create<PlayerState>((set, get) => {
  const engine = getAudioEngine();

  engine.element.addEventListener('timeupdate', () => {
    set({ position: engine.element.currentTime });
  });
  engine.element.addEventListener('loadedmetadata', () => {
    set({ duration: engine.element.duration || 0 });
  });
  engine.element.addEventListener('ended', () => {
    get().next();
  });
  engine.element.addEventListener('play', () => set({ isPlaying: true }));
  engine.element.addEventListener('pause', () => set({ isPlaying: false }));

  return {
    queue: [],
    index: -1,
    isPlaying: false,
    volume: 0.8,
    position: 0,
    duration: 0,
    likedIds: new Set<number>(),

    async play(items, startIndex = 0) {
      set({ queue: items, index: startIndex });
      const cur = items[startIndex];
      if (!cur) return;
      engine.setSrc(await makeUrl(cur.path));
      await engine.play();
    },
    toggle() {
      if (engine.element.paused) engine.play();
      else engine.pause();
    },
    async next() {
      const { queue, index } = get();
      const ni = index + 1;
      if (ni >= queue.length) { engine.stop(); return; }
      const cur = queue[ni];
      set({ index: ni });
      engine.setSrc(await makeUrl(cur.path));
      await engine.play();
    },
    async prev() {
      const { queue, index } = get();
      if (engine.element.currentTime > 3) { engine.seek(0); return; }
      const ni = Math.max(0, index - 1);
      const cur = queue[ni];
      set({ index: ni });
      engine.setSrc(await makeUrl(cur.path));
      await engine.play();
    },
    seek(sec) { engine.seek(sec); },
    setVolume(v) { engine.setVolume(v); set({ volume: v }); },
    setLikedIds(ids) { set({ likedIds: new Set(ids) }); },
    async toggleLike(trackId) {
      const liked = await window.mp.likes.toggle(trackId);
      set((s) => {
        const next = new Set(s.likedIds);
        if (liked) next.add(trackId); else next.delete(trackId);
        return { likedIds: next };
      });
    },
  };
});
