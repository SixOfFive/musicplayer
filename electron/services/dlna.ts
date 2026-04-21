// DLNA / UPnP AV support. Two responsibilities, colocated because they
// share discovery plumbing and the same shared media HTTP server:
//
//   1. CONTROLLER (sender) — discover MediaRenderer devices on the LAN
//      via SSDP, parse their device descriptions, and drive them via
//      SOAP AVTransport + RenderingControl. Lets the user route the
//      current track to a DLNA speaker (VLC's built-in renderer, a
//      Kodi box, Samsung/LG TVs, smart AVRs, DLNA-capable hi-fi, etc.)
//      through the same output-picker as Cast and HA.
//
//   2. RENDERER (receiver) — advertise THIS app as a MediaRenderer on
//      the LAN so other DLNA senders (VLC's "Render to...", BubbleUPnP
//      on Android, HA's `media_player.dlna_dmr`, etc.) can push a
//      media URL at us. We host the bare minimum UPnP descriptions and
//      SOAP handlers, fetch the incoming URL, and push it into the
//      renderer's `<audio>` element via an IPC event.
//
// Why hand-roll rather than use `dlna-upnp-renderer` or similar: those
// packages either haven't been updated in years or bundle GUIs / CLI
// wrappers we don't want in-process. The protocol is simple — a dozen
// SOAP actions, all documented in the UPnP AV specs — and keeping the
// server visible means the "why isn't my TV showing up?" debug loop
// stays in one file instead of jumping through a vendored lib.
//
// Startup progress reporting: the app wants to show a scan indicator
// while we sweep the LAN. Discovery is inherently passive — SSDP is
// best-effort multicast — so "progress" is really "time elapsed in the
// initial search window." We emit progress ticks to the renderer via
// IPC (ch: DLNA_SCAN) containing elapsed/total + current device count.

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { URL } from 'node:url';
import path from 'node:path';

// Both deps ship as transitive deps of chromecast-api, but we list
// them explicitly in package.json so our usage isn't coupled to what
// chromecast-api happens to depend on.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const ssdpLib = require('node-ssdp');
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const xml2js = require('xml2js');

import {
  ensureMediaServer,
  setCurrentServePath,
  urlForServedFile,
  firstLanIp,
  MIME_BY_EXT,
} from './media-server';

// ----------------------------------------------------------------------------
// Shared types
// ----------------------------------------------------------------------------

/** One MediaRenderer discovered on the LAN. */
export interface DlnaDeviceRef {
  id: string;                  // UDN (uuid:… from the device description)
  name: string;                // friendlyName
  host: string;                // IP:port the SOAP endpoints live on
  manufacturer?: string;
  modelName?: string;
  /** Absolute URLs for each service's control endpoint (we send SOAP here). */
  avTransportControlUrl?: string;
  renderingControlControlUrl?: string;
}

/** Push-status update for the active DLNA renderer. Shape matches the
 *  Cast/HA status pattern so the renderer's player-store subscriber
 *  handles all three sink kinds with the same logic. */
export interface DlnaStatusUpdate {
  deviceId: string;
  currentTime: number;
  duration: number | null;
  playerState: 'PLAYING' | 'PAUSED' | 'BUFFERING' | 'IDLE' | 'UNKNOWN';
}

type DlnaStatusListener = (u: DlnaStatusUpdate) => void;
let statusListener: DlnaStatusListener | null = null;
export function onDlnaStatus(listener: DlnaStatusListener | null): void { statusListener = listener; }

/** Progress update emitted during the initial scan window. The picker
 *  turns this into a spinner + "N found" caption. */
export interface DlnaScanProgress {
  /** Milliseconds elapsed since scan start. */
  elapsedMs: number;
  /** Total window we'll keep scanning for. After this, further responses
   *  still register devices, but the UI stops showing a progress bar. */
  totalMs: number;
  /** Devices found so far (live count, not historical). */
  found: number;
  /** Did the initial window finish? `true` once elapsed ≥ total. */
  done: boolean;
}

type DlnaScanListener = (p: DlnaScanProgress) => void;
let scanListener: DlnaScanListener | null = null;
export function onDlnaScanProgress(listener: DlnaScanListener | null): void { scanListener = listener; }

// ----------------------------------------------------------------------------
// Controller (sender) — discovery + SOAP transport
// ----------------------------------------------------------------------------

const devicesByUdn = new Map<string, DlnaDeviceRef>();
let activeDeviceId: string | null = null;
let statusPollTimer: NodeJS.Timeout | null = null;
let ssdpClient: any = null;
let discoveryStartedAt: number | null = null;

/** Length of the "loud" initial scan window — how long the UI shows a
 *  progress indicator. We keep listening for SSDP responses forever; this
 *  just bounds the initial boot-time feedback loop so the indicator
 *  doesn't spin forever. */
const INITIAL_SCAN_MS = 6000;

/** Cadence of progress pulses during the initial scan. Smooth enough that
 *  a spinner feels alive, cheap enough we don't flood IPC. */
const SCAN_TICK_MS = 250;

export function listDlnaDevices(): DlnaDeviceRef[] {
  return Array.from(devicesByUdn.values());
}

export function dlnaActiveDeviceId(): string | null { return activeDeviceId; }

/**
 * Fire up SSDP discovery. Idempotent — subsequent calls start a fresh
 * scan WINDOW (progress ticks restart from 0) without re-creating the
 * SSDP client. That lets the output picker trigger a visible re-scan
 * every time the user opens the dropdown, while keeping the underlying
 * socket alive so any NOTIFY packets arriving between scans are still
 * captured.
 *
 * We search specifically for `MediaRenderer:1` rather than `ssdp:all`
 * so we don't flood our own log with routers, printers, and every
 * other UPnP-announcing gadget on the LAN.
 */
export function startDlnaDiscovery(): void {
  // Fresh client + progress window on first call; just a new window
  // + re-M-SEARCH on subsequent calls.
  if (ssdpClient) {
    discoveryStartedAt = Date.now();
    try { ssdpClient.search('urn:schemas-upnp-org:device:MediaRenderer:1'); } catch { /* noop */ }
    process.stdout.write(`[dlna] re-scan requested — M-SEARCH resent\n`);
    scheduleScanTicks();
    return;
  }
  discoveryStartedAt = Date.now();

  const client = new ssdpLib.Client({
    // Explicit custom headers so some stricter stacks (older Samsung TVs,
    // BubbleUPnP) return complete NT+USN headers.
    customLogger: () => { /* silent — node-ssdp's built-in logs are noisy */ },
  });
  ssdpClient = client;

  client.on('response', (headers: any, _status: number, rinfo: any) => {
    void handleSsdpResponse(headers, rinfo);
  });

  // MediaRenderer is the ST (search target) for anything that can accept
  // pushed media. AVTransport is a service every MediaRenderer implements.
  // We search for MediaRenderer to capture the device description URL
  // (LOCATION header); individual service URLs come from parsing that.
  client.search('urn:schemas-upnp-org:device:MediaRenderer:1');
  process.stdout.write(`[dlna] SSDP M-SEARCH for MediaRenderer:1 sent\n`);

  // Re-search a couple of times across the scan window to catch devices
  // that didn't reply to the first packet (common on congested WiFi).
  setTimeout(() => { try { client.search('urn:schemas-upnp-org:device:MediaRenderer:1'); } catch { /* noop */ } }, 1500);
  setTimeout(() => { try { client.search('urn:schemas-upnp-org:device:MediaRenderer:1'); } catch { /* noop */ } }, 3500);

  scheduleScanTicks();
}

/** Kick off a fresh progress-tick loop bounded by INITIAL_SCAN_MS. Called
 *  on the first discovery start AND on every user-triggered rescan. Each
 *  call increments a generation counter so the previous loop (if any)
 *  exits cleanly without fighting the new one over scanListener calls. */
let scanGeneration = 0;
function scheduleScanTicks(): void {
  const myGen = ++scanGeneration;
  const tick = () => {
    if (myGen !== scanGeneration) return;  // a newer rescan has taken over
    if (!scanListener || discoveryStartedAt === null) return;
    const elapsed = Date.now() - discoveryStartedAt;
    const done = elapsed >= INITIAL_SCAN_MS;
    scanListener({
      elapsedMs: Math.min(elapsed, INITIAL_SCAN_MS),
      totalMs: INITIAL_SCAN_MS,
      found: devicesByUdn.size,
      done,
    });
    if (!done) setTimeout(tick, SCAN_TICK_MS);
  };
  setTimeout(tick, SCAN_TICK_MS);
}

/** Parse an SSDP NOTIFY / M-SEARCH response, fetch the device description
 *  if we haven't already, and populate `devicesByUdn`. Silently drops
 *  anything that isn't a MediaRenderer — M-SEARCH responses sometimes
 *  arrive for the parent device even when we asked for MediaRenderer. */
async function handleSsdpResponse(headers: any, rinfo: any): Promise<void> {
  const location: string | undefined = headers.LOCATION || headers.Location || headers.location;
  const st: string = headers.ST || headers.NT || '';
  const usn: string = headers.USN || '';
  if (!location) return;
  if (!st.includes('MediaRenderer') && !usn.includes('MediaRenderer')) {
    // Some devices reply once per embedded service — their MediaRenderer
    // announcement will arrive separately. Cheap to skip the non-MediaRenderer
    // packets rather than fetch every description.
    return;
  }

  // UDN is the canonical device identifier; prefer it over IP+port.
  // USN format: `uuid:xxx::urn:schemas-upnp-org:device:MediaRenderer:1`
  const udnMatch = /^uuid:[^:]+/.exec(usn);
  const udn = udnMatch ? udnMatch[0] : `host:${rinfo.address}:${rinfo.port}`;

  // Skip our own receiver — we advertise + M-SEARCH on the same box,
  // so our NOTIFY packets come back in the search results. Without
  // this filter the user sees "MusicPlayer" in their own output picker,
  // which at best is confusing and at worst creates a feedback loop
  // if they pick it.
  if (udn === RECEIVER_UDN) return;

  // Guard against the race where multiple SSDP responses for the same
  // UDN arrive concurrently: each reaches the `has` check before the
  // first fetch completes and writes the entry. Pre-plant a sentinel
  // so concurrent handlers bail out; we replace it with the real
  // description (or delete it) when fetchDeviceDescription resolves.
  if (devicesByUdn.has(udn) || inFlightFetches.has(udn)) return;
  inFlightFetches.add(udn);

  try {
    const desc = await fetchDeviceDescription(location);
    if (!desc) return;
    devicesByUdn.set(udn, desc);
    process.stdout.write(`[dlna] discovered: ${desc.name} (${desc.manufacturer ?? '?'} / ${desc.modelName ?? '?'}) @ ${desc.host}\n`);
  } catch (err: any) {
    process.stdout.write(`[dlna] description fetch failed (${location}): ${err?.message ?? err}\n`);
  } finally {
    inFlightFetches.delete(udn);
  }
}
const inFlightFetches = new Set<string>();

/**
 * GET the device description XML and extract what we need: friendlyName,
 * UDN, and the absolute control URLs for AVTransport + RenderingControl.
 *
 * controlURL is relative to URLBase (if present) or the location URL's
 * origin. Most devices omit URLBase — fall back to origin-relative
 * resolution, which is what the spec recommends.
 */
async function fetchDeviceDescription(locationUrl: string): Promise<DlnaDeviceRef | null> {
  const res = await fetch(locationUrl, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) return null;
  const xml = await res.text();
  const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false, ignoreAttrs: true });
  const device = parsed?.root?.device;
  if (!device) return null;

  const base = new URL(locationUrl);
  const urlBase: string | undefined = parsed?.root?.URLBase;
  const resolve = (u: string | undefined): string | undefined => {
    if (!u) return undefined;
    if (urlBase) return new URL(u, urlBase).toString();
    return new URL(u, `${base.protocol}//${base.host}`).toString();
  };

  const services = Array.isArray(device.serviceList?.service)
    ? device.serviceList.service
    : device.serviceList?.service ? [device.serviceList.service] : [];
  let avTransport: string | undefined;
  let renderingControl: string | undefined;
  for (const s of services) {
    const st: string = s.serviceType || '';
    if (st.includes('AVTransport'))       avTransport      = resolve(s.controlURL);
    if (st.includes('RenderingControl'))  renderingControl = resolve(s.controlURL);
  }

  // Ignore devices that don't expose AVTransport — they can't actually
  // play media, so they're useless for our picker. Rare but happens with
  // malformed ContentDirectory-only servers that mis-advertise.
  if (!avTransport) return null;

  const udn: string = device.UDN || `host:${base.host}`;
  const name: string = device.friendlyName || udn;
  const host = base.host;
  return {
    id: udn,
    name,
    host,
    manufacturer: device.manufacturer,
    modelName: device.modelName,
    avTransportControlUrl: avTransport,
    renderingControlControlUrl: renderingControl,
  };
}

// ----------------------------------------------------------------------------
// SOAP helpers
// ----------------------------------------------------------------------------

/**
 * Send a SOAP action to a service's control URL. Returns the parsed
 * response body (or `{}` for void actions).
 *
 * The protocol is rigid: `SOAPACTION` header must be exactly the
 * `"<serviceType>#<action>"` string (including the double quotes), and
 * the body must be a proper SOAP 1.1 envelope. Some older DLNA stacks
 * also reject requests without a `User-Agent` header.
 */
async function soapAction(
  controlUrl: string,
  serviceType: string,
  action: string,
  args: Record<string, string | number>,
): Promise<any> {
  const argXml = Object.entries(args)
    .map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`)
    .join('');
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${serviceType}">
      ${argXml}
    </u:${action}>
  </s:Body>
</s:Envelope>`;

  const res = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      'SOAPACTION': `"${serviceType}#${action}"`,
      'User-Agent': 'MusicPlayer/DLNA',
      'Connection': 'close',
    },
    body,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`SOAP ${action} → ${res.status} ${res.statusText}`);
  const text = await res.text();
  const parsed = await xml2js.parseStringPromise(text, { explicitArray: false, ignoreAttrs: true });
  const envelope = parsed?.['s:Envelope'] || parsed?.Envelope;
  const body2 = envelope?.['s:Body'] || envelope?.Body;
  // Response element is named `<u:ActionResponse>`; we don't care about
  // the `u:` prefix, so just grab the first key.
  for (const key of Object.keys(body2 || {})) {
    if (key.endsWith('Response')) return body2[key] ?? {};
  }
  return {};
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** DIDL-Lite metadata blob some renderers REQUIRE for SetAVTransportURI.
 *  Samsung TVs in particular will refuse to play without it. Keep it
 *  minimal — friendly title, class audio item, ref the URL — rather
 *  than a full DLNA.ORG_PN decoration we don't know per-device anyway. */
function buildDidlLite(title: string, url: string, mime: string, artist?: string, album?: string): string {
  const xml = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
<item id="1" parentID="0" restricted="1">
<dc:title>${escapeXml(title)}</dc:title>
${artist ? `<upnp:artist>${escapeXml(artist)}</upnp:artist>` : ''}
${album ? `<upnp:album>${escapeXml(album)}</upnp:album>` : ''}
<upnp:class>object.item.audioItem.musicTrack</upnp:class>
<res protocolInfo="http-get:*:${mime}:*">${escapeXml(url)}</res>
</item>
</DIDL-Lite>`;
  return xml;
}

// ----------------------------------------------------------------------------
// Sender transport — the public API called by IPC
// ----------------------------------------------------------------------------

const AVTRANSPORT_TYPE = 'urn:schemas-upnp-org:service:AVTransport:1';
const RENDERING_TYPE   = 'urn:schemas-upnp-org:service:RenderingControl:1';

function requireDevice(id: string): DlnaDeviceRef {
  const d = devicesByUdn.get(id);
  if (!d) throw new Error(`DLNA device not found: ${id}`);
  return d;
}

function stopStatusPolling(): void {
  if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
}

export async function dlnaPlay(
  deviceId: string,
  filePath: string,
  meta?: { title?: string; artist?: string; album?: string },
): Promise<void> {
  const d = requireDevice(deviceId);
  if (!d.avTransportControlUrl) throw new Error('Device has no AVTransport control URL');

  await ensureMediaServer();
  setCurrentServePath(filePath);
  const url = urlForServedFile(filePath);
  const mime = MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const didl = buildDidlLite(meta?.title ?? path.basename(filePath), url, mime, meta?.artist, meta?.album);

  process.stdout.write(`[dlna] play → ${d.name} :: ${url}\n`);

  // Order matters: SetAVTransportURI first (loads the resource),
  // then Play. Some renderers (older Philips TVs) refuse a Play without
  // a fresh URI even if one's already queued.
  await soapAction(d.avTransportControlUrl, AVTRANSPORT_TYPE, 'SetAVTransportURI', {
    InstanceID: 0,
    CurrentURI: url,
    CurrentURIMetaData: didl,
  });
  await soapAction(d.avTransportControlUrl, AVTRANSPORT_TYPE, 'Play', {
    InstanceID: 0,
    Speed: 1,
  });

  activeDeviceId = deviceId;

  // Polling: DLNA doesn't push status, so we pull GetPositionInfo +
  // GetTransportInfo at 1 Hz for the scrubber. Same cadence as Cast/HA.
  stopStatusPolling();
  statusPollTimer = setInterval(() => {
    if (activeDeviceId !== deviceId) { stopStatusPolling(); return; }
    void pollOnce(deviceId).catch(() => { /* swallow, transient */ });
  }, 1000);
  void pollOnce(deviceId);
}

async function pollOnce(deviceId: string): Promise<void> {
  const d = devicesByUdn.get(deviceId);
  if (!d?.avTransportControlUrl) return;
  try {
    const [pos, trans] = await Promise.all([
      soapAction(d.avTransportControlUrl, AVTRANSPORT_TYPE, 'GetPositionInfo', { InstanceID: 0 }),
      soapAction(d.avTransportControlUrl, AVTRANSPORT_TYPE, 'GetTransportInfo', { InstanceID: 0 }),
    ]);
    const currentTime = parseHhmmss(pos?.RelTime);
    const duration = parseHhmmss(pos?.TrackDuration);
    const state = String(trans?.CurrentTransportState || '');
    const playerState: DlnaStatusUpdate['playerState'] =
      state === 'PLAYING' ? 'PLAYING' :
      state === 'PAUSED_PLAYBACK' || state === 'PAUSED' ? 'PAUSED' :
      state === 'TRANSITIONING' ? 'BUFFERING' :
      state === 'STOPPED' || state === 'NO_MEDIA_PRESENT' ? 'IDLE' :
      'UNKNOWN';
    statusListener?.({ deviceId, currentTime, duration: duration > 0 ? duration : null, playerState });
  } catch {
    /* quiet — renderers restart, networks blip; one poll failure is fine */
  }
}

/** "HH:MM:SS.ms" → seconds. DLNA returns durations in this exact format.
 *  Returns 0 on parse failure so the scrubber doesn't NaN out. */
function parseHhmmss(s: unknown): number {
  if (typeof s !== 'string') return 0;
  const m = /^(\d+):(\d+):(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(`0.${m[4]}`) : 0);
}

/** seconds → "HH:MM:SS". Used for Seek (DLNA action wants this format). */
function toHhmmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

async function safeSoap(label: string, fn: () => Promise<any>): Promise<void> {
  try { await fn(); }
  catch (err: any) {
    process.stdout.write(`[dlna] ${label} failed: ${err?.message ?? err}\n`);
  }
}

export async function dlnaPause(): Promise<void> {
  if (!activeDeviceId) return;
  const d = devicesByUdn.get(activeDeviceId);
  if (!d?.avTransportControlUrl) return;
  process.stdout.write(`[dlna] pause ${d.name}\n`);
  await safeSoap('Pause', () => soapAction(d.avTransportControlUrl!, AVTRANSPORT_TYPE, 'Pause', { InstanceID: 0 }));
}

export async function dlnaResume(): Promise<void> {
  if (!activeDeviceId) return;
  const d = devicesByUdn.get(activeDeviceId);
  if (!d?.avTransportControlUrl) return;
  process.stdout.write(`[dlna] resume ${d.name}\n`);
  await safeSoap('Play', () => soapAction(d.avTransportControlUrl!, AVTRANSPORT_TYPE, 'Play', { InstanceID: 0, Speed: 1 }));
}

export async function dlnaSeek(seconds: number): Promise<void> {
  if (!activeDeviceId) return;
  const d = devicesByUdn.get(activeDeviceId);
  if (!d?.avTransportControlUrl) return;
  const target = toHhmmss(seconds);
  process.stdout.write(`[dlna] seek ${d.name} → ${target}\n`);
  await safeSoap('Seek', () => soapAction(d.avTransportControlUrl!, AVTRANSPORT_TYPE, 'Seek', {
    InstanceID: 0,
    Unit: 'REL_TIME',
    Target: target,
  }));
}

export async function dlnaSetVolume(level: number): Promise<void> {
  if (!activeDeviceId) return;
  const d = devicesByUdn.get(activeDeviceId);
  if (!d?.renderingControlControlUrl) return;
  // DLNA volume is 0-100 integer. Some renderers accept 0-255, but the
  // spec says 0-100 and every mainstream renderer follows it. Off-spec
  // devices can tolerate silent truncation at 100.
  const v = Math.max(0, Math.min(100, Math.round(level * 100)));
  await safeSoap('SetVolume', () => soapAction(d.renderingControlControlUrl!, RENDERING_TYPE, 'SetVolume', {
    InstanceID: 0,
    Channel: 'Master',
    DesiredVolume: v,
  }));
}

export async function dlnaStop(): Promise<void> {
  stopStatusPolling();
  if (!activeDeviceId) return;
  const d = devicesByUdn.get(activeDeviceId);
  const id = activeDeviceId;
  activeDeviceId = null;
  if (!d?.avTransportControlUrl) return;
  process.stdout.write(`[dlna] stop ${d.name}\n`);
  await safeSoap('Stop', () => soapAction(d.avTransportControlUrl!, AVTRANSPORT_TYPE, 'Stop', { InstanceID: 0 }));
  void id; // suppress unused
}

// ============================================================================
// Receiver — advertise this app as a MediaRenderer
// ============================================================================
//
// When another DLNA sender pushes media at us, we get a SOAP POST on
// our AVTransport control endpoint. We extract the URI, set it on the
// renderer's `<audio>` element via an IPC event, and echo state
// changes back through RenderingControl LastChange (not implemented —
// most senders don't observe it anyway).
//
// The minimum-viable device description declares:
//   - AVTransport (required for SetAVTransportURI + Play/Pause/Stop/Seek)
//   - RenderingControl (required; senders call GetVolume even if we don't honour it)
//   - ConnectionManager (required by spec; we just return a GetProtocolInfo stub)

const RECEIVER_UDN = `uuid:${crypto.randomUUID()}`;
let receiverServer: http.Server | null = null;
let receiverPort: number = 0;
let receiverFriendlyName = 'MusicPlayer';
let ssdpServer: any = null;

/** Event fired when a remote sender pushes a URL at us. Main pipes this
 *  to the renderer so the `<audio>` element starts playing the URL. */
export interface DlnaIncomingMedia {
  uri: string;
  title?: string;
  artist?: string;
  album?: string;
}
type IncomingListener = (m: DlnaIncomingMedia) => void;
let incomingListener: IncomingListener | null = null;
export function onDlnaIncomingMedia(listener: IncomingListener | null): void { incomingListener = listener; }

/** Transport state we report back to senders that poll us. The renderer
 *  tells us what state to report via `setReceiverState`. */
let receiverState: { transport: 'PLAYING' | 'PAUSED_PLAYBACK' | 'STOPPED' | 'TRANSITIONING'; positionSec: number; durationSec: number; currentUri: string } = {
  transport: 'STOPPED',
  positionSec: 0,
  durationSec: 0,
  currentUri: '',
};
export function setReceiverState(state: Partial<typeof receiverState>): void {
  receiverState = { ...receiverState, ...state };
}

export async function startDlnaReceiver(friendlyName?: string): Promise<void> {
  if (receiverServer) return;
  if (friendlyName) receiverFriendlyName = friendlyName;

  receiverServer = http.createServer((req, res) => {
    void handleReceiverHttp(req, res).catch((err) => {
      process.stdout.write(`[dlna-receiver] handler error: ${err?.message ?? err}\n`);
      try { res.statusCode = 500; res.end(); } catch { /* noop */ }
    });
  });
  await new Promise<void>((resolve, reject) => {
    receiverServer!.once('error', reject);
    receiverServer!.listen(0, '0.0.0.0', () => resolve());
  });
  const addr = receiverServer!.address();
  receiverPort = typeof addr === 'object' && addr ? addr.port : 0;
  process.stdout.write(`[dlna-receiver] listening on :${receiverPort} as "${receiverFriendlyName}"\n`);

  // SSDP advertise. node-ssdp's Server re-announces on its own cadence
  // (default 1800s with "freshness" NOTIFYs every 90s) and responds to
  // M-SEARCH probes on port 1900.
  const ip = firstLanIp();
  if (!ip) {
    process.stdout.write('[dlna-receiver] no LAN IP — advertising skipped; LAN clients won\'t discover us\n');
    return;
  }
  const location = `http://${ip}:${receiverPort}/dlna/device.xml`;
  ssdpServer = new ssdpLib.Server({
    udn: RECEIVER_UDN,
    location,
    adInterval: 60000,
    ttl: 4,
    customLogger: () => { /* silent */ },
  });
  ssdpServer.addUSN('upnp:rootdevice');
  ssdpServer.addUSN('urn:schemas-upnp-org:device:MediaRenderer:1');
  ssdpServer.addUSN('urn:schemas-upnp-org:service:AVTransport:1');
  ssdpServer.addUSN('urn:schemas-upnp-org:service:RenderingControl:1');
  ssdpServer.addUSN('urn:schemas-upnp-org:service:ConnectionManager:1');
  await new Promise<void>((resolve) => ssdpServer.start(resolve));
  process.stdout.write(`[dlna-receiver] SSDP advertising at ${location}\n`);
}

async function handleReceiverHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'GET' && p === '/dlna/device.xml') {
    return respond(res, 200, 'text/xml; charset=utf-8', deviceDescriptionXml());
  }
  if (req.method === 'GET' && p === '/dlna/AVTransport.xml') {
    return respond(res, 200, 'text/xml; charset=utf-8', AVTRANSPORT_SCPD);
  }
  if (req.method === 'GET' && p === '/dlna/RenderingControl.xml') {
    return respond(res, 200, 'text/xml; charset=utf-8', RENDERING_CONTROL_SCPD);
  }
  if (req.method === 'GET' && p === '/dlna/ConnectionManager.xml') {
    return respond(res, 200, 'text/xml; charset=utf-8', CONNECTION_MANAGER_SCPD);
  }

  if (req.method === 'POST' && (p === '/dlna/AVTransport/control' || p === '/dlna/RenderingControl/control' || p === '/dlna/ConnectionManager/control')) {
    const body = await readBody(req);
    const soapAction = String(req.headers.soapaction || '').replace(/"/g, '');
    const actionName = soapAction.split('#')[1] ?? '';
    const response = await handleSoapAction(actionName, body);
    return respond(res, 200, 'text/xml; charset=utf-8', response);
  }

  // Event subscriptions (UPnP uses a custom SUBSCRIBE verb). Senders that
  // observe LastChange will SUBSCRIBE here. We stub this to 200 with an
  // SID header — we don't actually deliver events, but the connection
  // attempt succeeds so the sender doesn't disconnect / retry.
  if ((req.method === 'SUBSCRIBE' || req.method === 'UNSUBSCRIBE') && p.endsWith('/event')) {
    res.writeHead(200, {
      'SID': `uuid:${crypto.randomUUID()}`,
      'TIMEOUT': 'Second-1800',
    });
    res.end();
    return;
  }

  res.statusCode = 404;
  res.end();
}

function respond(res: http.ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

/** Handle an incoming SOAP action from a DLNA sender. Each returns a
 *  valid SOAP envelope — even for actions we don't really implement, we
 *  send back empty responses so the sender doesn't loop. */
async function handleSoapAction(action: string, body: string): Promise<string> {
  const parsed = await xml2js.parseStringPromise(body, { explicitArray: false, ignoreAttrs: false });
  const env = parsed?.['s:Envelope'] || parsed?.Envelope;
  const soapBody = env?.['s:Body'] || env?.Body;
  // Walk into the action request — the element name varies by namespace
  // prefix, so find the first key that isn't a known envelope field.
  let actionArgs: any = {};
  for (const k of Object.keys(soapBody || {})) {
    if (k === '$') continue;
    actionArgs = soapBody[k] ?? {};
    break;
  }

  switch (action) {
    case 'SetAVTransportURI': {
      const uri: string = actionArgs.CurrentURI || '';
      let title: string | undefined, artist: string | undefined, album: string | undefined;
      const metadataRaw: string = actionArgs.CurrentURIMetaData || '';
      if (metadataRaw) {
        try {
          const didl = await xml2js.parseStringPromise(metadataRaw, { explicitArray: false, ignoreAttrs: true });
          const item = didl?.['DIDL-Lite']?.item;
          title = item?.['dc:title'] || item?.title;
          artist = item?.['upnp:artist'] || item?.artist;
          album = item?.['upnp:album'] || item?.album;
        } catch { /* metadata is optional */ }
      }
      process.stdout.write(`[dlna-receiver] SetAVTransportURI: ${uri}\n`);
      receiverState.currentUri = uri;
      receiverState.transport = 'STOPPED';  // sender usually sends Play next
      incomingListener?.({ uri, title, artist, album });
      return soapResponse('SetAVTransportURI', AVTRANSPORT_TYPE, {});
    }
    case 'Play':
      receiverState.transport = 'PLAYING';
      return soapResponse('Play', AVTRANSPORT_TYPE, {});
    case 'Pause':
      receiverState.transport = 'PAUSED_PLAYBACK';
      return soapResponse('Pause', AVTRANSPORT_TYPE, {});
    case 'Stop':
      receiverState.transport = 'STOPPED';
      return soapResponse('Stop', AVTRANSPORT_TYPE, {});
    case 'Seek': {
      const target = actionArgs.Target || '00:00:00';
      // Target is HH:MM:SS; the renderer-side handler (in main/preload)
      // parses it and calls engine.seek. We just echo success — the
      // renderer will report the new position via the poll back-channel
      // on next tick.
      void target;
      return soapResponse('Seek', AVTRANSPORT_TYPE, {});
    }
    case 'GetTransportInfo':
      return soapResponse('GetTransportInfo', AVTRANSPORT_TYPE, {
        CurrentTransportState: receiverState.transport,
        CurrentTransportStatus: 'OK',
        CurrentSpeed: '1',
      });
    case 'GetPositionInfo':
      return soapResponse('GetPositionInfo', AVTRANSPORT_TYPE, {
        Track: '1',
        TrackDuration: toHhmmss(receiverState.durationSec),
        TrackMetaData: '',
        TrackURI: receiverState.currentUri,
        RelTime: toHhmmss(receiverState.positionSec),
        AbsTime: toHhmmss(receiverState.positionSec),
        RelCount: '0',
        AbsCount: '0',
      });
    case 'GetMediaInfo':
      return soapResponse('GetMediaInfo', AVTRANSPORT_TYPE, {
        NrTracks: '1',
        MediaDuration: toHhmmss(receiverState.durationSec),
        CurrentURI: receiverState.currentUri,
        CurrentURIMetaData: '',
        NextURI: '',
        NextURIMetaData: '',
        PlayMedium: 'NONE',
        RecordMedium: 'NOT_IMPLEMENTED',
        WriteStatus: 'NOT_IMPLEMENTED',
      });
    case 'GetVolume':
      return soapResponse('GetVolume', RENDERING_TYPE, { CurrentVolume: '50' });
    case 'SetVolume':
      // We don't forward sender-set volume to the renderer yet — doing so
      // would require another IPC event + confirmation round-trip, and
      // most senders already drive volume via their own hardware
      // controls. Ack success anyway so the sender's UI snaps to its
      // chosen level.
      return soapResponse('SetVolume', RENDERING_TYPE, {});
    case 'GetMute':
      return soapResponse('GetMute', RENDERING_TYPE, { CurrentMute: '0' });
    case 'SetMute':
      return soapResponse('SetMute', RENDERING_TYPE, {});
    case 'GetProtocolInfo':
      return soapResponse('GetProtocolInfo', 'urn:schemas-upnp-org:service:ConnectionManager:1', {
        Source: '',
        Sink: 'http-get:*:audio/mpeg:*,http-get:*:audio/flac:*,http-get:*:audio/wav:*,http-get:*:audio/mp4:*,http-get:*:audio/aac:*,http-get:*:audio/ogg:*,http-get:*:audio/x-ms-wma:*',
      });
    case 'GetCurrentConnectionIDs':
      return soapResponse('GetCurrentConnectionIDs', 'urn:schemas-upnp-org:service:ConnectionManager:1', { ConnectionIDs: '0' });
    case 'GetCurrentConnectionInfo':
      return soapResponse('GetCurrentConnectionInfo', 'urn:schemas-upnp-org:service:ConnectionManager:1', {
        RcsID: '0',
        AVTransportID: '0',
        ProtocolInfo: '',
        PeerConnectionManager: '',
        PeerConnectionID: '-1',
        Direction: 'Input',
        Status: 'OK',
      });
    default:
      process.stdout.write(`[dlna-receiver] unhandled action: ${action}\n`);
      return soapResponse(action, AVTRANSPORT_TYPE, {});
  }
}

function soapResponse(action: string, serviceType: string, out: Record<string, string>): string {
  const outXml = Object.entries(out).map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action}Response xmlns:u="${serviceType}">${outXml}</u:${action}Response>
  </s:Body>
</s:Envelope>`;
}

function deviceDescriptionXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>${escapeXml(receiverFriendlyName)}</friendlyName>
    <manufacturer>SixOfFive</manufacturer>
    <manufacturerURL>https://github.com/SixOfFive/musicplayer</manufacturerURL>
    <modelDescription>MusicPlayer DLNA renderer</modelDescription>
    <modelName>MusicPlayer</modelName>
    <UDN>${RECEIVER_UDN}</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <SCPDURL>/dlna/AVTransport.xml</SCPDURL>
        <controlURL>/dlna/AVTransport/control</controlURL>
        <eventSubURL>/dlna/AVTransport/event</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <SCPDURL>/dlna/RenderingControl.xml</SCPDURL>
        <controlURL>/dlna/RenderingControl/control</controlURL>
        <eventSubURL>/dlna/RenderingControl/event</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <SCPDURL>/dlna/ConnectionManager.xml</SCPDURL>
        <controlURL>/dlna/ConnectionManager/control</controlURL>
        <eventSubURL>/dlna/ConnectionManager/event</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>`;
}

// Minimal SCPD (Service Control Point Definitions). Senders download
// these to know which actions we support. Listing only the actions
// we actually handle keeps senders from calling into stubs and getting
// confused. Everything is audio-only, no recording, no presets.
const AVTRANSPORT_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>SetAVTransportURI</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>CurrentURI</name><direction>in</direction><relatedStateVariable>AVTransportURI</relatedStateVariable></argument>
      <argument><name>CurrentURIMetaData</name><direction>in</direction><relatedStateVariable>AVTransportURIMetaData</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>Play</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Speed</name><direction>in</direction><relatedStateVariable>TransportPlaySpeed</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>Pause</name><argumentList><argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument></argumentList></action>
    <action><name>Stop</name><argumentList><argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument></argumentList></action>
    <action><name>Seek</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Unit</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SeekMode</relatedStateVariable></argument>
      <argument><name>Target</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SeekTarget</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetTransportInfo</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>CurrentTransportState</name><direction>out</direction><relatedStateVariable>TransportState</relatedStateVariable></argument>
      <argument><name>CurrentTransportStatus</name><direction>out</direction><relatedStateVariable>TransportStatus</relatedStateVariable></argument>
      <argument><name>CurrentSpeed</name><direction>out</direction><relatedStateVariable>TransportPlaySpeed</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetPositionInfo</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Track</name><direction>out</direction><relatedStateVariable>CurrentTrack</relatedStateVariable></argument>
      <argument><name>TrackDuration</name><direction>out</direction><relatedStateVariable>CurrentTrackDuration</relatedStateVariable></argument>
      <argument><name>TrackMetaData</name><direction>out</direction><relatedStateVariable>CurrentTrackMetaData</relatedStateVariable></argument>
      <argument><name>TrackURI</name><direction>out</direction><relatedStateVariable>CurrentTrackURI</relatedStateVariable></argument>
      <argument><name>RelTime</name><direction>out</direction><relatedStateVariable>RelativeTimePosition</relatedStateVariable></argument>
      <argument><name>AbsTime</name><direction>out</direction><relatedStateVariable>AbsoluteTimePosition</relatedStateVariable></argument>
      <argument><name>RelCount</name><direction>out</direction><relatedStateVariable>RelativeCounterPosition</relatedStateVariable></argument>
      <argument><name>AbsCount</name><direction>out</direction><relatedStateVariable>AbsoluteCounterPosition</relatedStateVariable></argument>
    </argumentList></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_InstanceID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>TransportState</name><dataType>string</dataType><allowedValueList><allowedValue>STOPPED</allowedValue><allowedValue>PLAYING</allowedValue><allowedValue>PAUSED_PLAYBACK</allowedValue><allowedValue>TRANSITIONING</allowedValue></allowedValueList></stateVariable>
    <stateVariable sendEvents="no"><name>TransportStatus</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>TransportPlaySpeed</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrack</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrackDuration</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrackMetaData</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrackURI</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AVTransportURI</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AVTransportURIMetaData</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>RelativeTimePosition</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AbsoluteTimePosition</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>RelativeCounterPosition</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AbsoluteCounterPosition</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SeekMode</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SeekTarget</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;

const RENDERING_CONTROL_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>GetVolume</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Channel</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
      <argument><name>CurrentVolume</name><direction>out</direction><relatedStateVariable>Volume</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>SetVolume</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Channel</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
      <argument><name>DesiredVolume</name><direction>in</direction><relatedStateVariable>Volume</relatedStateVariable></argument>
    </argumentList></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_InstanceID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Channel</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>Volume</name><dataType>ui2</dataType><allowedValueRange><minimum>0</minimum><maximum>100</maximum></allowedValueRange></stateVariable>
  </serviceStateTable>
</scpd>`;

const CONNECTION_MANAGER_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>GetProtocolInfo</name><argumentList>
      <argument><name>Source</name><direction>out</direction><relatedStateVariable>SourceProtocolInfo</relatedStateVariable></argument>
      <argument><name>Sink</name><direction>out</direction><relatedStateVariable>SinkProtocolInfo</relatedStateVariable></argument>
    </argumentList></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="yes"><name>SourceProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SinkProtocolInfo</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;

// `os` is imported above for potential future use in friendlyName
// composition (hostname suffix); keeping the import harmless.
void os;
