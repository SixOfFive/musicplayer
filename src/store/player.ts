import { create } from 'zustand';
import { getAudioEngine } from '../audio/AudioEngine';
import { useCast } from './cast';
import { useHomeAssistant } from './homeassistant';

/**
 * Timestamp of the most recent user-initiated Cast seek. The status
 * subscriber below ignores the `currentTime` field for a grace window
 * after this so the device's pre-seek position doesn't tug-of-war
 * with the UI's optimistic update. Module-scope so both the `seek`
 * action inside the store closure and the out-of-store subscriber
 * can read/write it.
 */
let lastUserCastSeekAt = 0;
const CAST_SEEK_GRACE_MS = 2500; // covers the device's typical seek-to-play settle time

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
    // Route-by-sink. Exactly one of these stores has a non-null active
    // id at any time (OutputDevicePicker enforces that by stopping one
    // before activating the other). If nothing's picked we fall through
    // to local playback via the shared <audio> element.
    const castId  = useCast.getState().activeDeviceId;
    const haEntId = useHomeAssistant.getState().activeEntityId;
    if (castId || haEntId) {
      // Pause local in case a previous track was still on it.
      try { engine.pause(); } catch { /* noop */ }
      if (typeof cur.durationSec === 'number' && cur.durationSec > 0) {
        set({ duration: cur.durationSec, isPlaying: true });
      } else {
        set({ duration: 0, isPlaying: true });
      }
      startAccounting(cur.id, cur.durationSec, cur.artist, cur.title, cur.album);
      try {
        if (castId) {
          await (window.mp as any).cast.play(castId, cur.path, {
            title: cur.title,
            artist: cur.artist ?? undefined,
            album: cur.album ?? undefined,
          });
        } else if (haEntId) {
          await (window.mp as any).ha.play(haEntId, cur.path, {
            title: cur.title,
            artist: cur.artist ?? undefined,
            album: cur.album ?? undefined,
          });
        }
      } catch (err: any) {
        console.error(`[player] remote play failed: ${err?.message ?? err}`);
        set({ isPlaying: false });
      }
      return;
    }

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
    console.log(`[player] 'ended' event fired | repeatMode=${s.repeatMode} | element.loop=${engine.element.loop} | queueIdx=${s.index}/${s.queue.length}`);
    // Final accounting for the just-completed track.
    if (accountingDurationSec) accountedSec = Math.max(accountedSec, accountingDurationSec);
    flushAccounting(true);

    // Repeat-one is handled by `element.loop = true` (set by setRepeatMode /
    // cycleRepeat / loadAndPlay). When loop is true, Chromium seeks to 0 +
    // continues playing AND does not fire `ended`, so this handler shouldn't
    // even reach here for repeat-one. If it does (stale HMR state, browser
    // quirk), just no-op — do NOT call engine.play() again, because that can
    // race with an in-flight play() invoked elsewhere and throw AbortError,
    // which leaves the element stuck in a state where subsequent play/pause
    // calls silently fail and the position counter freezes.
    if (s.repeatMode === 'one') {
      console.log('[player] repeat-one: ended fired unexpectedly — relying on native loop, no manual restart');
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

  // Track the IDs we've already tried and failed on within the current
  // auto-advance sweep. Prevents an infinite loop when MULTIPLE tracks in
  // the queue are broken — each one errors, we advance to the next,
  // THAT one errors, we advance again, etc. Cleared whenever playback
  // actually succeeds (a `play` event fires) or the user issues a new
  // top-level `play([...])` command.
  const failedTrackIds = new Set<number>();
  engine.element.addEventListener('play', () => { failedTrackIds.clear(); });

  /**
   * The element entered error state — file missing (ENOENT on the mp-media
   * handler), decode failure (bad header, unsupported codec), network drop,
   * etc. Without this handler the UI would freeze with a stuck pause-
   * button icon because neither `play` nor `pause` fires when the element
   * rejects the source — isPlaying keeps whatever value it had from the
   * previous track and the scrubber stops moving.
   *
   * Recovery policy:
   *   1. Force isPlaying=false so the button goes back to a usable state.
   *   2. If there's another track in the queue we haven't already failed
   *      on in this sweep, advance to it automatically. This is the
   *      common case — one dead file shouldn't halt a whole playlist.
   *   3. If every remaining track has failed (or we're at the end of the
   *      queue), stop cleanly. The user sees a stopped player rather than
   *      a frozen one.
   */
  engine.element.addEventListener('error', async () => {
    const s = get();
    const cur = s.queue[s.index];
    const errSrc = engine.element.src;
    const errCode = engine.element.error?.code;
    const errMsg = engine.element.error?.message ?? '';
    console.warn(`[player] audio error recovery | src=${errSrc} code=${errCode} msg=${errMsg} curId=${cur?.id}`);

    // Always drop isPlaying — the UI should reflect "not playing" because
    // we genuinely aren't.
    set({ isPlaying: false, position: 0 });
    lastTickAt = null;

    // Radio-mode errors (stream dropped) — different recovery path. For
    // now, just clear radio and stop. User can click a station again.
    if (s.radio) {
      console.warn('[player] radio stream errored, clearing radio mode');
      set({ radio: null });
      return;
    }

    if (cur) failedTrackIds.add(cur.id);

    // Find the next queue item we haven't already failed on. Respect
    // repeat-all (wrap around the queue) but never try an ID we just
    // failed, to avoid a tight retry loop.
    if (s.queue.length === 0) return;
    let tried = 0;
    let ni = s.index;
    while (tried < s.queue.length) {
      ni = ni + 1;
      if (ni >= s.queue.length) {
        if (s.repeatMode === 'all') ni = 0;
        else break;
      }
      const candidate = s.queue[ni];
      if (!failedTrackIds.has(candidate.id)) {
        console.log(`[player] auto-advancing past errored track → "${candidate.title}"`);
        set({ index: ni });
        await loadAndPlay(candidate);
        return;
      }
      tried++;
    }
    console.warn('[player] every remaining track in the queue has failed; stopping');
  });

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
      // New top-level play command: reset the "tracks we've given up on"
      // set. Without this, a user who restores a file that was previously
      // broken would still have the player skip past it because its id is
      // still remembered from the last failure sweep.
      failedTrackIds.clear();
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
      // When a remote sink (Cast or HA) is active, transport proxies
      // to it — local <audio> element is paused and doesn't know the
      // true play state. The store's `isPlaying` is the truth.
      const castId  = useCast.getState().activeDeviceId;
      const haEntId = useHomeAssistant.getState().activeEntityId;
      if (castId || haEntId) {
        const s = get();
        const remote: any = castId ? (window.mp as any).cast : (window.mp as any).ha;
        if (s.isPlaying) { void remote.pause();  set({ isPlaying: false }); }
        else             { void remote.resume(); set({ isPlaying: true }); }
        return;
      }

      // Self-heal: if the element is in error state (file deleted out from
      // under us by Shrink / Rescan, decode error, network blip on an HLS
      // stream), a plain `play()` here will reject with the same error —
      // the element never recovers on its own. Rebuild from the current
      // queue item so the user can get moving again without navigating
      // away.
      //
      // Symptom this fixes: "I clicked play again and nothing happened" /
      // "I can't scrub anymore" — after the FLAC we were playing got
      // converted to MP3 (or the album was rescanned and the file was
      // missing), the element's internal error blocks all further input.
      const s = get();
      if (engine.element.error && s.queue[s.index]) {
        console.warn(`[player] toggle: element in error state (code=${engine.element.error.code} msg=${engine.element.error.message ?? ''}) — reloading current track`);
        void loadAndPlay(s.queue[s.index]);
        return;
      }
      if (engine.element.paused) {
        // Swallow the promise so a double-click (play-then-pause-then-play)
        // AbortError doesn't escape as an unhandled rejection. engine.play
        // already logs failures.
        engine.play().catch(() => { /* logged inside engine.play */ });
      } else {
        engine.pause();
      }
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
      // "If we're more than 3 seconds into the track, rewind to the start;
      // otherwise go to the previous track in the queue." This is the
      // standard music-player ⏮ behaviour.
      //
      // When casting, we MUST read the position from store state (which the
      // cast-status subscriber below keeps synced with the actual device)
      // and route the rewind through cast.seek — NOT `engine.seek(0)`.
      // The local <audio> element is paused and its currentTime is a stale
      // left-over from before the cast handoff; seeking it is a no-op that
      // the user sees as "rewind broke, speaker kept going."
      const castId  = useCast.getState().activeDeviceId;
      const haEntId = useHomeAssistant.getState().activeEntityId;
      const remoting = !!(castId || haEntId);
      const currentPos = remoting ? s.position : engine.element.currentTime;
      if (currentPos > 3) {
        if (remoting) {
          set({ position: 0 });
          lastUserCastSeekAt = Date.now();
          const remote: any = castId ? (window.mp as any).cast : (window.mp as any).ha;
          remote.seek(0).catch((err: any) => {
            console.warn(`[player] prev→remote.seek(0) rejected: ${err?.message ?? err}`);
          });
        } else {
          engine.seek(0);
        }
        return;
      }
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

    seek(sec) {
      // When casting, route the seek to the Cast device. The local
      // <audio> element's currentTime is irrelevant (it's paused and
      // never decoded the track in the first place), so setting it
      // does nothing useful.
      //
      // Two things to get right here, or the scrubber fights the user:
      //
      //   1. OPTIMISTIC UI. Set the scrubber to the target immediately.
      //      The device acts on the seek command in ~300-800ms; during
      //      that window the status poll keeps reporting the PRE-seek
      //      position. Without suppression the scrubber snaps back to
      //      the old spot, the user thinks the click did nothing, and
      //      clicks again — classic tug-of-war. The status subscriber
      //      below checks `lastUserCastSeekAt` and ignores incoming
      //      positions for a grace window after a user-initiated seek.
      //
      //   2. STATE FILTERING. Cast receivers briefly pass through
      //      BUFFERING (and sometimes IDLE) right after a seek. If we
      //      naively mirror those into isPlaying=false the UI shows
      //      "paused" until the next poll cycle and the user thinks
      //      the track stopped. The subscriber filters to only
      //      PLAYING/PAUSED — the only two states that actually
      //      correspond to a user-visible intent.
      const castId  = useCast.getState().activeDeviceId;
      const haEntId = useHomeAssistant.getState().activeEntityId;
      if (castId || haEntId) {
        set({ position: sec });
        lastUserCastSeekAt = Date.now();
        const remote: any = castId ? (window.mp as any).cast : (window.mp as any).ha;
        remote.seek(sec).catch((err: any) => {
          console.warn(`[player] remote.seek(${sec}) rejected: ${err?.message ?? err}`);
        });
        return;
      }

      // Same self-heal as toggle(): if the element is in error state, setting
      // currentTime is a no-op and the scrubber locks at 0. Reload the
      // current track first, then jump to the requested position once the
      // element has data.
      const s = get();
      if (engine.element.error && s.queue[s.index]) {
        console.warn(`[player] seek(${sec}): element in error state — reloading current track then seeking`);
        const seekTo = sec;
        void loadAndPlay(s.queue[s.index]).then(() => {
          // loadAndPlay just set src + started play; wait for the element to
          // have enough data to seek reliably. `loadedmetadata` is the
          // earliest point seeking is valid.
          const apply = () => { engine.seek(seekTo); engine.element.removeEventListener('loadedmetadata', apply); };
          if (Number.isFinite(engine.element.duration) && engine.element.duration > 0) apply();
          else engine.element.addEventListener('loadedmetadata', apply, { once: true });
        });
        return;
      }
      engine.seek(sec);
    },
    setVolume(v) {
      engine.setVolume(v);
      set({ volume: v });
      scheduleVolumeSave(v);
      // Mirror to whichever remote sink is active so the same slider
      // controls whatever's actually making sound. Remote devices run
      // their own hardware volume; we push the 0..1 normalised value
      // and the receiver scales it to its native range.
      if (useCast.getState().activeDeviceId) {
        void (window.mp as any).cast.setVolume(v);
      } else if (useHomeAssistant.getState().activeEntityId) {
        void (window.mp as any).ha.setVolume(v);
      }
    },
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
      console.log(`[player] setRepeatMode(${m}) | element.loop=${engine.element.loop}`);
      set({ repeatMode: m });
    },
    cycleRepeat() {
      const order: RepeatMode[] = ['off', 'all', 'one'];
      const s = get();
      const next = order[(order.indexOf(s.repeatMode) + 1) % order.length];
      engine.element.loop = (next === 'one');
      console.log(`[player] cycleRepeat ${s.repeatMode} → ${next} | element.loop=${engine.element.loop}`);
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

// --- Cast status → player state bridge ---------------------------------------
// When a Cast device is active, the local <audio> element is paused and
// therefore never fires timeupdate / loadedmetadata / play / pause events.
// The NowPlayingBar's scrubber and play/pause icon normally read from
// those events; without a bridge, they'd freeze at whatever values they
// had when casting started.
//
// Fix: the cast store holds `lastStatus`, which is set by an IPC
// subscription against the main-process `cast:status` event (fired
// ~1 Hz by the active device). Here we subscribe to changes on that
// slice and mirror the useful fields into player state. Zustand's
// `subscribe` gives us a clean top-of-module place to do it without
// importing usePlayer from the cast store (which would be a circular
// import; cast is imported by player, not the other way around).
useCast.subscribe((cast) => {
  const s = cast.lastStatus;
  if (!s) return;
  // Ignore stragglers from a device we've since switched away from.
  if (cast.activeDeviceId !== s.deviceId) return;

  const patch: Partial<{ position: number; duration: number; isPlaying: boolean }> = {};

  // --- Position mirroring with post-seek grace window ----------------------
  // Right after the user clicks/drags the scrubber, the device needs
  // ~300-800ms to act on the seek command. During that window the poll
  // keeps reporting the PRE-seek position and — without this guard — the
  // scrubber snaps back to where it was, making it feel like the click
  // did nothing. Suppress position updates for CAST_SEEK_GRACE_MS after
  // the user's most recent seek; duration/playerState still update normally.
  const withinSeekGrace = Date.now() - lastUserCastSeekAt < CAST_SEEK_GRACE_MS;
  if (!withinSeekGrace && Number.isFinite(s.currentTime)) {
    patch.position = s.currentTime;
  }

  if (typeof s.duration === 'number' && s.duration > 0) patch.duration = s.duration;

  // --- isPlaying filtering -------------------------------------------------
  // Only PLAYING and PAUSED represent stable user-visible states. BUFFERING
  // and IDLE are transients the receiver passes through during:
  //   - initial media load (briefly IDLE → BUFFERING → PLAYING)
  //   - every seek (briefly BUFFERING)
  //   - between tracks (briefly IDLE before the next load fires)
  // Mirroring those into isPlaying makes the play/pause icon blink and
  // the user thinks playback stopped. Ignore them — the next PLAYING
  // or PAUSED tick will correct the UI if needed.
  if (s.playerState === 'PLAYING') patch.isPlaying = true;
  else if (s.playerState === 'PAUSED') patch.isPlaying = false;

  if (Object.keys(patch).length > 0) usePlayer.setState(patch as any);
});

// --- Home Assistant status → player state bridge -----------------------------
// Same logic as the Cast bridge above — we duplicate rather than abstract
// because the two stores have different field names (deviceId vs entityId)
// and different `active*` accessors, and splitting a tiny subscribe body
// into a factory would obscure the grace-window + state-filtering rationale.
useHomeAssistant.subscribe((ha) => {
  const s = ha.lastStatus;
  if (!s) return;
  if (ha.activeEntityId !== s.entityId) return;

  const patch: Partial<{ position: number; duration: number; isPlaying: boolean }> = {};

  // `lastUserCastSeekAt` is misnamed now that HA seeks use the same
  // latch, but sharing the timestamp is the whole point — one user
  // action, one grace window, regardless of sink. Renaming would ripple
  // through `seek()` / `prev()` for no behaviour change.
  const withinSeekGrace = Date.now() - lastUserCastSeekAt < CAST_SEEK_GRACE_MS;
  if (!withinSeekGrace && Number.isFinite(s.currentTime)) patch.position = s.currentTime;
  if (typeof s.duration === 'number' && s.duration > 0) patch.duration = s.duration;

  if (s.playerState === 'PLAYING') patch.isPlaying = true;
  else if (s.playerState === 'PAUSED') patch.isPlaying = false;

  if (Object.keys(patch).length > 0) usePlayer.setState(patch as any);
});

