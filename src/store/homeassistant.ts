// Zustand store tracking which Home Assistant media_player entity (if
// any) is currently acting as the playback sink. Mirrors src/store/cast.ts
// in both shape and responsibilities so the OutputDevicePicker and the
// player store can use an identical pattern for both sink kinds.
//
// Why a separate store from cast? The active-entity state is inherently
// single-target (we can't cast AND stream-to-HA at the same time), but
// the two discovery pipelines are independent — HA entities come from a
// REST poll, Cast devices from mDNS — so a merged store would entangle
// two concerns. A single mediator (player.ts) coordinates by picking
// whichever store has a non-null active id.

import { create } from 'zustand';
import type { HaEntityRef, HaStatusUpdate } from '../../shared/types';

/** Connection / discovery status, surfaced as a dot / tint next to the
 *  HA section header. Distinct from the Cast status vocabulary because
 *  HA can be in `disabled` (user never configured it) whereas Cast is
 *  always implicitly enabled (mDNS runs regardless). */
export type HaStatus = 'disabled' | 'idle' | 'connecting' | 'ready' | 'error';

interface HaStoreState {
  entities: HaEntityRef[];
  activeEntityId: string | null;
  status: HaStatus;
  lastStatus: HaStatusUpdate | null;
  /** Most recent user-visible error (play failed, seek rejected, etc.).
   *  Settable by any component that caught a rejected IPC — the picker
   *  surfaces it as a transient banner. null clears. Not persisted. */
  lastError: string | null;

  refreshEntities(): Promise<void>;
  setActive(id: string | null): void;
  setError(msg: string | null): void;
}

export const useHomeAssistant = create<HaStoreState>((set) => ({
  entities: [],
  activeEntityId: null,
  status: 'idle',
  lastStatus: null,
  lastError: null,

  async refreshEntities() {
    try {
      set((s) => (s.status === 'ready' ? s : { ...s, status: 'connecting' }));
      const list = await (window.mp as any).ha.list();
      const entities = Array.isArray(list) ? list : [];
      // `disabled` isn't produced by the list call — it means HA isn't
      // configured at all. Main returns [] in that case, same as a
      // reachable-but-empty install. We can't distinguish them from the
      // list response alone; the settings panel switches the store to
      // 'disabled' explicitly when the user toggles the feature off.
      set({ entities, status: entities.length > 0 ? 'ready' : 'idle' });
    } catch (err) {
      console.error('[ha] refresh failed', err);
      set({ status: 'error' });
    }
  },

  setActive(id) { set({ activeEntityId: id }); },
  setError(msg) { set({ lastError: msg }); },
}));

// Module-scope bootstrap. Unlike Cast we DON'T start a timer — HA
// entities rarely come and go (compared to mDNS-announced speakers),
// so we poll only when the output picker is open. See OutputDevicePicker's
// useEffect; it fires refreshEntities on mount + every 15s while open.
//
// We DO wire the status push listener immediately, so a user who casts
// at startup sees scrubber updates without waiting for the picker.
if (typeof window !== 'undefined' && window.mp) {
  const ha: any = (window.mp as any).ha;
  if (ha?.onStatus) {
    ha.onStatus((s: HaStatusUpdate) => {
      if (useHomeAssistant.getState().activeEntityId !== s.entityId) return;
      useHomeAssistant.setState({ lastStatus: s });
    });
  }
}
