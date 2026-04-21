// Google Cast (Chromecast / Nest Mini / Cast-enabled TVs & speakers)
// support. Three moving parts collaborate here:
//
//   1. mDNS discovery via `chromecast-api` — finds Cast devices on the
//      local network, surfaces them as `CastDeviceRef` entries the
//      renderer's output-picker can list alongside local audio sinks.
//
//   2. A tiny HTTP server (bound to 0.0.0.0 on a random free port)
//      serves the currently-cast track to the Cast device. Cast
//      receivers fetch media by URL — they don't accept pushed bytes —
//      so our file-on-disk needs to be reachable at an http://lan-ip:PORT/...
//      URL. We include a random per-session token in the path so any
//      arbitrary LAN host can't browse the user's music: only the
//      Cast device that received the URL can hit it.
//
//   3. Cast protocol (play / pause / volume / stop / seek) via the
//      same `chromecast-api` client. When the user picks a Cast device
//      in the player bar, further transport commands proxy here.
//
// All of this lives in the main process. The renderer's player store
// tests `castActive` before dispatching to the local `<audio>` element
// and instead fires IPC when a Cast device owns playback.

import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// `chromecast-api` has no TS types. The shape we use below is stable
// across the 0.x versions we care about (tested against 0.5.x).
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const ChromecastAPI = require('chromecast-api');

// ----------------------------------------------------------------------------
// Local HTTP server for media delivery to Cast devices
// ----------------------------------------------------------------------------
//
// Cast devices fetch by URL, so we need to expose the current track to
// the LAN. Security constraints:
//   - Bind to 0.0.0.0 (Cast device is a different host on the LAN)
//   - Require a per-session random token in the URL path so a neighbour
//     on the network can't enumerate / download your music library
//   - Only serve the file we're currently casting — no directory listing,
//     no arbitrary file access

interface CastMediaServer {
  port: number;
  token: string;
  stop(): Promise<void>;
}

let mediaServer: CastMediaServer | null = null;

// Path currently eligible for serving. Set by `serveFile`, cleared on
// stop. Any request for a different path returns 404 — blocks path
// traversal and enumeration.
let currentServePath: string | null = null;
let currentServeMime: string = 'application/octet-stream';

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
};

async function ensureMediaServer(): Promise<CastMediaServer> {
  if (mediaServer) return mediaServer;
  const token = crypto.randomBytes(16).toString('hex');

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      // URL shape: /cast/<token>/<ignored-filename.ext>
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length < 2 || parts[0] !== 'cast' || parts[1] !== token) {
        res.statusCode = 403;
        res.end();
        return;
      }
      if (!currentServePath) {
        res.statusCode = 404;
        res.end();
        return;
      }

      const filePath = currentServePath;
      const stat = statSync(filePath);
      const size = stat.size;
      const rangeHeader = req.headers.range || '';
      const rm = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      let start = 0;
      let end = size - 1;
      let status = 200;
      if (rm) {
        start = rm[1] ? parseInt(rm[1], 10) : 0;
        end = rm[2] ? Math.min(parseInt(rm[2], 10), size - 1) : size - 1;
        if (start < 0 || end < start || end >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          res.end();
          return;
        }
        status = 206;
      }
      const length = end - start + 1;
      const headers: Record<string, string> = {
        'Content-Type': currentServeMime,
        'Content-Length': String(length),
        'Accept-Ranges': 'bytes',
      };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(status, headers);
      const stream = createReadStream(filePath, { start, end });
      stream.on('error', () => { try { res.end(); } catch { /* noop */ } });
      stream.pipe(res);
    } catch {
      try { res.statusCode = 500; res.end(); } catch { /* noop */ }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  mediaServer = {
    port,
    token,
    async stop() {
      await new Promise<void>((r) => server.close(() => r()));
      mediaServer = null;
      currentServePath = null;
    },
  };
  process.stdout.write(`[cast] media server listening on :${port}\n`);
  return mediaServer;
}

/**
 * Find the best LAN IPv4 address to advertise to a Cast device. Cast
 * receivers fetch the media URL, so the address has to be reachable
 * from the device's subnet — and crucially NOT a VPN / CGNAT / link-
 * local interface the speaker has no route to.
 *
 * Real-world disaster avoided: user has Tailscale installed → its
 * interface hands out a 100.64.0.0/10 CGNAT IP → `os.networkInterfaces()`
 * enumeration puts Tailscale first → we'd happily tell the Nest speaker
 * "fetch from http://100.69.14.11:…" which the Nest cannot reach over
 * the LAN, so playback just silently never starts.
 *
 * Priority order (higher wins):
 *   3 — RFC1918 home-LAN ranges: 192.168/16, 172.16–31/12, 10/8
 *   2 — unmapped routable space (public IP on the interface) — possible
 *       if user is on a flat network without NAT, rare
 *   1 — anything else that isn't explicitly blocked below
 *   0 — explicitly skipped: loopback (127/8 — already filtered),
 *       link-local (169.254/16), CGNAT / shared address space
 *       (100.64/10 → covers Tailscale by default), IPv6 (can't be
 *       targeted by the Cast v2 receiver)
 *
 * The first interface matching the highest tier wins. Ties broken by
 * enumeration order, which is good enough for our single-machine case.
 */
function firstLanIp(): string | null {
  const ifaces = os.networkInterfaces();
  const candidates: Array<{ address: string; rank: number; name: string }> = [];

  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const addr = i.address;

      // Skip link-local and CGNAT entirely — Cast targets can never
      // reach us through these. The CGNAT skip is specifically for
      // Tailscale, Nebula, ZeroTier, and any other overlay that
      // defaults to 100.64/10.
      if (addr.startsWith('169.254.')) continue;
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr)) continue;

      // Real home-LAN ranges — prefer these.
      const isPrivate =
        addr.startsWith('192.168.') ||
        addr.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(addr);

      candidates.push({ address: addr, rank: isPrivate ? 3 : 1, name });
    }
  }

  candidates.sort((a, b) => b.rank - a.rank);
  if (candidates.length === 0) return null;
  const winner = candidates[0];
  process.stdout.write(`[cast] LAN IP candidates: ${candidates.map((c) => `${c.address} (${c.name}, rank=${c.rank})`).join(', ')} → using ${winner.address}\n`);
  return winner.address;
}

function urlForServedFile(filePath: string): string {
  const m = mediaServer;
  if (!m) throw new Error('Media server not running');
  const ip = firstLanIp();
  if (!ip) throw new Error('No LAN IP available to advertise to Cast device');
  const filename = encodeURIComponent(path.basename(filePath));
  return `http://${ip}:${m.port}/cast/${m.token}/${filename}`;
}

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
  seek(seconds: number, cb?: (err: any) => void): void;
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

  currentServePath = filePath;
  const ext = path.extname(filePath).toLowerCase();
  currentServeMime = MIME_BY_EXT[ext] ?? 'application/octet-stream';

  const url = urlForServedFile(filePath);
  process.stdout.write(`[cast] play → ${device.friendlyName || device.host} :: ${url}\n`);

  return new Promise((resolve, reject) => {
    // `chromecast-api` accepts either a plain URL or a richer media
    // descriptor; the latter lets us push title/artist onto the device's
    // now-playing card (visible on Chromecast-connected TVs and the
    // Google Home app). Fall back to plain URL on audio-only targets.
    const media = {
      url,
      contentType: currentServeMime,
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

/** Seek the active Cast device to `seconds` into the current track. */
export function castSeek(seconds: number): Promise<void> {
  if (!activeDeviceKey) return Promise.resolve();
  const d = devicesByKey.get(activeDeviceKey);
  if (!d) return Promise.resolve();
  const t = Math.max(0, Math.floor(seconds));
  return new Promise((resolve) => d.seek(t, () => resolve()));
}

export function castPause(): Promise<void> {
  if (!activeDeviceKey) return Promise.resolve();
  const d = devicesByKey.get(activeDeviceKey);
  if (!d) return Promise.resolve();
  return new Promise((resolve) => d.pause(() => resolve()));
}

export function castResume(): Promise<void> {
  if (!activeDeviceKey) return Promise.resolve();
  const d = devicesByKey.get(activeDeviceKey);
  if (!d) return Promise.resolve();
  return new Promise((resolve) => d.resume(() => resolve()));
}

export function castSetVolume(level: number): Promise<void> {
  if (!activeDeviceKey) return Promise.resolve();
  const d = devicesByKey.get(activeDeviceKey);
  if (!d) return Promise.resolve();
  const clamped = Math.max(0, Math.min(1, level));
  return new Promise((resolve) => d.setVolume(clamped, () => resolve()));
}

export async function castStop(): Promise<void> {
  stopStatusPolling();
  if (!activeDeviceKey) return;
  const d = devicesByKey.get(activeDeviceKey);
  activeDeviceKey = null;
  currentServePath = null;
  if (!d) return;
  await new Promise<void>((resolve) => d.stop(() => resolve()));
}

export function castActiveDeviceId(): string | null {
  return activeDeviceKey;
}
