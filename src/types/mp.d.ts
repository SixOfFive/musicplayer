import type { MpApi } from '../../electron/preload';

declare global {
  interface Window {
    mp: MpApi;
  }
}

export {};
