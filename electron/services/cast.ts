// Google Cast (Chromecast / Nest Mini / Cast-enabled TVs & speakers)
// support. Two moving parts collaborate here:
//
//   1. mDNS discovery via `chromecast-api` — finds Cast devices on the
//      local network, surfaces them as `CastDeviceRef` entries the
//      renderer's output-picker can list alongside local audio sinks.
//
//   2. Cast protocol (play / pause / volume / stop / seek) via the
//      same `chromecast-api` client. When the user picks a Cast device
//      in the player bar, further transport commands proxy here.
//
// The HTTP media server that actually streams the current track to the
// receiver lives in electron/services/media-server.ts — shared with
// the Home Assistant service which needs the same mechanism.
//
// All of this lives in the main process. The renderer's player store
// tests `castActive` before dispatching to the local `<audio>` element
// and instead fires IPC when a Cast device owns playback.

// `chromecast-api` has no TS types. The shape we use below is stable
// across the 0.x versions we care about (tested against 0.5.x).
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const ChromecastAPI = require('chromecast-api');

import path from 'node:path';
import { ensureMediaServer, setCurrentServePath, urlForServedFile, MIME_BY_EXT } from './media-server';

// ----------------------------------------------------------------------------
// Device discovery + control
// ----------------------------------------------------------------------------

export interface CastDeviceRef {
  id: string;          // stable identifier (host:port or the lib's uuid)
  name: string;        // "Living Room Nest" — the friendly name from the device
  host: string;        // LAN IP
  type: 'chromecast' | 'nest' | 'unknown';
}

// Minimal subset of `chromecast-api`'s Device interface we rely on.
interface RawCastDevice {
  name?: string;
  friendlyName?: string;
  host: string;
  port?: number;
  play(url: string, cb?: (err: any) => void): void;
  play(media: { url: string; contentType?: string; media?: any }, cb?: (err: any) => void): void;
  pause(cb?: (err: any) => void): void;
  resume(cb?: (err: any) => void): void;
  stop(cb?: (err: any) => void): void;
  setVolume(level: number, cb?: (err: any) => void): void;
  /**
   * NOTE: chromecast-api's `seek(seconds)` is RELATIVE — it reads the
   * current position and calls seekTo(now + seconds). `seekTo(seconds)`
   * is the absolute-position version. We always want absolute so the
   * scrubber's clicked value maps directly to playback position.
   */
  seek(deltaSeconds: number, cb?: (err: any) => void): void;
  seekTo(absoluteSeconds: number, cb?: (err: any) => void): void;
  close(): void;
  on(event: string, handler: (...args: any[]) => void): void;
  // Not in every version of chromecast-api's typings, but present on
  // the underlying castv2 Device. Returns the full receiver status
  // including currentTime + media metadata, which is how we drive
  // the scrubber in main's polling loop.
  getStatus?(cb: (err: any, status: any) => void): void;
}

// Polling handle — restarts on every castPlay and is cleared when we
// stop casting. 1 Hz matches the renderer's timeupdate cadence on
// local playback, so the scrubber feels identical between cast and
// local modes.
let statusPollTimer: ReturnType<typeof setInterval> | null = null;
function stopStatusPolling() {
  if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
}

let client: any = null;
const devicesByKey = new Map<string, RawCastDevice>();
let activeDeviceKey: string | null = null;

/** Cast playback status pushed from a device's `status` event to renderer. */
export interface CastStatusUpdate {
  currentTime: number;           // seconds into the current track
  duration: number | null;       // total track seconds (null before it arrives)
  playerState: 'PLAYING' | 'PAUSED' | 'BUFFERING' | 'IDLE' | 'UNKNOWN';
  deviceId: string;              // which active device this is about
}

type StatusListener = (u: CastStatusUpdate) => void;
let statusListener: StatusListener | null = null;

/** Register a single listener for device status updates. Replaces any
 *  previous subscription — caller is the IPC bridge; there's one. */
export function onCastStatus(listener: StatusListener | null): void {
  statusListener = listener;
}

function emitStatus(raw: any, deviceId: string) {
  if (!statusListener) return;
  // `chromecast-api` status shapes vary — the `playerState` is nested
  // under the media receiver status; currentTime is top-level; duration
  // lives under .media.duration once the track has loaded.
  const playerState = (raw?.playerState ?? raw?.status?.playerState ?? 'UNKNOWN') as CastStatusUpdate['playerState'];
  const currentTime = Number(raw?.currentTime ?? 0);
  const duration = typeof raw?.media?.duration === 'number' ? raw.media.duration : null;
  statusListener({ currentTime, duration, playerState, deviceId });
}

function keyFor(d: RawCastDevice): string {
  return `${d.host}:${d.port ?? 8009}`;
}
function typeFor(name: string): CastDeviceRef['type'] {
  const n = name.toLowerCase();
  if (n.includes('nest') || n.includes('google home')) return 'nest';
  if (n.includes('chromecast') || n.includes('tv')) return 'chromecast';
  return 'unknown';
}

/** Begin (or continue) mDNS discovery. Idempotent. */
export function startDiscovery(): void {
  if (client) return;
  client = new ChromecastAPI();
  client.on('device', (d: RawCastDevice) => {
    const key = keyFor(d);
    devicesByKey.set(key, d);
    const name = d.friendlyName || d.name || d.host;
    process.stdout.write(`[cast] discovered: ${name} @ ${d.host}\n`);
  });
}

export function listDevices(): CastDeviceRef[] {
  const out: CastDeviceRef[] = [];
  for (const [key, d] of devicesByKey) {
    const name = d.friendlyName || d.name || d.host;
    out.push({ id: key, name, host: d.host, type: typeFor(name) });
  }
  // Stable alphabetical order so the UI doesn't reshuffle on each refresh.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function requireDevice(id: string): RawCastDevice {
  const d = devicesByKey.get(id);
  if (!d) throw new Error(`Unknown cast device: ${id}`);
  return d;
}

/**
 * Point a Cast device at the given file. Handles:
 *   - Lazy-spinning the media HTTP server on first use
 *   - Setting the current-servable path/MIME so the server can respond
 *   - Handing the URL to the device
 *   - Swapping sources cleanly if the device was already playing
 */
export async function castPlay(deviceId: string, filePath: string, meta?: { title?: string; artist?: string; album?: string; coverUrl?: string }): Promise<void> {
  const device = requireDevice(deviceId);
  await ensureMediaServer();
  setCurrentServePath(filePath);

  const url = urlForServedFile(filePath);
  const contentType = MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  process.stdout.write(`[cast] play → ${device.friendlyName || device.host} :: ${url}\n`);

  return new Promise((resolve, reject) => {
    // `chromecast-api` accepts either a plain URL or a richer media
    // descriptor; the latter lets us push title/artist onto the device's
    // now-playing card (visible on Chromecast-connected TVs and the
    // Google Home app). Fall back to plain URL on audio-only targets.
    const media = {
      url,
      contentType,
      media: meta
        ? {
            metadata: {
              type: 3, // MUSIC_TRACK
              metadataType: 3,
              title: meta.title,
              artist: meta.artist,
              albumName: meta.album,
              images: meta.coverUrl ? [{ url: meta.coverUrl }] : undefined,
            },
          }
        : undefined,
    } as any;
    device.play(media, (err: any) => {
      if (err) reject(err);
      else {
        activeDeviceKey = deviceId;

        // `chromecast-api` fires its `status` event on state CHANGES
        // (playing→paused, track finished, etc.), not on a timer.
        // If we rely on it alone the renderer's scrubber never
        // advances while a track plays — it just holds whatever the
        // first status said. Attach the listener anyway (so we catch
        // pause/resume from the speaker's hardware buttons), AND
        // poll getStatus() at 1 Hz for the currentTime stream.
        try {
          (device as any).removeAllListeners?.('status');
          device.on('status', (raw: any) => emitStatus(raw, deviceId));
        } catch { /* listener attach is best-effort */ }

        stopStatusPolling();
        statusPollTimer = setInterval(() => {
          // Guard against the device going away mid-poll (user switched
          // targets, power-cycled, etc.)
          if (activeDeviceKey !== deviceId) { stopStatusPolling(); return; }
          if (typeof device.getStatus !== 'function') return;
          try {
            device.getStatus((err: any, status: any) => {
              if (err || !status) return;
              emitStatus(status, deviceId);
            });
          } catch { /* keep polling — transient errors shouldn't tear down the loop */ }
        }, 1000);

        resolve();
      }
    });
  });
}

/**
 * Wrap a chromecast-api device callback in a promise that ALWAYS resolves.
 * These operations can throw synchronously (the underlying castv2-client
 * blows up with "Cannot read properties of undefined (reading
 * 'mediaSessionId')" when the receiver has dropped the media session mid-
 * playback — typically after a long pause, a seek the receiver rejects,
 * or the device entering idle). Propagating those up to the IPC layer
 * makes the renderer see "Error invoking remote method..." which looks
 * to the user like the whole player died. Instead: log and swallow, and
 * let the 1 Hz status poll correct the UI on the next tick.
 */
function safeCastOp(label: string, fn: (cb: (err?: any) => void) => void): Promise<void> {
  return new Promise((resolve) => {
    try {
      fn((err?: any) => {
        if (err) {
          process.stdout.write(`[cast] ${label} callback error: ${err?.message ?? err}\n`);
        }
        resolve();
      });
    } catch (err: any) {
      // Synchronous throw inside chromecast-api's _tryJoin — session dropped
      // or never existed. Log with enough detail to diagnose but don't
      // crash the IPC handler.
      process.stdout.write(`[cast] ${label} sync throw: ${err?.message ?? err}\n`);
      resolve();
    }
  });
}

/**
 * Seek the active Cast device to `seconds` into the current track.
 *
 * IMPORTANT: we call `d.seekTo(t)` (absolute), NOT `d.seek(t)`. The
 * chromecast-api method named `seek` is a RELATIVE jump — it adds the
 * argument to the current position. Using it here caused "rewind to
 * specific point" to land wildly wrong (e.g. clicking scrubber at 86s
 * while the track was at 239s jumped to 325s, past the end, leaving the
 * receiver idle). `seekTo` is what every other media framework calls
 * "seek", hence our store-level API is named `seek` as well.
 */
export function castSeek(seconds: number): Promise<void> {
  if (!activeDeviceKey) return Promise.resolve();
  const d = devicesByKey.get(activeDeviceKey);
  if (!d) return Promise.resolve();
  const t = Math.max(0, Math.floor(seconds));
  process.stdout.write(`[cast] seekTo → ${t}s\n`);
  return safeCastOp(`seekTo(${t})`, (cb) => d.seekTo(t, cb));
}

export function castPause(): Promise<void> {
  if (!activeDeviceKey) return Promise.resolve();
  const d = devicesByKey.get(activeDeviceKey);
  if (!d) return Promise.resolve();
  process.stdout.write(`[cast] pause\n`);
  return safeCastOp('pause', (cb) => d.pause(cb));
}

export function castResume(): Promise<void> {
  if (!activeDeviceKey) return Promise.resolve();
  const d = devicesByKey.get(activeDeviceKey);
  if (!d) return Promise.resolve();
  process.stdout.write(`[cast] resume\n`);
  return safeCastOp('resume', (cb) => d.resume(cb));
}

export function castSetVolume(level: number): Promise<void> {
  if (!activeDeviceKey) return Promise.resolve();
  const d = devicesByKey.get(activeDeviceKey);
  if (!d) return Promise.resolve();
  const clamped = Math.max(0, Math.min(1, level));
  return safeCastOp(`setVolume(${clamped.toFixed(2)})`, (cb) => d.setVolume(clamped, cb));
}

export async function castStop(): Promise<void> {
  stopStatusPolling();
  if (!activeDeviceKey) return;
  const d = devicesByKey.get(activeDeviceKey);
  activeDeviceKey = null;
  // Note: we deliberately don't null out the media server's serve-path
  // here — if the user immediately picks a different sink (HA entity
  // or another Cast device), the next setCurrentServePath call will
  // take over. Clearing the path here would create a window where a
  // mid-flight receiver request returns 404.
  if (!d) return;
  await new Promise<void>((resolve) => d.stop(() => resolve()));
}

export function castActiveDeviceId(): string | null {
  return activeDeviceKey;
}
