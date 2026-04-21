// Zustand store for DLNA / UPnP MediaRenderer state. Same shape as the
// Cast and HA stores — the OutputDevicePicker treats all three
// identically below the first-selection step.
//
// Adds two things Cast/HA don't have:
//   - Initial-scan progress (elapsedMs / totalMs / found) fed by the
//     main-process discovery loop. The picker uses this to render a
//     "scanning LAN for speakers" indicator during the first few
//     seconds after app launch.
//   - Incoming-media event wiring: when a remote DLNA sender (VLC,
//     BubbleUPnP, HA's dlna_dmr) pushes a URL at our receiver, the URL
//     arrives as an IPC event. The player store subscribes to the
//     event to hand the URL to the audio engine.

import { create } from 'zustand';
import type { DlnaDeviceRef, DlnaStatusUpdate, DlnaScanProgress, DlnaIncomingMedia } from '../../shared/types';

export type DlnaStatus = 'idle' | 'scanning' | 'ready' | 'error';

interface DlnaStoreState {
  devices: DlnaDeviceRef[];
  activeDeviceId: string | null;
  status: DlnaStatus;
  lastStatus: DlnaStatusUpdate | null;
  lastError: string | null;
  /** Most recent scan-progress tick from main. null until the first
   *  discovery round completes. The picker inspects this to decide
   *  whether to show the spinner or the "found N" label. */
  scanProgress: DlnaScanProgress | null;

  refreshDevices(): Promise<void>;
  setActive(id: string | null): void;
  setError(msg: string | null): void;
}

export const useDlna = create<DlnaStoreState>((set) => ({
  devices: [],
  activeDeviceId: null,
  status: 'idle',
  lastStatus: null,
  lastError: null,
  scanProgress: null,

  async refreshDevices() {
    try {
      const list = await (window.mp as any).dlna.list();
      const devices = Array.isArray(list) ? list : [];
      // Only flip to 'ready' once we actually have devices; leave
      // status as 'scanning' otherwise so the picker keeps showing
      // progress until either something's found or the scan window
      // closes.
      set((s) => ({
        devices,
        status: devices.length > 0 ? 'ready' : (s.scanProgress?.done ? 'idle' : 'scanning'),
      }));
    } catch (err) {
      console.error('[dlna] refresh failed', err);
      set({ status: 'error' });
    }
  },

  setActive(id) { set({ activeDeviceId: id }); },
  setError(msg) { set({ lastError: msg }); },
}));

// Module-scope bootstrap: wire the three push channels (status, scan,
// incoming) as soon as this module loads. We poll the device list
// opportunistically alongside each scan-progress tick — main is the
// authoritative source, but re-pulling the list keeps the store in
// sync if main added devices between our last list() call and now.
if (typeof window !== 'undefined' && window.mp) {
  const dlna: any = (window.mp as any).dlna;

  if (dlna?.onStatus) {
    dlna.onStatus((s: DlnaStatusUpdate) => {
      if (useDlna.getState().activeDeviceId !== s.deviceId) return;
      useDlna.setState({ lastStatus: s });
    });
  }

  if (dlna?.onScanProgress) {
    dlna.onScanProgress((p: DlnaScanProgress) => {
      useDlna.setState({
        scanProgress: p,
        status: p.done && useDlna.getState().devices.length === 0 ? 'idle' : (useDlna.getState().devices.length > 0 ? 'ready' : 'scanning'),
      });
      // Re-pull devices on each tick so the picker shows new finds
      // without having to open the dropdown.
      void useDlna.getState().refreshDevices();
    });
  }

  // Incoming-media push from our RECEIVER side. Handled by the player
  // store so the URL gets loaded into the shared audio engine; we just
  // export the subscribe-point here for organisation.
  if (dlna?.onIncoming) {
    dlna.onIncoming((m: DlnaIncomingMedia) => {
      // The actual play-into-engine behaviour lives in player.ts —
      // importing from there here would create a circular dep (player
      // imports dlna store), so the player module subscribes to this
      // same preload channel directly.
      void m;
    });
  }

  // Initial list pull in case the scan has already made progress by
  // the time the renderer attaches listeners (discovery is started
  // during app startup, so a fast boot can briefly outpace the UI).
  void useDlna.getState().refreshDevices();
}
