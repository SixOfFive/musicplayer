// ICY metadata sniffer.
//
// Most Icecast / Shoutcast radio streams expose the currently-playing track
// as inline ICY metadata interleaved with the audio bytes. The scheme:
//
//   1. Client sends `Icy-MetaData: 1` header with the HTTP request.
//   2. Server responds with an `icy-metaint: N` header (bytes between
//      each metadata block) and begins streaming audio.
//   3. Every N audio bytes, a single metadata byte B follows. B * 16 is
//      the metadata block length. B == 0 means "no update this tick".
//   4. The metadata block is a null-padded string like:
//      `StreamTitle='Artist - Song';StreamUrl='...';`
//
// The AudioEngine in the renderer already consumes the stream for playback,
// but browsers hide ICY metadata from the fetch API. So the main process
// opens a SECOND, parallel HTTP connection purely to parse metadata, and
// forwards titles to the renderer via IPC. Bandwidth overhead is just the
// audio of one extra stream, which is still cheap (~128 kbps average).
//
// HLS streams (.m3u8) don't use ICY metadata — they're segment-based and
// would need TS-level ID3 parsing or server-side metadata endpoints. Not
// handled here; the station name will be all the user sees for HLS.

import http from 'node:http';
import https from 'node:https';

const USER_AGENT = 'MusicPlayer/0.2 (ICY metadata sniffer)';

type Cb = (title: string | null) => void;

export class RadioMetadataSniffer {
  private request: http.ClientRequest | null = null;
  private stopped = false;
  private lastTitle: string | null = null;

  constructor(private readonly streamUrl: string, private readonly onTitle: Cb) {}

  start(): void {
    let u: URL;
    try { u = new URL(this.streamUrl); }
    catch { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;

    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        host: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: (u.pathname || '/') + (u.search || ''),
        headers: {
          'Icy-MetaData': '1',
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          // Some servers (Shoutcast v1) only send ICY when they see a browser-
          // ish UA. A generic UA works on everything tested.
          Connection: 'close',
        },
      },
      (res) => {
        const metaIntHeader = (res.headers['icy-metaint'] as string) || '';
        const metaInt = parseInt(metaIntHeader, 10);
        if (!metaInt || metaInt <= 0) {
          // Server doesn't support ICY metadata (common for public radio, some
          // HLS muxed-as-mp3 setups, etc.). Drop the sniff and save bandwidth.
          try { req.destroy(); } catch { /* noop */ }
          return;
        }

        let audioBytesRemaining = metaInt;
        let state: 'audio' | 'metalen' | 'meta' = 'audio';
        let metaLen = 0;
        let metaBuf = Buffer.alloc(0);

        res.on('data', (chunk: Buffer) => {
          if (this.stopped) return;
          let i = 0;
          while (i < chunk.length) {
            if (state === 'audio') {
              // Fast-forward past audio bytes without buffering them.
              const take = Math.min(audioBytesRemaining, chunk.length - i);
              i += take;
              audioBytesRemaining -= take;
              if (audioBytesRemaining === 0) state = 'metalen';
            } else if (state === 'metalen') {
              metaLen = chunk[i] * 16;
              i++;
              if (metaLen === 0) {
                audioBytesRemaining = metaInt;
                state = 'audio';
              } else {
                metaBuf = Buffer.alloc(0);
                state = 'meta';
              }
            } else { // 'meta'
              const needed = metaLen - metaBuf.length;
              const take = Math.min(needed, chunk.length - i);
              metaBuf = Buffer.concat([metaBuf, chunk.subarray(i, i + take)]);
              i += take;
              if (metaBuf.length >= metaLen) {
                this.parseMeta(metaBuf);
                audioBytesRemaining = metaInt;
                state = 'audio';
              }
            }
          }
        });

        res.on('error', () => { /* ignore — just stop emitting */ });
        res.on('end', () => { /* server closed — sniff is done */ });
      }
    );

    req.on('error', () => { /* network error on the sniff; playback continues in renderer */ });
    req.end();
    this.request = req;
  }

  stop(): void {
    this.stopped = true;
    if (this.request) {
      try { this.request.destroy(); } catch { /* noop */ }
      this.request = null;
    }
  }

  /**
   * Extract `StreamTitle='…'` from a raw metadata block. The string is null-
   * padded to a 16-byte boundary; trim trailing zeros before regex. Titles
   * can include escaped characters but in practice Shoutcast/Icecast just
   * break single quotes in titles — we accept that quirk rather than writing
   * a full tokenizer.
   */
  private parseMeta(buf: Buffer) {
    // Most streams are UTF-8 today; a few legacy ones are Latin-1. UTF-8
    // handles both reasonably when the title is ASCII (the common case).
    let s: string;
    try { s = buf.toString('utf8'); }
    catch { s = buf.toString('latin1'); }
    s = s.replace(/\0+$/, '').trim();
    const m = /StreamTitle='([\s\S]*?)';/.exec(s) || /StreamTitle='([\s\S]*)'/.exec(s);
    const title = (m?.[1] ?? '').trim() || null;
    if (title !== this.lastTitle) {
      this.lastTitle = title;
      this.onTitle(title);
    }
  }
}
