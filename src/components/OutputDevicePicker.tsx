import { useCallback, useEffect, useRef, useState } from 'react';
import { getAudioEngine } from '../audio/AudioEngine';

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
    // Persist so the choice survives restart. `as any` to bypass the
    // settings type check — outputDevice is nullable in the schema.
    void window.mp.settings.set({ playback: { outputDevice: id } } as any);
  }

  // Build a friendly label for the currently-selected device.
  const currentLabel =
    selectedId === DEFAULT_ID
      ? 'System default'
      : devices.find((d) => d.deviceId === selectedId)?.label
        || 'Unknown device';

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`Output: ${currentLabel}`}
        aria-label={`Output device (currently ${currentLabel})`}
        className={`p-1 transition ${open ? 'text-white' : 'text-text-secondary hover:text-white'}`}
      >
        {/* Speaker / output glyph. Subtle caret hints at the dropdown. */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute bottom-full mb-2 right-0 bg-bg-elev-2 rounded-md shadow-xl min-w-60 max-w-80 py-1 z-50 border border-white/10"
          role="menu"
        >
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-muted border-b border-white/5">
            Audio output
          </div>

          <DeviceRow
            id={DEFAULT_ID}
            label="System default"
            sublabel="Follow the OS audio setting"
            active={selectedId === DEFAULT_ID}
            onPick={pick}
          />

          {devices
            // Hide the explicit 'default'/'communications' virtual IDs — we
            // already show "System default" as the canonical fallback, and
            // Chromium also returns them which would look like duplicates.
            .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
            .map((d) => (
              <DeviceRow
                key={d.deviceId}
                id={d.deviceId}
                label={d.label || 'Unnamed output'}
                active={selectedId === d.deviceId}
                onPick={pick}
              />
            ))}

          {devices.length <= 1 && (
            <div className="px-3 py-2 text-[10px] text-text-muted">
              No additional outputs detected.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DeviceRow({
  id, label, sublabel, active, onPick,
}: {
  id: string;
  label: string;
  sublabel?: string;
  active: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <button
      role="menuitemradio"
      aria-checked={active}
      onClick={() => onPick(id)}
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
