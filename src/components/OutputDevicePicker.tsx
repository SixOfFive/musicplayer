import { useCallback, useEffect, useRef, useState } from 'react';
import { getAudioEngine } from '../audio/AudioEngine';
import { useCast } from '../store/cast';
import { useHomeAssistant } from '../store/homeassistant';
import { usePlayer } from '../store/player';

/**
 * Output-device picker that sits next to the volume slider in the
 * NowPlayingBar. Lets the user route our `<audio>` element to any local
 * audio-output sink the OS knows about — built-in speakers, USB DAC,
 * Bluetooth headphones, HDMI monitor, Windows' "Speakers (2-something
 * Audio)", whatever the user plugged in this session — without having
 * to change the OS-level default (which would also redirect every other
 * app on the system).
 *
 * "System default" is always first and is the initial selection for
 * fresh installs. The user's explicit pick persists across restarts via
 * `settings.playback.outputDevice`.
 *
 * A few nuances worth knowing:
 *
 *   1. `HTMLMediaElement.setSinkId(deviceId)` is what actually moves the
 *      audio. It's Chromium-only (good — that's what Electron is) and
 *      unprivileged: no permission prompt to route to a device.
 *
 *   2. But `enumerateDevices()` only returns device *labels* (e.g. "Focusrite
 *      Scarlett 2i2") if the origin has microphone permission. Otherwise
 *      you get anonymous "audiooutput 1", "audiooutput 2" strings that
 *      the user can't possibly map to their hardware. We grant the
 *      permission up-front in main.ts (see autoGrantLocalMediaPermission)
 *      and also call getUserMedia() once on mount to "activate" it so
 *      the label field populates.
 *
 *   3. Device IDs are stable ACROSS restarts as long as the hardware
 *      doesn't change, so persisting the ID is fine. If the user picks
 *      their now-unplugged USB DAC, we silently fall back to system
 *      default on the next render tick when setSinkId throws.
 *
 *   4. `devicechange` fires when the user plugs/unplugs something mid-
 *      session. We refresh the list automatically so a newly-attached
 *      DAC appears in the dropdown without a restart.
 */

const DEFAULT_ID = 'default'; // Chromium's sentinel for "use OS default"

export default function OutputDevicePicker() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_ID);
  const [open, setOpen] = useState(false);
  const [labelsUnlocked, setLabelsUnlocked] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Activate device labels once per session. getUserMedia requires
  // permission; we pre-grant via setPermissionRequestHandler in main, so
  // this resolves silently. The stream is immediately stopped — we
  // never actually read from the mic.
  const unlockLabels = useCallback(async () => {
    if (labelsUnlocked) return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      setLabelsUnlocked(true);
    } catch (err) {
      // Non-fatal — picker still works, devices just show as anonymous.
      console.warn('[output] label unlock failed', err);
    }
  }, [labelsUnlocked]);

  const refresh = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list.filter((d) => d.kind === 'audiooutput'));
    } catch (err) {
      console.error('[output] enumerateDevices failed', err);
    }
  }, []);

  // Initial mount: unlock labels (once) + enumerate + restore persisted
  // selection from settings. Also subscribe to devicechange so plugging
  // in new hardware shows up without a refresh.
  useEffect(() => {
    void unlockLabels().then(refresh);
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh);
  }, [unlockLabels, refresh]);

  // Restore the persisted device + apply it to the engine. Split from
  // refresh() so a device list refresh doesn't re-fire setSinkId.
  useEffect(() => {
    let cancelled = false;
    window.mp.settings.get().then(async (s: any) => {
      if (cancelled) return;
      const id = s?.playback?.outputDevice || DEFAULT_ID;
      setSelectedId(id);
      await applyDevice(id);
    });
    return () => { cancelled = true; };
  }, []);

  // Close the dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  async function applyDevice(id: string) {
    const engine = getAudioEngine();
    const el = engine.element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof el.setSinkId !== 'function') return;
    try {
      await el.setSinkId(id);
    } catch (err: any) {
      // Falls here when the chosen device was unplugged since last save.
      // Quietly revert to default so the user isn't stuck listening to
      // silence. We don't wipe the setting — if the device comes back,
      // routing restores on the next setSinkId attempt.
      console.warn(`[output] setSinkId(${id}) failed: ${err?.message ?? err} — falling back to default`);
      try { await el.setSinkId(DEFAULT_ID); } catch { /* really nothing to do */ }
    }
  }

  async function pick(id: string) {
    setSelectedId(id);
    setOpen(false);
    await applyDevice(id);
    // Picking a LOCAL device stops any active remote session — we can
    // only play through one sink at a time. Fire BOTH stop IPCs
    // unconditionally rather than branching on the renderer's active
    // state: main is the source of truth about whether a remote
    // target is really playing, and its stop functions are no-ops
    // when nothing's active. Gating on the renderer state produces
    // the "I can't stop playback" bug where a play-failure had nulled
    // the renderer's active id while main was still playing on the
    // previous target.
    try { await (window.mp as any).cast.stop(); } catch { /* noop */ }
    try { await (window.mp as any).ha.stop(); }   catch { /* noop */ }
    useCast.getState().setActive(null);
    useHomeAssistant.getState().setActive(null);
    useHomeAssistant.getState().setError(null);
    // Persist so the choice survives restart. `as any` to bypass the
    // settings type check — outputDevice is nullable in the schema.
    void window.mp.settings.set({ playback: { outputDevice: id } } as any);
  }

  /**
   * Selecting a Cast device routes the current queue item through Google
   * Cast instead of our local audio element. The local engine is paused
   * so we don't leak sound to the laptop speakers while the Nest Mini /
   * Chromecast also plays. We mirror the "active" state into the Cast
   * store so the player's toggle/setVolume paths know to proxy.
   */
  async function pickCast(deviceId: string) {
    setOpen(false);
    const player = usePlayer.getState();
    const current = player.queue[player.index];
    console.log(`[cast-picker] picked deviceId=${deviceId} | hasCurrent=${!!current} | queueLen=${player.queue.length} | index=${player.index}`);

    // Fire stops unconditionally — see the note in `pick()`. One remote
    // sink at a time, so any previously-active target (whether Cast or
    // HA, whether the renderer knows about it or not) gets hushed.
    try { await (window.mp as any).ha.stop(); }   catch { /* noop */ }
    try { await (window.mp as any).cast.stop(); } catch { /* noop */ }
    useHomeAssistant.getState().setActive(null);
    useHomeAssistant.getState().setError(null);
    useCast.getState().setActive(deviceId);

    // Pause the local engine so the laptop speakers don't double-play.
    try { getAudioEngine().pause(); } catch { /* noop */ }

    if (!current) {
      // User picked Cast without anything queued. The Cast device is
      // now marked active; the next time they click a song, loadAndPlay
      // will see `castActive` and route to the Cast device instead of
      // the local element. Nothing else to do here.
      console.log('[cast-picker] no current track — cast active, waiting for user to start a track');
      return;
    }

    try {
      console.log(`[cast-picker] starting cast of "${current.title}" to ${deviceId}`);
      await (window.mp as any).cast.play(deviceId, current.path, {
        title: current.title,
        artist: current.artist ?? undefined,
        album: current.album ?? undefined,
      });
      usePlayer.setState({ isPlaying: true });
      console.log(`[cast-picker] cast.play resolved`);
    } catch (err: any) {
      console.error(`[cast-picker] couldn't start cast: ${err?.message ?? err}`);
      // Bail back to local on failure so the user isn't stranded.
      useCast.getState().setActive(null);
    }
  }

  /**
   * Selecting a Home Assistant `media_player.*` entity routes the
   * current track through HA's REST API. HA handles whatever protocol
   * the underlying speaker speaks (Sonos, AirPlay, Squeezebox, Snapcast,
   * MusicAssistant, …) on its side; we just POST the URL + entity_id.
   *
   * Mirrors `pickCast`: stops the opposite remote first, pauses local,
   * handles the no-queue case, reverts on failure.
   */
  async function pickHa(entityId: string) {
    setOpen(false);
    const player = usePlayer.getState();
    const current = player.queue[player.index];
    console.log(`[ha-picker] picked entityId=${entityId} | hasCurrent=${!!current} | queueLen=${player.queue.length} | index=${player.index}`);

    // Stop everything else before starting the new target — unconditionally,
    // regardless of renderer-side state. Includes stopping a previous HA
    // entity when switching between HA speakers (main's haStop sends
    // media_stop to whatever entity is currently active, so the old
    // speaker goes silent before the new one starts).
    try { await (window.mp as any).cast.stop(); } catch { /* noop */ }
    try { await (window.mp as any).ha.stop(); }   catch { /* noop */ }
    useCast.getState().setActive(null);
    useHomeAssistant.getState().setError(null);
    // Optimistically mark the new target active. If play_media fails
    // below we'll null it out — by then the old target has already been
    // stopped above, so the end state (silence) is coherent.
    useHomeAssistant.getState().setActive(entityId);

    try { getAudioEngine().pause(); } catch { /* noop */ }

    if (!current) {
      console.log('[ha-picker] no current track — HA active, waiting for user to start a track');
      return;
    }

    try {
      console.log(`[ha-picker] starting HA cast of "${current.title}" to ${entityId}`);
      await (window.mp as any).ha.play(entityId, current.path, {
        title: current.title,
        artist: current.artist ?? undefined,
        album: current.album ?? undefined,
      });
      usePlayer.setState({ isPlaying: true });
      console.log(`[ha-picker] ha.play resolved`);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.error(`[ha-picker] couldn't start HA playback: ${msg}`);
      useHomeAssistant.getState().setActive(null);
      // Surface the reason into the picker so a Roku rejecting audio
      // or a Sonos on cooldown isn't just a silent no-op. Trimmed to
      // keep the dropdown compact — the full stack is already in the
      // main-process log if someone needs it.
      const short = msg.length > 140 ? `${msg.slice(0, 140)}…` : msg;
      useHomeAssistant.getState().setError(`${entityId} rejected playback: ${short}`);
    }
  }

  // Subscribe to Cast state so the UI reflects which device (if any)
  // is currently receiving playback AND the current discovery status
  // (used to tint the speaker icon: green=devices found, orange=still
  // searching, red=discovery errored).
  const castDevices = useCast((s) => s.devices);
  const castActive = useCast((s) => s.activeDeviceId);
  const castStatus = useCast((s) => s.status);

  // Same for Home Assistant entities. Unlike Cast we don't background-
  // poll the entity list — HA entities don't come and go the way
  // mDNS-announced speakers do, so we only hit /api/states when the
  // picker is open. See the open-gated useEffect below.
  const haEntities     = useHomeAssistant((s) => s.entities);
  const haActive       = useHomeAssistant((s) => s.activeEntityId);
  const haStatus       = useHomeAssistant((s) => s.status);
  const haError        = useHomeAssistant((s) => s.lastError);
  const refreshHa      = useHomeAssistant((s) => s.refreshEntities);

  // Refresh the HA entity list when the dropdown opens, and every 15s
  // while it remains open — that's enough to pick up an HA restart or
  // a newly-added speaker without being chatty when the picker isn't
  // being looked at. When closed, zero HA traffic.
  useEffect(() => {
    if (!open) return;
    void refreshHa();
    const t = setInterval(() => { void refreshHa(); }, 15000);
    return () => clearInterval(t);
  }, [open, refreshHa]);

  // Build a friendly label for the currently-selected device. A remote
  // sink (Cast or HA) trumps the local selection in the button title.
  const activeCastDevice = castActive ? castDevices.find((c) => c.id === castActive) : null;
  const activeHaEntity   = haActive   ? haEntities.find((e) => e.id === haActive) : null;
  const currentLabel =
    activeCastDevice ? `Cast → ${activeCastDevice.name}` :
    activeHaEntity   ? `HA → ${activeHaEntity.name}` :
    selectedId === DEFAULT_ID ? 'System default' :
    devices.find((d) => d.deviceId === selectedId)?.label || 'Unknown device';

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={buildIconTitle(currentLabel, castStatus, castDevices.length, !!castActive, haStatus, haEntities.length, !!haActive)}
        aria-label={`Output device (currently ${currentLabel})`}
        className={`p-1 transition ${open ? 'text-white' : 'text-text-secondary hover:text-white'}`}
      >
        {/* Speaker / output glyph. Tiny "status dot" overlay conveys
            remote-sink state at a glance without opening the dropdown:
              accent      — a remote sink is actively playing (Cast or HA)
              emerald     — devices/entities found but nothing chosen
              amber pulse — still searching / connecting
              red         — discovery errored
              transparent — nothing discovered, nothing configured
            If both Cast AND HA have signals, Cast wins the dot (it's
            the more visible use-case). */}
        <span className="relative inline-flex">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
          <span
            className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ring-1 ring-bg-elev-1 ${
              (castActive || haActive)
                ? 'bg-accent'
                : (castStatus === 'found' || haStatus === 'ready')
                  ? 'bg-emerald-400'
                  : (castStatus === 'error' || haStatus === 'error')
                    ? 'bg-red-500'
                    : (castStatus === 'searching' || haStatus === 'connecting')
                      ? 'bg-amber-400 animate-pulse'
                      : 'bg-transparent ring-0'
            }`}
            aria-hidden
          />
        </span>
      </button>

      {open && (
        <div
          className="absolute bottom-full mb-2 right-0 bg-bg-elev-2 rounded-md shadow-xl min-w-60 max-w-80 py-1 z-50 border border-white/10"
          role="menu"
        >
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-muted border-b border-white/5">
            Audio output
          </div>

          {/* Transient error banner — shown when the last remote play
              attempt failed (e.g. Roku rejecting audio, Sonos
              unresponsive, HA's own media_seek returning 500 on an
              integration that lies about SEEK support). Dismissable by
              clicking; auto-clears when the user picks a working sink. */}
          {haError && (
            <div className="mx-2 my-1 p-2 rounded bg-red-500/10 border border-red-500/30 text-[11px] text-red-200">
              <div className="flex items-start gap-2">
                <span className="flex-1 break-words">{haError}</span>
                <button
                  onClick={() => useHomeAssistant.getState().setError(null)}
                  className="text-red-200/60 hover:text-red-100 flex-shrink-0"
                  title="Dismiss"
                >✕</button>
              </div>
            </div>
          )}

          <DeviceRow
            label="System default"
            sublabel="Follow the OS audio setting"
            active={selectedId === DEFAULT_ID && !castActive && !haActive}
            onPick={() => pick(DEFAULT_ID)}
          />

          {devices
            // Hide the explicit 'default'/'communications' virtual IDs — we
            // already show "System default" as the canonical fallback, and
            // Chromium also returns them which would look like duplicates.
            .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
            .map((d) => (
              <DeviceRow
                key={d.deviceId}
                label={d.label || 'Unnamed output'}
                active={selectedId === d.deviceId && !castActive && !haActive}
                onPick={() => pick(d.deviceId)}
              />
            ))}

          {devices.length <= 1 && (
            <div className="px-3 py-2 text-[10px] text-text-muted">
              No additional outputs detected.
            </div>
          )}

          {/* Cast devices — live-discovered via mDNS in main. Grouped into
              their own section below local outputs so the two remain
              visually distinct: a local sink is instant and silent to
              switch, a Cast target involves a network hop and actually
              starts playback on another device. */}
          {castDevices.length > 0 && (
            <>
              <div className="mt-1 px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-muted border-t border-white/5">
                Cast
              </div>
              {castDevices.map((c) => {
                const iconChar = c.type === 'nest' ? '🔊' : '📺';
                return (
                  <DeviceRow
                    key={c.id}
                    label={`${iconChar} ${c.name}`}
                    sublabel={c.host}
                    active={castActive === c.id}
                    onPick={() => pickCast(c.id)}
                  />
                );
              })}
            </>
          )}

          {/* Home Assistant media_player entities. HA itself is the
              protocol abstraction for speakers it manages — Sonos,
              AirPlay, Squeezebox, MusicAssistant, AVR, etc. — so one
              section here gets us access to every speaker the user's
              HA install knows about. The section is hidden entirely
              when HA isn't configured or returns nothing (status 'idle'
              with zero entities is the natural "nothing to show" case). */}
          {haEntities.length > 0 && (
            <>
              <div className="mt-1 px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-muted border-t border-white/5">
                Home Assistant
              </div>
              {haEntities.map((e) => (
                <DeviceRow
                  key={e.id}
                  label={`🏠 ${e.name}`}
                  // Sublabel shows the HA state so the user knows at a
                  // glance whether something else is already using that
                  // speaker (e.g. "playing"), helping them avoid kicking
                  // a roommate off the Sonos mid-song.
                  sublabel={e.state === 'unknown' || e.state === 'idle' ? e.id : `${e.state} · ${e.id}`}
                  active={haActive === e.id}
                  onPick={() => pickHa(e.id)}
                />
              ))}
            </>
          )}

          {/* Setup hint, shown only when HA is misconfigured / unreachable
              AND the user hasn't got any Cast devices to distract them
              (if they have Cast working, they probably don't care about
              HA yet). */}
          {haStatus === 'error' && haEntities.length === 0 && (
            <div className="mt-1 px-3 py-2 text-[10px] text-text-muted border-t border-white/5">
              Home Assistant unreachable — check Settings → Home Assistant.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Compose the tooltip shown when the user hovers the speaker icon.
 * Surfaces BOTH the current output (local / cast / HA) AND discovery
 * state for each remote sink so a user wondering "why can't I see my
 * Nest / Sonos yet?" gets an answer without opening the dropdown.
 */
function buildIconTitle(
  current: string,
  castStatus: import('../store/cast').CastStatus,
  castCount: number,
  casting: boolean,
  haStatus: import('../store/homeassistant').HaStatus,
  haCount: number,
  haActive: boolean,
): string {
  const head = `Output: ${current}`;
  // Active remote sink — the header line tells the whole story.
  if (casting || haActive) return head;
  const lines: string[] = [head];
  if (castStatus === 'found') lines.push(`${castCount} Cast device${castCount === 1 ? '' : 's'} available`);
  else if (castStatus === 'searching') lines.push('Searching for Cast devices on your network…');
  else if (castStatus === 'error') lines.push('Cast discovery failed (check your network / firewall)');
  if (haStatus === 'ready') lines.push(`${haCount} Home Assistant speaker${haCount === 1 ? '' : 's'} available`);
  else if (haStatus === 'connecting') lines.push('Connecting to Home Assistant…');
  else if (haStatus === 'error') lines.push('Home Assistant unreachable');
  return lines.join('\n');
}

function DeviceRow({
  label, sublabel, active, onPick,
}: {
  label: string;
  sublabel?: string;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      role="menuitemradio"
      aria-checked={active}
      onClick={onPick}
      className={`w-full text-left px-3 py-2 text-xs flex items-start gap-2 ${
        active ? 'bg-accent/10 text-accent' : 'text-text-primary hover:bg-white/5'
      }`}
    >
      <span className={`w-3 text-xs leading-4 flex-shrink-0 ${active ? '' : 'opacity-0'}`}>✓</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {sublabel && <span className="block text-[10px] text-text-muted truncate">{sublabel}</span>}
      </span>
    </button>
  );
}
