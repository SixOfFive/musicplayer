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

export type RepeatMode = 'off' | 'all' | 'one';

export interface RadioNowPlaying {
  station: string;      // display name
  streamUrl: string;    // actual URL we're pulling from
  homepage: string | null;
  favicon: string | null;
  country: string | null;
  codec: string | null;
  bitrate: number | null;
  // ICY `StreamTitle` scraped by the main-process sniffer. null before the
  // first metadata frame arrives, or on servers / HLS streams that don't
  // support inline metadata. Updated in-place as the on-air track changes.
  nowPlaying: string | null;
}

interface PlayerState {
  // The "play order" — this is what next/prev walk. When shuffle is on,
  // this is a shuffled permutation of `originalQueue`.
  queue: QueueItem[];
  // Canonical list order from the view that invoked play(). Used to restore
  // the non-shuffled order when shuffle turns off. The displayed list never
  // changes based on shuffle — it's the play order that does.
  originalQueue: QueueItem[];
  index: number;
  isPlaying: boolean;
  volume: number;
  position: number;
  duration: number;
  likedIds: Set<number>;

  repeatMode: RepeatMode;
  shuffle: boolean;

  // Radio mode: set when playing an internet radio stream. When non-null,
  // `queue` is empty and track-oriented UI (prev/next/like/scrubber) is
  // downgraded in the NowPlayingBar.
  radio: RadioNowPlaying | null;

  play(items: QueueItem[], startIndex?: number): Promise<void>;
  playRadio(station: RadioNowPlaying): Promise<void>;
  toggle(): void;
  next(): void;
  prev(): void;
  seek(sec: number): void;
  setVolume(v: number): void;
  setLikedIds(ids: number[]): void;
  toggleLike(trackId: number): Promise<void>;

  setRepeatMode(m: RepeatMode): void;
  cycleRepeat(): void;
  setShuffle(on: boolean): void;
  toggleShuffle(): void;
}

async function makeUrl(p: string) {
  return window.mp.library.fileUrl(p);
}

/**
 * Fisher–Yates shuffle of every item AFTER the pinned index. The currently-
 * playing track stays at position 0 of the result so the song you're hearing
 * doesn't jump mid-track when you flip shuffle on.
 */
function shuffleKeepingHead<T>(items: T[], pinIndex: number): T[] {
  if (items.length <= 1) return [...items];
  const out = [...items];
  // Move the pinned item to the front.
  if (pinIndex > 0 && pinIndex < out.length) {
    const [pinned] = out.splice(pinIndex, 1);
    out.unshift(pinned);
  }
  // Shuffle the tail.
  for (let i = out.length - 1; i > 1; i--) {
    const j = 1 + Math.floor(Math.random() * i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const usePlayer = create<PlayerState>((set, get) => {
  const engine = getAudioEngine();

  // Volume persistence. Saved to settings.playback.volume with a debounce so
  // dragging the slider doesn't slam the JSON file every frame.
  let volumeSaveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleVolumeSave(v: number) {
    if (volumeSaveTimer) clearTimeout(volumeSaveTimer);
    volumeSaveTimer = setTimeout(() => {
      volumeSaveTimer = null;
      void window.mp.settings.set({ playback: { volume: v } } as any);
    }, 300);
  }
  // Apply persisted audio settings at startup — volume and the equalizer
  // curve. The EqualizerPanel also does this when it mounts, but that only
  // fires if the user opens the collapsible EQ section. Doing it here means
  // a saved EQ preset is in effect from the first sample of audio.
  window.mp.settings.get().then((s: any) => {
    const v = s?.playback?.volume;
    if (typeof v === 'number' && v >= 0 && v <= 1) {
      engine.setVolume(v);
      set({ volume: v });
    }
    const p = s?.playback ?? {};
    const enabled = !!p.eqEnabled;
    const gains = Array.isArray(p.eqGainsDb) && p.eqGainsDb.length === 10
      ? p.eqGainsDb
      : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const preamp = typeof p.eqPreamp === 'number' ? p.eqPreamp : 0;
    engine.setEq(enabled, gains, preamp);
  }).catch(() => { /* fall back to defaults */ });

  // --- Listening-time accounting ---------------------------------------------
  let accountingTrackId: number | null = null;
  let accountingDurationSec: number | null = null;
  let accountedSec = 0;
  let lastTickAt: number | null = null;
  const MIN_RECORD_SEC = 5;

  // Track metadata kept alongside the track ID so scrobbling (which wants
  // artist + title, not a numeric ID) can fire without re-querying the DB.
  let accountingArtist: string | null = null;
  let accountingTitle: string | null = null;
  let accountingAlbum: string | null = null;
  let accountingStartedAt = 0; // epoch seconds — passed to track.scrobble

  function startAccounting(trackId: number, durationSec: number | null, artist: string | null, title: string, album: string | null) {
    accountingTrackId = trackId;
    accountingDurationSec = durationSec;
    accountedSec = 0;
    lastTickAt = null;
    accountingArtist = artist;
    accountingTitle = title;
    accountingAlbum = album;
    accountingStartedAt = Math.floor(Date.now() / 1000);

    // Last.fm: mark as "now playing" on the user's profile. Fire-and-forget;
    // the IPC no-ops when no session key exists or scrobbling is disabled.
    if (artist) {
      void window.mp.lastfm.nowPlaying({
        artist, track: title,
        album: album ?? null,
        durationSec: durationSec ?? null,
      });
    }
  }

  function flushAccounting(completed: boolean) {
    if (accountingTrackId != null && accountedSec >= MIN_RECORD_SEC) {
      void window.mp.stats.recordPlay(accountingTrackId, accountedSec, completed);
    }
    // Last.fm scrobble rule: submit if listened ≥ 30 sec AND (≥ 4 min OR
    // ≥ 50% of track duration). If we don't know duration, only the 30-sec
    // floor applies (Last.fm accepts this for streams with unknown length).
    if (accountingArtist && accountingTitle && accountedSec >= 30) {
      const d = accountingDurationSec ?? 0;
      const halfway = d > 0 && accountedSec >= d * 0.5;
      const fourMin = accountedSec >= 240;
      if (d === 0 || halfway || fourMin) {
        void window.mp.lastfm.scrobble({
          artist: accountingArtist,
          track: accountingTitle,
          album: accountingAlbum,
          durationSec: d > 0 ? d : null,
          playedAt: accountingStartedAt,
        });
      }
    }
    accountingTrackId = null;
    accountingDurationSec = null;
    accountingArtist = null;
    accountingTitle = null;
    accountingAlbum = null;
    accountedSec = 0;
    lastTickAt = null;
  }

  async function loadAndPlay(cur: QueueItem) {
    const url = await makeUrl(cur.path);
    // Local files go through our mp-media:// protocol which supports CORS.
    // Setting crossOrigin before src is required for the MediaElementSource
    // → AnalyserNode chain to see audio samples (otherwise Web Audio returns
    // silent buffers for privacy reasons). Radio stations may have turned
    // this off; restore it every time we play a local track.
    engine.element.crossOrigin = 'anonymous';
    // Honour the current repeat-one setting on every new track load — the
    // previous track may have left loop=false (or we're coming back from
    // radio mode, which cleared the attribute).
    engine.element.loop = (get().repeatMode === 'one');
    engine.setSrc(url);
    // Prime the displayed duration from the DB-parsed tag value so the right-
    // hand time readout shows something immediately. The HTMLAudioElement's
    // own duration field is usually NaN or 0 for the first few frames —
    // especially for formats without a header-declared length (MP3 CBR
    // without Xing header, some FLACs). `loadedmetadata` / `durationchange`
    // below will upgrade to the element's exact value once it's known.
    if (typeof cur.durationSec === 'number' && cur.durationSec > 0) {
      set({ duration: cur.durationSec });
    } else {
      set({ duration: 0 });
    }
    startAccounting(cur.id, cur.durationSec, cur.artist, cur.title, cur.album);
    try { await engine.play(); }
    catch (err) { console.error('[player] engine.play failed', err); }
  }

  // tick
  engine.element.addEventListener('timeupdate', () => {
    set({ position: engine.element.currentTime });
    if (!engine.element.paused && accountingTrackId != null) {
      const now = performance.now();
      if (lastTickAt != null) {
        const dt = (now - lastTickAt) / 1000;
        if (dt > 0 && dt < 2.0) accountedSec += dt;
      }
      lastTickAt = now;
    }
  });
  // Only upgrade our displayed duration if the element produces a FINITE
  // positive number. For MP3s without a Xing/VBR header the browser reports
  // `Infinity` or `NaN` until it's scanned enough of the file — during that
  // window we want to keep the tag-derived value from loadAndPlay, not
  // clobber it with 0. `durationchange` fires whenever the element updates
  // its internal duration; hook it alongside `loadedmetadata`.
  const applyElementDuration = () => {
    const d = engine.element.duration;
    if (Number.isFinite(d) && d > 0) {
      set({ duration: d });
    }
  };
  engine.element.addEventListener('loadedmetadata', applyElementDuration);
  engine.element.addEventListener('durationchange', applyElementDuration);
  engine.element.addEventListener('ended', async () => {
    const s = get();
    // Final accounting for the just-completed track.
    if (accountingDurationSec) accountedSec = Math.max(accountedSec, accountingDurationSec);
    flushAccounting(true);

    // Repeat-one: restart the same track.
    if (s.repeatMode === 'one') {
      const cur = s.queue[s.index];
      if (cur) {
        engine.seek(0);
        startAccounting(cur.id, cur.durationSec, cur.artist, cur.title, cur.album);
        try { await engine.play(); } catch { /* ignore */ }
      }
      return;
    }

    const ni = s.index + 1;
    if (ni >= s.queue.length) {
      // End of queue.
      if (s.repeatMode === 'all' && s.queue.length > 0) {
        set({ index: 0 });
        await loadAndPlay(s.queue[0]);
      } else {
        engine.stop();
      }
      return;
    }
    set({ index: ni });
    await loadAndPlay(s.queue[ni]);
  });
  engine.element.addEventListener('play', () => { set({ isPlaying: true }); lastTickAt = performance.now(); });
  engine.element.addEventListener('pause', () => { set({ isPlaying: false }); lastTickAt = null; });

  window.addEventListener('beforeunload', () => {
    const completed = accountingDurationSec ? accountedSec / accountingDurationSec > 0.5 : false;
    flushAccounting(completed);
    // Tear down any active ICY sniffer so the main process closes its HTTP
    // connection before we exit.
    try { window.mp.radio.stopSniff(); } catch { /* noop */ }
  });

  // Subscribe to ICY metadata pushes from main. Main only emits when the
  // currently-playing station matches — we also double-check streamUrl here
  // so a stale event for a previous station can't overwrite current title.
  window.mp.radio.onNowPlaying(({ streamUrl, title }) => {
    const s = get();
    if (!s.radio || s.radio.streamUrl !== streamUrl) return;
    console.log(`[player] radio nowPlaying | "${title ?? '(none)'}"`);
    set({ radio: { ...s.radio, nowPlaying: title } });
  });

  return {
    queue: [],
    originalQueue: [],
    index: -1,
    isPlaying: false,
    volume: 0.8,
    position: 0,
    duration: 0,
    likedIds: new Set<number>(),
    repeatMode: 'off',
    shuffle: false,
    radio: null,

    async play(items, startIndex = 0) {
      flushAccounting(accountingDurationSec ? accountedSec / accountingDurationSec > 0.5 : false);
      // Switching to local files clears radio mode. Also stop the ICY sniffer
      // — it's a separate main-process HTTP connection that otherwise leaks
      // until the next playRadio or app exit.
      try { window.mp.radio.stopSniff(); } catch { /* noop */ }
      set({ radio: null });

      // Honour the current shuffle toggle: if on, reshuffle the new queue.
      const { shuffle } = get();
      const original = [...items];
      let playQueue = original;
      let startIdx = startIndex;
      if (shuffle) {
        playQueue = shuffleKeepingHead(original, startIndex);
        startIdx = 0;
      }

      set({ originalQueue: original, queue: playQueue, index: startIdx });
      const cur = playQueue[startIdx];
      if (!cur) return;
      console.log(`[player] play | title="${cur.title}" | shuffle=${shuffle} | queueLen=${playQueue.length}`);
      await loadAndPlay(cur);
    },

    async playRadio(station) {
      // End whatever local-file listening was in progress (flush stats first).
      flushAccounting(accountingDurationSec ? accountedSec / accountingDurationSec > 0.5 : false);
      // Radio can't be scrobbled / counted as a track play — clear accounting.
      // (Last.fm's scrobble API requires a specific track+artist match with a
      // user's catalog; ICY stream metadata would need parsing first — out
      // of scope for the MVP.)
      accountingTrackId = null;
      accountingDurationSec = null;
      accountingArtist = null;
      accountingTitle = null;
      accountingAlbum = null;
      accountedSec = 0;
      lastTickAt = null;

      // Normalize incoming station shape — callers may not set `nowPlaying`,
      // but the reducer expects it to exist. Start null; the ICY sniffer
      // fills it in as track metadata arrives.
      const fresh: RadioNowPlaying = { ...station, nowPlaying: null };
      set({ radio: fresh, queue: [], originalQueue: [], index: -1, duration: 0, position: 0 });
      console.log(`[player] playRadio | station="${station.station}" | url=${station.streamUrl}`);
      // crossOrigin='anonymous' is required for MediaElementSource to see
      // audio samples. The main process injects `Access-Control-Allow-Origin:
      // *` on every response (see electron/main.ts), so servers that don't
      // natively send CORS headers appear CORS-approved to the browser.
      // Result: both visualizer and audio work on raw radio streams.
      engine.element.crossOrigin = 'anonymous';
      engine.setSrc(station.streamUrl);
      try { await engine.play(); }
      catch (err) { console.error('[player] radio play failed', err); }

      // Kick off ICY metadata sniff. IPC handler no-ops when the URL ends in
      // .m3u8 or the server doesn't advertise `icy-metaint`.
      try { await window.mp.radio.startSniff(station.streamUrl); }
      catch (err) { console.error('[player] radio startSniff failed', err); }
    },

    toggle() {
      if (engine.element.paused) engine.play();
      else engine.pause();
    },

    async next() {
      const s = get();
      flushAccounting(accountingDurationSec ? accountedSec / accountingDurationSec > 0.5 : false);
      if (s.queue.length === 0) return;
      let ni = s.index + 1;
      if (ni >= s.queue.length) {
        if (s.repeatMode === 'all') ni = 0;
        else { engine.stop(); return; }
      }
      set({ index: ni });
      await loadAndPlay(s.queue[ni]);
    },

    async prev() {
      const s = get();
      if (engine.element.currentTime > 3) { engine.seek(0); return; }
      flushAccounting(accountingDurationSec ? accountedSec / accountingDurationSec > 0.5 : false);
      if (s.queue.length === 0) return;
      let ni = s.index - 1;
      if (ni < 0) {
        if (s.repeatMode === 'all') ni = s.queue.length - 1;
        else ni = 0;
      }
      set({ index: ni });
      await loadAndPlay(s.queue[ni]);
    },

    seek(sec) { engine.seek(sec); },
    setVolume(v) { engine.setVolume(v); set({ volume: v }); scheduleVolumeSave(v); },
    setLikedIds(ids) { set({ likedIds: new Set(ids) }); },
    async toggleLike(trackId) {
      const liked = await window.mp.likes.toggle(trackId);
      set((s) => {
        const next = new Set(s.likedIds);
        if (liked) next.add(trackId); else next.delete(trackId);
        return { likedIds: next };
      });
    },

    setRepeatMode(m) {
      // Use the HTMLAudioElement's native `loop` for repeat-one — it's more
      // reliable than restarting on the 'ended' event (which occasionally
      // fails to re-trigger on some codecs). For 'off' / 'all', leave loop
      // disabled so the 'ended' handler can advance the queue.
      engine.element.loop = (m === 'one');
      set({ repeatMode: m });
    },
    cycleRepeat() {
      const order: RepeatMode[] = ['off', 'all', 'one'];
      const s = get();
      const next = order[(order.indexOf(s.repeatMode) + 1) % order.length];
      engine.element.loop = (next === 'one');
      set({ repeatMode: next });
    },

    setShuffle(on) {
      const s = get();
      if (on === s.shuffle && on === true) {
        // Clicking shuffle while already on re-shuffles (with the current track pinned).
        const curId = s.queue[s.index]?.id;
        const origIdx = s.originalQueue.findIndex((t) => t.id === curId);
        const shuffled = shuffleKeepingHead(s.originalQueue, Math.max(0, origIdx));
        set({ queue: shuffled, index: 0 });
        return;
      }
      if (on) {
        if (s.queue.length === 0) { set({ shuffle: true }); return; }
        const curId = s.queue[s.index]?.id;
        const origIdx = s.originalQueue.findIndex((t) => t.id === curId);
        const shuffled = shuffleKeepingHead(s.originalQueue, Math.max(0, origIdx));
        set({ shuffle: true, queue: shuffled, index: 0 });
      } else {
        // Restore original order — point `index` at whatever track was current.
        const curId = s.queue[s.index]?.id;
        const origIdx = s.originalQueue.findIndex((t) => t.id === curId);
        set({
          shuffle: false,
          queue: [...s.originalQueue],
          index: Math.max(0, origIdx),
        });
      }
    },
    toggleShuffle() {
      const s = get();
      // If shuffle is on, clicking turns it OFF. If off, turn on (and shuffle once).
      get().setShuffle(!s.shuffle);
    },
  };
});
