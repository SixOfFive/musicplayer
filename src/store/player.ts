import { create } from 'zustand';
import { getAudioEngine } from '../audio/AudioEngine';
import { useCast } from './cast';
import { useHomeAssistant } from './homeassistant';
import { useDlna } from './dlna';

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

  // --- Mid-playback playlist auto-refresh ---
  //
  // Set when play() is invoked FROM a playlist view (PlaylistView
  // passes a sourcePlaylistId option; everything else leaves it
  // null). While these are non-null, the engine's timeupdate handler
  // watches for "15s remaining" and fires a pl:check-refresh IPC to
  // see if the playlist's .m3u8 on disk changed since we loaded it.
  //
  //   queueSourcePlaylistId — the playlist id the queue was loaded
  //                           from. Cleared when any non-playlist
  //                           play() replaces the queue.
  //   queueSourceMtimeMs    — last-known disk mtime of that playlist's
  //                           .m3u8. Set on play-start (baseline
  //                           fetch), updated whenever a refresh
  //                           detects a newer mtime.
  //   queuePendingRefresh   — a refreshed queue that main sent back
  //                           the last time the check detected a
  //                           change. Applied on the 'ended' event
  //                           for the current track so playback
  //                           isn't interrupted mid-song.
  queueSourcePlaylistId: number | null;
  queueSourceMtimeMs: number | null;
  queuePendingRefresh: { newTracks: QueueItem[] } | null;

  play(items: QueueItem[], startIndex?: number, options?: { sourcePlaylistId?: number | null }): Promise<void>;
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
    const castId   = useCast.getState().activeDeviceId;
    const haEntId  = useHomeAssistant.getState().activeEntityId;
    const dlnaId   = useDlna.getState().activeDeviceId;
    if (castId || haEntId || dlnaId) {
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
        } else if (dlnaId) {
          await (window.mp as any).dlna.play(dlnaId, cur.path, {
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
      set({ duration: cur.durationSec, isPlaying: true });
    } else {
      set({ duration: 0, isPlaying: true });
    }
    startAccounting(cur.id, cur.durationSec, cur.artist, cur.title, cur.album);
    // Starting a brand-new track: position is 0 by definition. Set this
    // explicitly so the scrubber jumps to the left edge before the
    // first `timeupdate` event fires; otherwise the old track's
    // position value lingers for a frame which looks like the seek
    // didn't take.
    set({ position: 0 });
    // engine.play() can reject with an AbortError if the just-issued
    // load() interrupts the play request — typical path when the user
    // was paused, hit Next, and Chromium tore down the previous
    // play-intent before reissuing. The element queues the new src
    // internally but does NOT auto-resume after the rejection, so we
    // retry once the element signals it's playable. Without this,
    // advancing while paused would silently leave the new track loaded
    // but stopped — user sees the play button instead of pause.
    try {
      await engine.play();
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError' || /interrupted/i.test(err?.message ?? '');
      if (!isAbort) {
        console.error('[player] engine.play failed (non-abort)', err);
      }
      // Retry once the element has enough data to start. `canplay`
      // fires before `canplaythrough`, so we play at the earliest
      // opportunity. `{ once: true }` means the listener disposes
      // itself and won't fire for later tracks.
      const retry = () => {
        engine.play().catch((e2: any) => {
          // Swallow the second AbortError too — happens if the user
          // hits Next again before `canplay` fires. The third round
          // will self-correct. Non-abort errors are logged.
          const again = e2?.name === 'AbortError' || /interrupted/i.test(e2?.message ?? '');
          if (!again) console.error('[player] engine.play retry failed', e2);
        });
      };
      engine.element.addEventListener('canplay', retry, { once: true });
    }
  }

  // Fires once per currently-playing track when the
  // remaining-time-triggered refresh check has already been scheduled,
  // so the timeupdate listener below doesn't fire a dozen IPCs during
  // the last 15 seconds. Reset on every track change via the
  // loadAndPlay path's failedTrackIds.clear() neighbour.
  let refreshCheckedForTrackId: number | null = null;

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

    // Playlist mid-playback refresh: when the queue came from a
    // playlist view AND we're within the last 15 seconds of the
    // current track AND we haven't already fired the check for this
    // track, hit main's pl:check-refresh IPC. If the disk file's
    // mtime changed since our baseline, main returns a fresh track
    // list which we stash in `queuePendingRefresh` — applied in the
    // 'ended' handler so playback isn't interrupted mid-song. Gated
    // by accountingTrackId so it doesn't fire during the pre-play
    // window where position/duration haven't stabilised yet.
    const s = get();
    const cur = s.queue[s.index];
    const dur = engine.element.duration;
    if (
      !engine.element.paused &&
      s.queueSourcePlaylistId != null &&
      cur != null &&
      refreshCheckedForTrackId !== cur.id &&
      Number.isFinite(dur) && dur > 0 &&
      // "15 seconds left" — use element time directly so we don't
      // depend on the Zustand-synced `position` which lags one render.
      dur - engine.element.currentTime <= 15
    ) {
      refreshCheckedForTrackId = cur.id;
      const sourceId = s.queueSourcePlaylistId;
      const knownMtime = s.queueSourceMtimeMs;
      (window.mp.playlists as any).checkRefresh(sourceId, knownMtime)
        .then((r: any) => {
          // Confirm the queue hasn't been replaced by a different
          // play() in the meantime. If it has, drop this response
          // on the floor — applying stale data would shove the user
          // into an unrelated queue at track-end.
          if (get().queueSourcePlaylistId !== sourceId) return;
          if (!r) return;
          if (r.changed && Array.isArray(r.tracks)) {
            console.log(`[player] playlist ${sourceId} changed on disk — queuing refresh (${r.tracks.length} tracks)`);
            set({
              queuePendingRefresh: { newTracks: r.tracks },
              queueSourceMtimeMs: typeof r.mtimeMs === 'number' ? r.mtimeMs : get().queueSourceMtimeMs,
            });
          } else if (typeof r.mtimeMs === 'number') {
            // No change but main returned a fresh mtime — adopt it so
            // subsequent checks compare against the most current
            // baseline (unchanged or not, the number's authoritative).
            set({ queueSourceMtimeMs: r.mtimeMs });
          }
        })
        .catch((err: any) => {
          console.warn('[player] playlist refresh check failed (non-fatal):', err?.message ?? err);
        });
    }
  });
  // Reset the refresh-check latch whenever a new track starts loading
  // — ensures the NEXT track's 15s window gets its own IPC fire.
  engine.element.addEventListener('play', () => { refreshCheckedForTrackId = null; });
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

    // Apply a pending playlist refresh (if one is waiting). The 15s-
    // remaining watcher above may have detected that the playlist
    // file was modified on disk during playback — we deferred the
    // queue swap until here so the song wouldn't be interrupted.
    //
    // Target-track resolution per user spec: "try to play the song
    // in the playlist after the current playing song when the song
    // ends". In practice:
    //   1. Find the track we JUST finished (cur.id) in newTracks.
    //      If found, play the next one (or stop/wrap at end).
    //   2. Otherwise (current song was removed on the other machine),
    //      find the track that USED TO be next (s.queue[s.index+1])
    //      in newTracks. If it's still there, start playback from it.
    //   3. If neither the current nor the old-next is in newTracks,
    //      fall back to playing newTracks[0] so the user doesn't get
    //      an abrupt stop from a silent "track not found" chain.
    //      If newTracks is empty (playlist emptied), just stop.
    if (s.queuePendingRefresh) {
      const cur = s.queue[s.index];
      const oldNext = s.queue[s.index + 1];
      const newTracks = s.queuePendingRefresh.newTracks;
      console.log(`[player] applying queued playlist refresh (${newTracks.length} tracks); current=${cur?.id} oldNext=${oldNext?.id}`);
      set({ queuePendingRefresh: null });

      if (newTracks.length === 0) {
        // Playlist emptied on disk — nothing to play.
        set({ originalQueue: [], queue: [], index: -1 });
        engine.stop();
        return;
      }

      // 1. Current track still in the new list → play the one after it.
      if (cur) {
        const i = newTracks.findIndex((t) => t.id === cur.id);
        if (i >= 0) {
          const ni2 = i + 1;
          if (ni2 >= newTracks.length) {
            // At the end of the refreshed list. Honour repeat-all,
            // otherwise stop.
            if (s.repeatMode === 'all') {
              set({ originalQueue: newTracks, queue: newTracks, index: 0 });
              await loadAndPlay(newTracks[0]);
            } else {
              set({ originalQueue: newTracks, queue: newTracks, index: newTracks.length - 1 });
              engine.stop();
            }
            return;
          }
          set({ originalQueue: newTracks, queue: newTracks, index: ni2 });
          await loadAndPlay(newTracks[ni2]);
          return;
        }
      }

      // 2. Current gone from new list, but the OLD next-up is still
      //    there → play it.
      if (oldNext) {
        const j = newTracks.findIndex((t) => t.id === oldNext.id);
        if (j >= 0) {
          set({ originalQueue: newTracks, queue: newTracks, index: j });
          await loadAndPlay(newTracks[j]);
          return;
        }
      }

      // 3. Fallback — neither landmark survived the edit. Start from
      //    the top of the refreshed list so playback doesn't die.
      set({ originalQueue: newTracks, queue: newTracks, index: 0 });
      await loadAndPlay(newTracks[0]);
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

    // Probe the failed track's file in the background. If it's
    // genuinely missing AND the library dir it's under is healthy
    // (not an unmounted SMB share / empty root), main deletes the
    // DB row + broadcasts. We auto-advance past the dead file below
    // regardless — the probe just cleans up metadata so the user
    // doesn't keep seeing the ghost entry in Library / Album views.
    // Throttled main-side to 1 probe per track per 60s and gated by
    // the session-wide suspect flag, so a bad mount can't purge the
    // library just because playback errors spike.
    if (cur) {
      (window.mp.library as any).probeTrack?.(cur.id)
        .then((r: any) => {
          if (r?.removed) {
            console.log(`[player] probe-track removed "${r.title}" — file was missing and library dir is healthy`);
            window.dispatchEvent(new CustomEvent('mp-library-changed'));
          }
        })
        .catch(() => { /* silent — probe is best-effort */ });
    }

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
    queueSourcePlaylistId: null,
    queueSourceMtimeMs: null,
    queuePendingRefresh: null,

    async play(items, startIndex = 0, options) {
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

      // Playlist-source tracking. A `sourcePlaylistId` on the options
      // flags the queue as "came from a playlist view" → the timeupdate
      // watcher enables its 15s-remaining refresh check. Anything else
      // (play from Album / Artist / Library / Search) clears the
      // tracking so stale refresh attempts against the old playlist
      // don't fire. Also nuke any pending refresh from the prior queue.
      const sourcePlaylistId = options?.sourcePlaylistId ?? null;
      set({
        originalQueue: original,
        queue: playQueue,
        index: startIdx,
        queueSourcePlaylistId: sourcePlaylistId,
        queueSourceMtimeMs: null,
        queuePendingRefresh: null,
      });
      // Kick off a baseline mtime fetch so the first 15s-remaining
      // check has something to compare against. Fire-and-forget —
      // main returns quickly because baseline mode doesn't parse the
      // file. If the baseline fetch fails we just stay at null and
      // the first refresh check becomes the de-facto baseline.
      if (sourcePlaylistId != null) {
        (window.mp.playlists as any).checkRefresh(sourcePlaylistId, null)
          .then((r: any) => {
            // Only adopt the baseline if the queue we kicked off is
            // still the current one — if the user played something
            // else between the IPC round-trip and the response, we'd
            // stamp a baseline on the wrong queue.
            if (get().queueSourcePlaylistId === sourcePlaylistId && r?.mtimeMs != null) {
              set({ queueSourceMtimeMs: r.mtimeMs });
            }
          })
          .catch(() => { /* silent — baseline is best-effort */ });
      }
      const cur = playQueue[startIdx];
      if (!cur) return;
      console.log(`[player] play | title="${cur.title}" | shuffle=${shuffle} | queueLen=${playQueue.length} | sourcePlaylistId=${sourcePlaylistId}`);
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
      // Clear playlist-source tracking — we're no longer playing from a
      // playlist, so the 15s-remaining auto-refresh shouldn't fire.
      set({
        radio: fresh, queue: [], originalQueue: [], index: -1, duration: 0, position: 0,
        queueSourcePlaylistId: null, queueSourceMtimeMs: null, queuePendingRefresh: null,
      });
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
      // When a remote sink (Cast / HA / DLNA) is active, transport
      // proxies to it — local <audio> element is paused and doesn't
      // know the true play state. The store's `isPlaying` is the truth.
      const castId  = useCast.getState().activeDeviceId;
      const haEntId = useHomeAssistant.getState().activeEntityId;
      const dlnaId  = useDlna.getState().activeDeviceId;
      if (castId || haEntId || dlnaId) {
        const s = get();
        const remote: any =
          castId  ? (window.mp as any).cast :
          haEntId ? (window.mp as any).ha   :
                    (window.mp as any).dlna;
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
      const castId   = useCast.getState().activeDeviceId;
      const haEntId  = useHomeAssistant.getState().activeEntityId;
      const dlnaId   = useDlna.getState().activeDeviceId;
      const remoting = !!(castId || haEntId || dlnaId);
      const currentPos = remoting ? s.position : engine.element.currentTime;
      if (currentPos > 3) {
        if (remoting) {
          set({ position: 0 });
          lastUserCastSeekAt = Date.now();
          const remote: any =
            castId  ? (window.mp as any).cast :
            haEntId ? (window.mp as any).ha   :
                      (window.mp as any).dlna;
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
      const dlnaId  = useDlna.getState().activeDeviceId;
      if (castId || haEntId || dlnaId) {
        set({ position: sec });
        lastUserCastSeekAt = Date.now();
        const remote: any =
          castId  ? (window.mp as any).cast :
          haEntId ? (window.mp as any).ha   :
                    (window.mp as any).dlna;
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
      } else if (useDlna.getState().activeDeviceId) {
        void (window.mp as any).dlna.setVolume(v);
      }
    },
    setLikedIds(ids) { set({ likedIds: new Set(ids) }); },
    async toggleLike(trackId) {
      // Main's LIKE_TOGGLE returns either a bare boolean (legacy /
      // no-reconcile path) OR an object { liked, reconciledAdded,
      // allLikedIds } when a cross-machine reconcile pulled new likes
      // in from disk. Handle both so we don't care which path ran.
      const r: any = await window.mp.likes.toggle(trackId);
      const liked = typeof r === 'boolean' ? r : !!r.liked;
      const reconciledIds: number[] | null = (r && typeof r === 'object' && Array.isArray(r.allLikedIds))
        ? r.allLikedIds : null;
      set((s) => {
        // If reconcile fired, swap the entire set — the file on disk
        // had likes we didn't know about, so the renderer needs to
        // show those hearts lit immediately.
        if (reconciledIds) return { likedIds: new Set<number>(reconciledIds) };
        const next = new Set(s.likedIds);
        if (liked) next.add(trackId); else next.delete(trackId);
        return { likedIds: next };
      });
      // Broadcast library-changed when reconcile actually pulled new
      // rows in so the Liked Songs view, sidebar counts, etc. pick
      // up the merged state without waiting for their next natural
      // refresh trigger.
      if (reconciledIds) {
        window.dispatchEvent(new CustomEvent('mp-library-changed'));
      }
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

// --- DLNA status → player state bridge ---------------------------------------
// Identical pattern to Cast/HA: mirror position (outside the seek-grace
// window), duration, and isPlaying. DLNA's TRANSITIONING / NO_MEDIA_PRESENT
// states map to BUFFERING / IDLE, both of which we deliberately ignore
// — same transient-blip reasoning as the Cast bridge.
useDlna.subscribe((dlna) => {
  const s = dlna.lastStatus;
  if (!s) return;
  if (dlna.activeDeviceId !== s.deviceId) return;
  const patch: Partial<{ position: number; duration: number; isPlaying: boolean }> = {};
  const withinSeekGrace = Date.now() - lastUserCastSeekAt < CAST_SEEK_GRACE_MS;
  if (!withinSeekGrace && Number.isFinite(s.currentTime)) patch.position = s.currentTime;
  if (typeof s.duration === 'number' && s.duration > 0) patch.duration = s.duration;
  if (s.playerState === 'PLAYING') patch.isPlaying = true;
  else if (s.playerState === 'PAUSED') patch.isPlaying = false;
  if (Object.keys(patch).length > 0) usePlayer.setState(patch as any);
});

// --- DLNA receiver: a remote sender pushed a URL at us -----------------------
// When VLC / BubbleUPnP / HA's dlna_dmr casts to this app, the main
// process extracts the media URL and fires `dlna.onIncoming`. We route
// that through the local audio engine the same way a radio stream would
// be played. Also mirror transport state back to main so the DLNA
// receiver can answer GetPositionInfo / GetTransportInfo polls the
// sender does while we're playing.
if (typeof window !== 'undefined' && window.mp) {
  const dlnaBridge: any = (window.mp as any).dlna;
  if (dlnaBridge?.onIncoming) {
    dlnaBridge.onIncoming((m: { uri: string; title?: string; artist?: string; album?: string }) => {
      console.log(`[dlna-receiver] incoming media: ${m.uri} (title="${m.title ?? ''}")`);
      const engine = getAudioEngine();
      // Drop any active remote routing — the whole point here is to
      // play LOCALLY while acting as a DLNA renderer for someone else.
      useCast.getState().setActive(null);
      useHomeAssistant.getState().setActive(null);
      useDlna.getState().setActive(null);
      engine.element.crossOrigin = 'anonymous';
      engine.setSrc(m.uri);
      // Build a fake queue entry so the NowPlayingBar has something to
      // show. No DB id, so stats/liking are disabled for remote-pushed
      // tracks.
      usePlayer.setState({
        queue: [{
          id: -1,
          title: m.title ?? 'DLNA stream',
          artist: m.artist ?? null,
          album: m.album ?? null,
          path: m.uri,
          durationSec: null,
          coverArtPath: null,
        }],
        originalQueue: [{
          id: -1,
          title: m.title ?? 'DLNA stream',
          artist: m.artist ?? null,
          album: m.album ?? null,
          path: m.uri,
          durationSec: null,
          coverArtPath: null,
        }],
        index: 0,
        isPlaying: true,
        position: 0,
        duration: 0,
      });
      engine.play().catch((err: any) => {
        console.warn(`[dlna-receiver] play failed: ${err?.message ?? err}`);
      });
    });
  }

  // Transport commands (Play/Pause/Stop/Seek) pushed by the remote
  // DLNA sender — e.g. the Linux MusicPlayer is the sender and we're
  // receiving; the user hits pause on Linux → SOAP Pause lands on
  // our receiver → main forwards this event → we actually pause the
  // element. Without this the element kept playing while the sender
  // thought it was paused.
  if (dlnaBridge?.onIncomingTransport) {
    dlnaBridge.onIncomingTransport((t: { action: 'play' | 'pause' | 'stop' | 'seek'; positionSec?: number }) => {
      const engine = getAudioEngine();
      console.log(`[dlna-receiver] transport command: ${t.action}${t.action === 'seek' ? ` @ ${t.positionSec}s` : ''}`);
      switch (t.action) {
        case 'pause':
          engine.element.pause();
          break;
        case 'play':
          engine.play().catch((err: any) => {
            console.warn(`[dlna-receiver] resume failed: ${err?.message ?? err}`);
          });
          break;
        case 'stop':
          engine.stop();
          break;
        case 'seek':
          if (typeof t.positionSec === 'number' && Number.isFinite(t.positionSec)) {
            engine.seek(t.positionSec);
          }
          break;
      }
    });
  }

  // Periodic state push back to main so DLNA senders polling us see
  // accurate transport + position. Cheap — once per second, same
  // cadence as our own pollers. Skipped when the app isn't acting as
  // a receiver (nothing has been pushed yet, element paused + empty).
  setInterval(() => {
    try {
      const engine = getAudioEngine();
      const el = engine.element;
      if (!el.src) return;
      const transport =
        el.paused && !el.ended ? 'PAUSED_PLAYBACK' :
        el.ended || !el.currentSrc ? 'STOPPED' :
        'PLAYING';
      (window.mp as any).dlna?.setReceiverState?.({
        transport,
        positionSec: Number.isFinite(el.currentTime) ? el.currentTime : 0,
        durationSec: Number.isFinite(el.duration) ? el.duration : 0,
        currentUri: el.currentSrc || el.src || '',
      });
    } catch { /* receiver isn't available; that's fine */ }
  }, 1000);
}

