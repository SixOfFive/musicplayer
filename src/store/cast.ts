// Zustand store tracking which Cast device, if any, is currently acting
// as the playback sink. When `activeDeviceId` is non-null, the player
// store proxies transport commands to the Cast IPC instead of the local
// <audio> element — the local element is paused so the song doesn't play
// through speakers AND the Cast device simultaneously.
//
// The device list + polling live here rather than in OutputDevicePicker
// because multiple components (the picker dropdown, a future "now playing
// on <device>" banner, etc.) may want to read the same state without
// each firing its own mDNS / IPC polling cycle.

import { create } from 'zustand';
import type { CastDeviceRef } from '../../shared/types';

/**
 * Discovery status, surfaced as a coloured dot / icon tint in the UI:
 *   idle       — we haven't attempted a poll yet (initial render)
 *   searching  — polled, got zero devices; mDNS is still trying
 *   found      — at least one device is currently discoverable
 *   error      — the IPC itself threw (LAN unreachable, main crashed,
 *                something exceptional) — distinct from "no devices
 *                found" which is just `searching`
 */
export type CastStatus = 'idle' | 'searching' | 'found' | 'error';

interface CastState {
  devices: CastDeviceRef[];
  activeDeviceId: string | null;
  status: CastStatus;
  /** Latest status update from the active Cast device; null before any
   *  update has been received. Updated by an onStatus subscription
   *  below. Consumers: the player store (mirrors position/duration/
   *  isPlaying), future NowPlayingBar annotations. */
  lastStatus: CastStatusUpdate | null;

  refreshDevices(): Promise<void>;
  setActive(id: string | null): void;
}

export const useCast = create<CastState>((set) => ({
  devices: [],
  activeDeviceId: null,
  status: 'idle',
  lastStatus: null,

  async refreshDevices() {
    try {
      const list = await (window.mp as any).cast.list();
      const devices = Array.isArray(list) ? list : [];
      set({
        devices,
        status: devices.length > 0 ? 'found' : 'searching',
      });
    } catch (err) {
      console.error('[cast] refresh failed', err);
      set({ status: 'error' });
    }
  },

  setActive(id) {
    set({ activeDeviceId: id });
  },
}));

// Poll the device list while any consumer of this store is mounted.
// mDNS keeps pushing new devices over time (some Cast receivers go
// dormant and re-announce), so a single fetch at mount time misses
// late arrivals. 5-second cadence matches the typical TTL on Cast
// mDNS records without being chatty.
if (typeof window !== 'undefined' && window.mp) {
  setInterval(() => {
    void useCast.getState().refreshDevices();
  }, 5000);
  // First pull happens as soon as the module is imported; by the time
  // the UI opens the picker there's usually at least one device shown.
  void useCast.getState().refreshDevices();

  // Also expose the latest status on the cast store for anyone (like
  // the player store) that wants to react without wiring up its own
  // IPC subscription. See player.ts for the actual scrubber sync.
  const cast: any = (window.mp as any).cast;
  if (cast?.onStatus) {
    cast.onStatus((s: CastStatusUpdate) => {
      if (useCast.getState().activeDeviceId !== s.deviceId) return;
      useCast.setState({ lastStatus: s });
    });
  }
}

export interface CastStatusUpdate {
  currentTime: number;
  duration: number | null;
  playerState: 'PLAYING' | 'PAUSED' | 'BUFFERING' | 'IDLE' | 'UNKNOWN' | string;
  deviceId: string;
}
