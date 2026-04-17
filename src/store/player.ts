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

  // --- Listening-time accounting ---------------------------------------------
  // We accumulate audible seconds for the currently-loaded track and flush to
  // the stats IPC whenever:
  //   - the track changes (user skip, next, prev, new play() call)
  //   - the app window unloads (beforeunload)
  //   - the track ends (counts as completed)
  // Anything under 5 seconds is discarded — too noisy (misclicks, scrubbing).
  let accountingTrackId: number | null = null;
  let accountingDurationSec: number | null = null;
  let accountedSec = 0;           // sum of heard time on the current track
  let lastTickAt: number | null = null;
  const MIN_RECORD_SEC = 5;

  function startAccounting(trackId: number, durationSec: number | null) {
    accountingTrackId = trackId;
    accountingDurationSec = durationSec;
    accountedSec = 0;
    lastTickAt = null;
  }

  function flushAccounting(completed: boolean) {
    if (accountingTrackId != null && accountedSec >= MIN_RECORD_SEC) {
      // Fire-and-forget; main handles errors.
      void window.mp.stats.recordPlay(accountingTrackId, accountedSec, completed);
    }
    accountingTrackId = null;
    accountingDurationSec = null;
    accountedSec = 0;
    lastTickAt = null;
  }

  // Tick while playing. Uses wall-clock deltas instead of audio currentTime so
  // we don't count scrubs/seeks as extra listening.
  engine.element.addEventListener('timeupdate', () => {
    set({ position: engine.element.currentTime });
    if (!engine.element.paused && accountingTrackId != null) {
      const now = performance.now();
      if (lastTickAt != null) {
        const dt = (now - lastTickAt) / 1000;
        // Clamp per-tick delta so a long tab-suspend or big seek doesn't inflate.
        if (dt > 0 && dt < 2.0) accountedSec += dt;
      }
      lastTickAt = now;
    }
  });
  engine.element.addEventListener('loadedmetadata', () => {
    set({ duration: engine.element.duration || 0 });
  });
  engine.element.addEventListener('ended', () => {
    // Ensure we count the final sliver before flushing.
    if (accountingDurationSec) accountedSec = Math.max(accountedSec, accountingDurationSec);
    flushAccounting(true);
    get().next();
  });
  engine.element.addEventListener('play', () => { set({ isPlaying: true }); lastTickAt = performance.now(); });
  engine.element.addEventListener('pause', () => { set({ isPlaying: false }); lastTickAt = null; });

  // Flush on window close so partial listens aren't lost.
  window.addEventListener('beforeunload', () => {
    const completed = accountingDurationSec ? accountedSec / accountingDurationSec > 0.5 : false;
    flushAccounting(completed);
  });

  return {
    queue: [],
    index: -1,
    isPlaying: false,
    volume: 0.8,
    position: 0,
    duration: 0,
    likedIds: new Set<number>(),

    async play(items, startIndex = 0) {
      // Flush any in-flight listen on the previous track (user skipped to a new queue).
      flushAccounting(accountingDurationSec ? accountedSec / accountingDurationSec > 0.5 : false);
      set({ queue: items, index: startIndex });
      const cur = items[startIndex];
      if (!cur) return;
      const url = await makeUrl(cur.path);
      console.log(`[player] play | title="${cur.title}" | path=${cur.path} | url=${url}`);
      engine.setSrc(url);
      startAccounting(cur.id, cur.durationSec);
      try {
        await engine.play();
      } catch (err) {
        console.error('[player] engine.play failed', err);
      }
    },
    toggle() {
      if (engine.element.paused) engine.play();
      else engine.pause();
    },
    async next() {
      const { queue, index } = get();
      flushAccounting(accountingDurationSec ? accountedSec / accountingDurationSec > 0.5 : false);
      const ni = index + 1;
      if (ni >= queue.length) { engine.stop(); return; }
      const cur = queue[ni];
      set({ index: ni });
      engine.setSrc(await makeUrl(cur.path));
      startAccounting(cur.id, cur.durationSec);
      await engine.play();
    },
    async prev() {
      const { queue, index } = get();
      if (engine.element.currentTime > 3) { engine.seek(0); return; }
      flushAccounting(accountingDurationSec ? accountedSec / accountingDurationSec > 0.5 : false);
      const ni = Math.max(0, index - 1);
      const cur = queue[ni];
      set({ index: ni });
      engine.setSrc(await makeUrl(cur.path));
      startAccounting(cur.id, cur.durationSec);
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
