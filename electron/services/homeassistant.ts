// Home Assistant integration. Every `media_player.*` entity HA exposes
// is a candidate playback sink. HA handles the device-specific protocol
// (Sonos / AirPlay / Squeezebox / Snapcast / MusicAssistant / AVR / etc.)
// on its side; we just POST a URL + entity_id to the REST API and poll
// `/api/states/<entity_id>` for position & state.
//
// Why the REST API rather than the WebSocket API: single code path for
// test-connection, entity listing, service calls, and state reads; no
// subscription lifecycle to manage; no reconnect loop to debug; and
// HA's REST service interface is stable across versions. The cost is
// one HTTP round trip per poll tick (1 Hz) — fine on a LAN.
//
// Token hygiene:
//   - The HA token is read from settings exactly once per request and
//     passed as `Authorization: Bearer …`. It never appears in process
//     stdout, never in log lines, never in renderer-visible error
//     strings (we redact to `<redacted>` before bubbling up).
//   - Callers that log URLs log `<baseUrl>/…` (the user's own baseUrl
//     is fine to show — it's visible in their browser address bar too).

import path from 'node:path';
import { getSettings } from './settings-store';
import { ensureMediaServer, setCurrentServePath, urlForServedFile } from './media-server';

// ----------------------------------------------------------------------------
// Types that cross the IPC boundary
// ----------------------------------------------------------------------------

/** A single HA media_player entity, surfaced to the output-picker. */
export interface HaEntityRef {
  id: string;                // entity_id, e.g. "media_player.living_room"
  name: string;              // friendly_name — falls back to entity_id if unset
  state: string;             // "playing" | "paused" | "idle" | "off" | "unknown" | …
  /** Bitmask (media_player.SupportedFeatures). We care about PAUSE=1,
   *  SEEK=2, VOLUME_SET=4, PLAY_MEDIA=512, PLAY=16384, STOP=4096. UI
   *  greys out controls the target doesn't support. */
  supportedFeatures: number;
  volume: number | null;     // 0..1 or null if unknown
}

/** A state update normalised into the same shape the Cast poller emits,
 *  so the renderer's player-store subscriber can handle both sinks with
 *  one code path. */
export interface HaStatusUpdate {
  entityId: string;
  currentTime: number;
  duration: number | null;
  /** Mapped to Cast's playerState vocabulary so downstream filters reuse. */
  playerState: 'PLAYING' | 'PAUSED' | 'BUFFERING' | 'IDLE' | 'UNKNOWN';
}

type StatusListener = (u: HaStatusUpdate) => void;
let statusListener: StatusListener | null = null;
export function onHaStatus(listener: StatusListener | null): void { statusListener = listener; }

// ----------------------------------------------------------------------------
// Active state (singleton — we can only drive one HA target at a time)
// ----------------------------------------------------------------------------

let activeEntityId: string | null = null;
let statusPollTimer: NodeJS.Timeout | null = null;

function stopStatusPolling(): void {
  if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
}

export function haActiveEntityId(): string | null { return activeEntityId; }

// ----------------------------------------------------------------------------
// REST plumbing
// ----------------------------------------------------------------------------

/** Normalised config read. Returns null when HA isn't configured so
 *  every caller can bail early with the same check. */
function haConfig(): { baseUrl: string; token: string } | null {
  const s = getSettings().homeAssistant;
  if (!s?.enabled) return null;
  const baseUrl = (s.baseUrl || '').replace(/\/+$/, '');
  const token = s.token || '';
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

/** Scrub the token from any error message we're about to surface. HA's
 *  built-in error pages sometimes echo Authorization headers back; also
 *  catches the case where someone wraps fetch and the token lands in
 *  the stack. Cheap belt-and-suspenders. */
function scrubToken(msg: string, token: string): string {
  if (!token) return msg;
  return msg.split(token).join('<redacted>');
}

interface RequestOpts {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

async function haRequest<T = unknown>(pathSuffix: string, opts: RequestOpts = {}): Promise<T> {
  const cfg = haConfig();
  if (!cfg) throw new Error('Home Assistant not configured');
  const url = `${cfg.baseUrl}${pathSuffix}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
    'Content-Type': 'application/json',
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err: any) {
    // Network-level failure (refused, cert mismatch, DNS miss). Strip
    // the token out defensively — node's fetch does NOT include it in
    // error strings by default, but if it ever does we don't want it
    // bubbling up to the renderer.
    throw new Error(scrubToken(`HA request to ${pathSuffix} failed: ${err?.message ?? err}`, cfg.token));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(scrubToken(`HA ${pathSuffix} → ${res.status} ${res.statusText}: ${text.slice(0, 200)}`, cfg.token));
  }
  // Service calls return an array on success; state endpoints return
  // an object; some endpoints (/api/) return plain text. Caller picks
  // the type param so we don't need a union here.
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

// ----------------------------------------------------------------------------
// Public API — called by the IPC layer
// ----------------------------------------------------------------------------

/** Test the baseUrl + token by hitting HA's trivial root endpoint.
 *  Returns the HA version string on success, throws on any failure
 *  (bad URL, self-signed cert, wrong token, HA offline, etc.).
 *
 *  Takes the config as an argument rather than reading from settings,
 *  so the settings panel can test a not-yet-saved token. */
export async function haTestConnection(baseUrl: string, token: string): Promise<{ version: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err: any) {
    throw new Error(scrubToken(`Could not reach ${baseUrl}: ${err?.message ?? err}`, token));
  }
  if (res.status === 401) throw new Error('Token rejected (401). Double-check the long-lived access token.');
  if (!res.ok) throw new Error(scrubToken(`${baseUrl}/api/ returned ${res.status} ${res.statusText}`, token));
  // HA's /api/ returns `{ message: 'API running.' }` on older versions,
  // no version field. The /api/config endpoint carries version explicitly.
  const cfgRes = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/config`, { headers: { Authorization: `Bearer ${token}` } });
  if (!cfgRes.ok) return { version: 'unknown' };
  const cfg = (await cfgRes.json()) as { version?: string };
  return { version: cfg.version || 'unknown' };
}

/** List every media_player entity the HA instance knows about. Failures
 *  resolve to an empty list rather than throwing — the output picker
 *  treats "HA configured but unreachable" the same as "HA disabled"
 *  from a UX perspective (just show nothing in the HA section). */
export async function haListEntities(): Promise<HaEntityRef[]> {
  if (!haConfig()) return [];
  try {
    const states = await haRequest<any[]>('/api/states');
    if (!Array.isArray(states)) return [];
    return states
      .filter((s) => typeof s?.entity_id === 'string' && s.entity_id.startsWith('media_player.'))
      .map((s) => ({
        id: s.entity_id,
        name: s.attributes?.friendly_name || s.entity_id,
        state: s.state || 'unknown',
        supportedFeatures: Number(s.attributes?.supported_features) || 0,
        volume: typeof s.attributes?.volume_level === 'number' ? s.attributes.volume_level : null,
      } satisfies HaEntityRef));
  } catch (err: any) {
    process.stdout.write(`[ha] listEntities failed: ${err?.message ?? err}\n`);
    return [];
  }
}

/** Point an HA entity at a local file. Reuses the shared media server:
 *  HA fetches from `http://<lan-ip>:<port>/media/<token>/<name>` — same
 *  URL shape Cast uses. */
export async function haPlay(
  entityId: string,
  filePath: string,
  meta?: { title?: string; artist?: string; album?: string }
): Promise<void> {
  if (!haConfig()) throw new Error('Home Assistant not configured');
  await ensureMediaServer();
  setCurrentServePath(filePath);
  const url = urlForServedFile(filePath);
  process.stdout.write(`[ha] play → ${entityId} :: ${url}\n`);

  const body: any = {
    entity_id: entityId,
    media_content_id: url,
    media_content_type: 'music',
  };
  // Some HA integrations honour `extra` metadata in play_media (Sonos,
  // MusicAssistant). Harmless on those that don't.
  if (meta) {
    body.extra = {
      metadata: {
        title: meta.title,
        artist: meta.artist,
        albumName: meta.album,
      },
    };
  }
  await haRequest<unknown>('/api/services/media_player/play_media', { method: 'POST', body });
  activeEntityId = entityId;

  // Fresh polling for the new active target. HA doesn't push state
  // updates over REST, so we pull `/api/states/<entity>` every second.
  // Same cadence as Cast's `getStatus` poll — drives the scrubber.
  stopStatusPolling();
  statusPollTimer = setInterval(() => {
    if (activeEntityId !== entityId) { stopStatusPolling(); return; }
    void pollOnce(entityId);
  }, 1000);
  // Fire one immediately so the UI doesn't wait a tick for its first
  // state transition from IDLE → PLAYING.
  void pollOnce(entityId);
}

/**
 * Convert HA's media_player state + attributes into the normalised
 * {currentTime, duration, playerState} shape the renderer expects.
 *
 * HA reports position as two fields:
 *   - `media_position`           — position at measurement time
 *   - `media_position_updated_at` — ISO timestamp of that measurement
 * While `state === "playing"`, the current position is
 * media_position + (now - media_position_updated_at). While paused, it's
 * media_position as-is. This tracking avoids the scrubber feeling like
 * it's moving in 1-second leaps; instead it advances smoothly between
 * polls because we extrapolate locally.
 */
async function pollOnce(entityId: string): Promise<void> {
  try {
    const s = await haRequest<any>(`/api/states/${encodeURIComponent(entityId)}`);
    if (!s || typeof s !== 'object') return;
    const state: string = s.state || 'unknown';
    const attrs = s.attributes || {};
    const mediaPos = typeof attrs.media_position === 'number' ? attrs.media_position : 0;
    const updatedAt = typeof attrs.media_position_updated_at === 'string' ? Date.parse(attrs.media_position_updated_at) : Date.now();
    const drift = state === 'playing' ? Math.max(0, (Date.now() - updatedAt) / 1000) : 0;
    const currentTime = mediaPos + drift;
    const duration = typeof attrs.media_duration === 'number' && attrs.media_duration > 0 ? attrs.media_duration : null;
    const playerState =
      state === 'playing' ? 'PLAYING' :
      state === 'paused'  ? 'PAUSED'  :
      state === 'buffering' ? 'BUFFERING' :
      state === 'idle' || state === 'off' ? 'IDLE' :
      'UNKNOWN';
    statusListener?.({ entityId, currentTime, duration, playerState });
  } catch (err: any) {
    // Transient poll errors are common (HA restarts, network blips).
    // Don't spam — log only once per run on first failure by marking
    // a sentinel. Quiet behaviour since the 1 Hz loop would otherwise
    // produce 60 identical lines a minute while HA is down.
    if (!pollFailedOnce) {
      pollFailedOnce = true;
      process.stdout.write(`[ha] poll error (silencing further): ${err?.message ?? err}\n`);
    }
  }
}
let pollFailedOnce = false;

/**
 * HA service-call helpers. Each wraps one `/api/services/media_player/…`
 * endpoint. They never throw to the caller — a chronically-unreliable
 * HA install (restarting, auth rotating, VPN flapping) shouldn't
 * surface as IPC rejections in the renderer. Log and swallow is the
 * same pattern Cast uses via safeCastOp.
 */
async function serviceCall(service: string, body: Record<string, unknown>): Promise<void> {
  try {
    await haRequest<unknown>(`/api/services/media_player/${service}`, { method: 'POST', body });
  } catch (err: any) {
    process.stdout.write(`[ha] ${service} failed: ${err?.message ?? err}\n`);
  }
}

export async function haPause(): Promise<void> {
  if (!activeEntityId) return;
  process.stdout.write(`[ha] pause ${activeEntityId}\n`);
  await serviceCall('media_pause', { entity_id: activeEntityId });
}

export async function haResume(): Promise<void> {
  if (!activeEntityId) return;
  process.stdout.write(`[ha] resume ${activeEntityId}\n`);
  // HA's "resume from paused" is media_play — the same verb used to
  // start media that's been loaded. Distinct from play_media (load a
  // new URL) which we already sent in haPlay().
  await serviceCall('media_play', { entity_id: activeEntityId });
}

export async function haSeek(seconds: number): Promise<void> {
  if (!activeEntityId) return;
  const t = Math.max(0, Math.floor(seconds));
  process.stdout.write(`[ha] seek ${activeEntityId} → ${t}s\n`);
  await serviceCall('media_seek', { entity_id: activeEntityId, seek_position: t });
}

export async function haSetVolume(level: number): Promise<void> {
  if (!activeEntityId) return;
  const v = Math.max(0, Math.min(1, level));
  await serviceCall('volume_set', { entity_id: activeEntityId, volume_level: v });
}

export async function haStop(): Promise<void> {
  stopStatusPolling();
  if (!activeEntityId) return;
  const id = activeEntityId;
  activeEntityId = null;
  pollFailedOnce = false;
  process.stdout.write(`[ha] stop ${id}\n`);
  await serviceCall('media_stop', { entity_id: id });
}

// Silence unused import warning for path — kept in case a future tweak
// wants to derive mime hints here. Trivial cost.
void path;
