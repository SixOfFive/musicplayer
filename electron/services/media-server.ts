// Shared LAN media HTTP server used by both the Cast service
// (electron/services/cast.ts) and the Home Assistant service
// (electron/services/homeassistant.ts). Both need the same thing:
//   - Bind 0.0.0.0 on a random free port
//   - Expose the currently-playing track under a path that contains a
//     per-session random token, so a neighbour on the LAN can't enumerate
//     or download the music library
//   - Serve Range requests correctly (206 + Content-Range) so receivers
//     that seek hand us `Range: bytes=<start>-<end>` get the right
//     window — and so very large files stream instead of buffering
//     whole
//   - Pick a LAN IP that's actually reachable by a speaker on the same
//     network, skipping link-local and CGNAT (Tailscale) interfaces
//
// The server is a singleton — same process, same music library, same
// token — and is lazy-spun on first request. Both Cast and HA speakers
// fetch from the same `/media/<token>/<filename>` URL shape. Only the
// filename is in the URL for the receiver's benefit (AVRs and Sonos
// speakers sometimes use the URL extension to pick a decoder path if
// the Content-Type header gets ignored).

import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

interface MediaServer {
  port: number;
  token: string;
  stop(): Promise<void>;
}

let server: MediaServer | null = null;

/** The single file the server is willing to serve right now. Set by
 *  `setCurrentServePath`, cleared by `stopMediaServer`. Any request for
 *  a different file (or any request at all while this is null) returns
 *  404 — a neighbour who guesses the token still can't walk the tree. */
let currentServePath: string | null = null;
let currentServeMime: string = 'application/octet-stream';

/** Extension → Content-Type lookup for the files we serve. Exported
 *  so Cast / HA callers can pass the same MIME as a `contentType` hint
 *  to the receiver (some receivers pick their decoder from the hint
 *  rather than the HTTP header). Unknown extensions fall back to
 *  `application/octet-stream`. */
export const MIME_BY_EXT: Record<string, string> = {
  '.mp3':  'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav':  'audio/wav',
  '.m4a':  'audio/mp4',
  '.aac':  'audio/aac',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/ogg',
  '.wma':  'audio/x-ms-wma',
};

/** Lazy-start the media server. Idempotent — later calls return the
 *  already-running instance. The same token lives for the whole app
 *  session, which is fine: no one outside the app ever sees it except
 *  the receiver we hand it to, and it rotates on next launch. */
export async function ensureMediaServer(): Promise<MediaServer> {
  if (server) return server;
  const token = crypto.randomBytes(16).toString('hex');

  const raw = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      // URL shape: /media/<token>/<filename>
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length < 2 || parts[0] !== 'media' || parts[1] !== token) {
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
        'Content-Type':   currentServeMime,
        'Content-Length': String(length),
        'Accept-Ranges':  'bytes',
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
    raw.once('error', reject);
    raw.listen(0, '0.0.0.0', () => resolve());
  });
  const addr = raw.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  server = {
    port,
    token,
    async stop() {
      await new Promise<void>((r) => raw.close(() => r()));
      server = null;
      currentServePath = null;
    },
  };
  process.stdout.write(`[media-server] listening on :${port}\n`);
  return server;
}

/** Point the server at the file to serve next. Called by each transport
 *  path (castPlay, haPlay) before it hands the URL to the receiver.
 *  Also resolves the MIME type from the extension so the HTTP response's
 *  Content-Type header is right — the cache of receivers that trust the
 *  header over the URL suffix is bigger than you'd think. */
export function setCurrentServePath(filePath: string): void {
  currentServePath = filePath;
  const ext = path.extname(filePath).toLowerCase();
  currentServeMime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Build a fully-qualified URL pointing at the currently-set serve path,
 *  using a LAN IP that's reachable from a receiver on the same network.
 *  Throws if the server isn't running (caller forgot ensureMediaServer)
 *  or no suitable LAN IP exists (e.g. only loopback + link-local). */
export function urlForServedFile(filePath: string): string {
  if (!server) throw new Error('Media server not running — call ensureMediaServer() first');
  const ip = firstLanIp();
  if (!ip) throw new Error('No LAN IP available to advertise to media receiver');
  const filename = encodeURIComponent(path.basename(filePath));
  return `http://${ip}:${server.port}/media/${server.token}/${filename}`;
}

/** Stop the server and forget the token. Usually called on app quit;
 *  also safe to call when the last sink is released. New calls to
 *  ensureMediaServer() after this mint a fresh token. */
export async function stopMediaServer(): Promise<void> {
  const s = server;
  if (!s) return;
  await s.stop();
}

/**
 * Pick the best LAN IPv4 address to advertise to a media receiver.
 *
 * Real-world disaster avoided: user has Tailscale installed → its
 * interface hands out a 100.64.0.0/10 CGNAT IP → `os.networkInterfaces()`
 * enumeration puts Tailscale first → we'd happily tell the speaker to
 * fetch from `http://100.69.14.11:…`, which it cannot reach over the
 * LAN. Playback silently never starts, nothing useful in any log.
 *
 * Priority order (higher wins):
 *   3 — RFC1918 home-LAN ranges: 192.168/16, 172.16-31/12, 10/8
 *   1 — anything not explicitly skipped (rare: routable IPs on flat
 *       networks without NAT)
 *   — explicitly skipped: loopback (already filtered by `internal`),
 *       link-local (169.254/16), CGNAT / shared space (100.64/10 →
 *       Tailscale, ZeroTier, Nebula), IPv6 (receivers mostly don't
 *       dual-stack on their media endpoints)
 *
 * Ties broken by enumeration order (good enough for single-host).
 */
export function firstLanIp(): string | null {
  const ifaces = os.networkInterfaces();
  const candidates: Array<{ address: string; rank: number; name: string }> = [];

  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const addr = i.address;
      if (addr.startsWith('169.254.')) continue;
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr)) continue;
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
  process.stdout.write(`[media-server] LAN IP candidates: ${candidates.map((c) => `${c.address} (${c.name}, rank=${c.rank})`).join(', ')} → using ${winner.address}\n`);
  return winner.address;
}
