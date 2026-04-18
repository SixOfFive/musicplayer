// Last.fm Web Services client.
//
// Docs: https://www.last.fm/api
// Users register a personal API account at https://www.last.fm/api/account/create
// and paste their apiKey + apiSecret into Settings → Last.fm. The secret signs
// mutating calls (auth.getSession, track.scrobble, track.updateNowPlaying).
//
// Auth flow (desktop-friendly; no OAuth redirect server needed):
//   1. App calls auth.getToken → token
//   2. App opens browser to `https://www.last.fm/api/auth/?api_key=KEY&token=TOKEN`
//   3. User authorizes in browser
//   4. App calls auth.getSession (signed) with that token → sessionKey (infinite)
//
// All calls JSON via `format=json`. Signed calls also include `api_sig` —
// an MD5 of the param keys sorted alphabetically, concatenated as
// key1val1key2val2..., with the apiSecret appended.

import crypto from 'node:crypto';
import { getSettings, updateSettings } from './settings-store';
import type {
  LastFmArtist, LastFmAlbum, LastFmPeriod, LastFmProfile,
  LastFmStatus, LastFmTrackLite,
} from '../../shared/types';

const API = 'https://ws.audioscrobbler.com/2.0/';
const USER_AGENT = 'MusicPlayer/0.1 (personal; +https://github.com/SixOfFive/musicplayer)';

function cfg() { return getSettings().lastfm; }

export function status(): LastFmStatus {
  const c = cfg();
  return {
    connected: !!c.sessionKey,
    username: c.username || null,
    scrobbleEnabled: !!c.scrobbleEnabled,
    hasCredentials: !!c.apiKey && !!c.apiSecret,
  };
}

/** Picks the largest `image` entry Last.fm returns, if any. */
function imageOf(arr: any): string | null {
  if (!Array.isArray(arr)) return null;
  // images are ordered small → mega; pick last non-empty.
  for (let i = arr.length - 1; i >= 0; i--) {
    const url: string = arr[i]?.['#text'] ?? '';
    if (url && !url.includes('/2a96cbd8b46e442fc41c2b86b821562f.png')) return url; // placeholder
  }
  return null;
}

function sign(params: Record<string, string>, secret: string): string {
  // Exclude format + callback per spec; everything else sorted alphabetically,
  // concatenated as k1v1k2v2..., with secret appended, then md5.
  const keys = Object.keys(params).filter((k) => k !== 'format' && k !== 'callback').sort();
  const base = keys.map((k) => `${k}${params[k]}`).join('');
  return crypto.createHash('md5').update(base + secret, 'utf8').digest('hex');
}

interface CallOpts {
  signed?: boolean;        // adds api_sig
  usePost?: boolean;       // scrobble + nowplaying use POST
}

async function call(method: string, params: Record<string, string>, opts: CallOpts = {}): Promise<any> {
  const { apiKey, apiSecret } = cfg();
  if (!apiKey) throw new Error('LASTFM_NO_KEY');
  const signedParams: Record<string, string> = {
    ...params,
    method,
    api_key: apiKey,
  };
  if (opts.signed) {
    if (!apiSecret) throw new Error('LASTFM_NO_SECRET');
    signedParams.api_sig = sign(signedParams, apiSecret);
  }
  // JSON output for convenience. Signing happens BEFORE we add `format` (spec).
  signedParams.format = 'json';

  const body = new URLSearchParams(signedParams);
  const init: RequestInit = {
    method: opts.usePost ? 'POST' : 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  };
  let url = API;
  if (opts.usePost) {
    init.headers = { ...init.headers, 'Content-Type': 'application/x-www-form-urlencoded' };
    init.body = body.toString();
  } else {
    url = `${API}?${body.toString()}`;
  }
  const r = await fetch(url, init);
  const json = await r.json().catch(() => ({}));
  if (!r.ok || (json as any).error) {
    throw new Error(`Last.fm ${(json as any).error ?? r.status}: ${(json as any).message ?? r.statusText}`);
  }
  return json;
}

// ---- Auth -----------------------------------------------------------------

export async function beginAuth(): Promise<{ token: string; authUrl: string }> {
  const { apiKey } = cfg();
  const json = await call('auth.getToken', {});
  const token: string = json.token;
  return {
    token,
    authUrl: `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`,
  };
}

export async function finishAuth(token: string): Promise<{ username: string }> {
  const json = await call('auth.getSession', { token }, { signed: true });
  const sess = json.session;
  await updateSettings({
    lastfm: {
      ...cfg(),
      sessionKey: sess.key,
      username: sess.name,
    },
  });
  return { username: sess.name };
}

export async function disconnect(): Promise<void> {
  await updateSettings({
    lastfm: { ...cfg(), sessionKey: '', username: '' },
  });
}

export async function setKeys(apiKey: string, apiSecret: string): Promise<void> {
  await updateSettings({
    lastfm: { ...cfg(), apiKey: apiKey.trim(), apiSecret: apiSecret.trim() },
  });
}

export async function setScrobbleEnabled(enabled: boolean): Promise<void> {
  await updateSettings({ lastfm: { ...cfg(), scrobbleEnabled: enabled } });
}

// ---- User queries ---------------------------------------------------------

export async function getProfile(): Promise<LastFmProfile | null> {
  const { username } = cfg();
  if (!username) return null;
  const json = await call('user.getInfo', { user: username });
  const u = json.user;
  return {
    name: u.name,
    realname: u.realname || null,
    url: u.url,
    country: u.country || null,
    playcount: Number(u.playcount) || 0,
    registered: u.registered?.unixtime ? Number(u.registered.unixtime) * 1000 : null,
    image: imageOf(u.image),
  };
}

export async function getTopArtists(period: LastFmPeriod, limit = 30): Promise<LastFmArtist[]> {
  const { username } = cfg();
  if (!username) return [];
  const json = await call('user.getTopArtists', { user: username, period, limit: String(limit) });
  const arr = json?.topartists?.artist ?? [];
  return (Array.isArray(arr) ? arr : []).map((a: any) => ({
    name: a.name,
    playcount: Number(a.playcount) || 0,
    url: a.url,
    image: imageOf(a.image),
  }));
}

export async function getTopTracks(period: LastFmPeriod, limit = 30): Promise<LastFmTrackLite[]> {
  const { username } = cfg();
  if (!username) return [];
  const json = await call('user.getTopTracks', { user: username, period, limit: String(limit) });
  const arr = json?.toptracks?.track ?? [];
  return (Array.isArray(arr) ? arr : []).map((t: any) => ({
    name: t.name,
    artist: t.artist?.name ?? '',
    playcount: Number(t.playcount) || 0,
    url: t.url,
    image: imageOf(t.image),
  }));
}

export async function getTopAlbums(period: LastFmPeriod, limit = 30): Promise<LastFmAlbum[]> {
  const { username } = cfg();
  if (!username) return [];
  const json = await call('user.getTopAlbums', { user: username, period, limit: String(limit) });
  const arr = json?.topalbums?.album ?? [];
  return (Array.isArray(arr) ? arr : []).map((a: any) => ({
    name: a.name,
    artist: a.artist?.name ?? '',
    playcount: Number(a.playcount) || 0,
    url: a.url,
    image: imageOf(a.image),
  }));
}

export async function getRecentTracks(limit = 50): Promise<LastFmTrackLite[]> {
  const { username } = cfg();
  if (!username) return [];
  const json = await call('user.getRecentTracks', { user: username, limit: String(limit), extended: '0' });
  const arr = json?.recenttracks?.track ?? [];
  return (Array.isArray(arr) ? arr : []).map((t: any) => ({
    name: t.name,
    artist: typeof t.artist === 'string' ? t.artist : t.artist?.['#text'] ?? '',
    album: typeof t.album === 'string' ? t.album : t.album?.['#text'] ?? null,
    url: t.url,
    image: imageOf(t.image),
    scrobbledAt: t.date?.uts ? Number(t.date.uts) * 1000 : null,
    nowPlaying: t['@attr']?.nowplaying === 'true',
  }));
}

export async function getChartTopArtists(limit = 30): Promise<LastFmArtist[]> {
  const json = await call('chart.getTopArtists', { limit: String(limit) });
  const arr = json?.artists?.artist ?? [];
  return (Array.isArray(arr) ? arr : []).map((a: any) => ({
    name: a.name,
    listeners: Number(a.listeners) || 0,
    url: a.url,
    image: imageOf(a.image),
  }));
}

export async function getChartTopTracks(limit = 30): Promise<LastFmTrackLite[]> {
  const json = await call('chart.getTopTracks', { limit: String(limit) });
  const arr = json?.tracks?.track ?? [];
  return (Array.isArray(arr) ? arr : []).map((t: any) => ({
    name: t.name,
    artist: t.artist?.name ?? '',
    listeners: Number(t.listeners) || 0,
    url: t.url,
    image: imageOf(t.image),
  }));
}

// ---- Scrobbling -----------------------------------------------------------

export interface ScrobbleInput {
  artist: string;
  track: string;
  album?: string | null;
  albumArtist?: string | null;
  durationSec?: number | null;
  playedAt: number;   // epoch seconds (unix)
}

/** Mark a track as "now playing" on the user's profile. Best-effort. */
export async function updateNowPlaying(input: Omit<ScrobbleInput, 'playedAt'>): Promise<void> {
  const c = cfg();
  if (!c.sessionKey || !c.scrobbleEnabled) return;
  const params: Record<string, string> = {
    artist: input.artist,
    track: input.track,
    sk: c.sessionKey,
  };
  if (input.album) params.album = input.album;
  if (input.albumArtist) params.albumArtist = input.albumArtist;
  if (input.durationSec) params.duration = String(Math.round(input.durationSec));
  try { await call('track.updateNowPlaying', params, { signed: true, usePost: true }); }
  catch (err) { console.warn('[lastfm] updateNowPlaying failed', err); }
}

/**
 * Submit a scrobble for a completed listen. Caller has already verified the
 * listen met Last.fm's eligibility rule (≥30 sec AND (≥4 min OR ≥50% of
 * duration)) — we just submit.
 */
export async function scrobble(input: ScrobbleInput): Promise<void> {
  const c = cfg();
  if (!c.sessionKey || !c.scrobbleEnabled) return;
  const params: Record<string, string> = {
    artist: input.artist,
    track: input.track,
    timestamp: String(Math.floor(input.playedAt)),
    sk: c.sessionKey,
  };
  if (input.album) params.album = input.album;
  if (input.albumArtist) params.albumArtist = input.albumArtist;
  if (input.durationSec) params.duration = String(Math.round(input.durationSec));
  try { await call('track.scrobble', params, { signed: true, usePost: true }); }
  catch (err) { console.warn('[lastfm] scrobble failed', err); }
}
