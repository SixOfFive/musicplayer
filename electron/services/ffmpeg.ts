import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Mp3Quality } from '../../shared/types';

/**
 * Registry of every ffmpeg child we've spawned that's still alive.
 * Used at shutdown time to kill any in-progress conversions / tag
 * rewrites so the app's before-quit handler doesn't wait on (or
 * leak) a long-running encode. Each spawn adds to this set; each
 * close/error handler removes.
 */
const activeFfmpegChildren = new Set<ChildProcess>();

function trackChild(c: ChildProcess): void {
  activeFfmpegChildren.add(c);
  const untrack = () => activeFfmpegChildren.delete(c);
  c.once('close', untrack);
  c.once('error', untrack);
}

/**
 * Kill every ffmpeg child still running. Called from main's
 * before-quit so a pending FLAC→MP3 convert doesn't keep the
 * process alive (Electron doesn't auto-kill spawned children).
 * SIGTERM first, then SIGKILL after a short grace — ffmpeg
 * honours SIGTERM quickly when it's between frames.
 */
export function killAllActiveFfmpeg(): void {
  for (const c of activeFfmpegChildren) {
    try { c.kill('SIGTERM'); } catch { /* noop */ }
  }
  // Hard-kill anything still alive 300 ms later. Unref the timer
  // so it doesn't itself keep the event loop alive.
  const t = setTimeout(() => {
    for (const c of activeFfmpegChildren) {
      try { c.kill('SIGKILL'); } catch { /* noop */ }
    }
    activeFfmpegChildren.clear();
  }, 300);
  t.unref?.();
}

// Resolve the ffmpeg binary shipped with ffmpeg-static. The package exports
// a single string — the absolute path to the right binary for this platform.
// Lazily required so we don't crash at startup if the dep is missing.
//
// Packaged-build gotcha: require('ffmpeg-static') returns a path that
// points INSIDE app.asar — e.g. ".../resources/app.asar/node_modules/
// ffmpeg-static/ffmpeg.exe". Node's fs layer can read that via the asar
// VFS (so `fs.access(p, X_OK)` passes), but the OS can't execute it:
// `spawn()` will fail because there's no real file at that path. That's
// why Shrink + tag rewriting work in dev but silently fail in prod.
//
// Our package.json's asarUnpack already extracts the binary out to
// app.asar.unpacked/node_modules/ffmpeg-static/ — a real file on disk.
// We just have to rewrite the path ffmpeg-static returned so it points
// at that extracted copy rather than the in-asar virtual path.
let _ffmpegPath: string | null | undefined;
export function getFfmpegPath(): string | null {
  if (_ffmpegPath !== undefined) return _ffmpegPath;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require('ffmpeg-static');
    let resolved: string | null = (typeof p === 'string' ? p : p?.default) ?? null;
    if (resolved && resolved.includes('app.asar') && !resolved.includes('app.asar.unpacked')) {
      // `app.asar/...` → `app.asar.unpacked/...`. The guard above
      // already ruled out a path that's ALREADY been rewritten, so
      // a plain string replace is safe — no risk of doubling to
      // `app.asar.unpacked.unpacked`.
      resolved = resolved.replace('app.asar', 'app.asar.unpacked');
    }
    _ffmpegPath = resolved;
  } catch {
    _ffmpegPath = null;
  }
  return _ffmpegPath ?? null;
}

export async function isFfmpegAvailable(): Promise<boolean> {
  const p = getFfmpegPath();
  if (!p) return false;
  try {
    await fs.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function qualityArgs(q: Mp3Quality): string[] {
  switch (q) {
    case 'V0':     return ['-q:a', '0'];              // VBR ~245 kbps, archival
    case 'V2':     return ['-q:a', '2'];              // VBR ~190 kbps, still very good
    case 'CBR320': return ['-b:a', '320k'];           // Max constant bitrate
    case 'CBR256': return ['-b:a', '256k'];           // Middle ground
  }
}

export interface ConvertResult {
  ok: boolean;
  outPath: string;
  durationSec?: number;
  error?: string;
}

/**
 * Rewrite one or more metadata tags on a file WITHOUT re-encoding the
 * audio. Uses `ffmpeg -c copy` which muxes the existing compressed
 * stream into a new container with updated metadata — lossless, fast
 * (under a second for most files, even 50 MB FLACs), and format-
 * agnostic: ffmpeg picks the right underlying tag framework (ID3v2
 * for MP3, Vorbis comments for FLAC/Opus/OGG, iTunes atoms for
 * M4A/AAC, etc.) based on the container.
 *
 * Writes to a sibling `.tmp.<ext>` then atomically renames over the
 * original on success. On failure the .tmp is removed and the
 * original is untouched, so an ffmpeg crash mid-write can't corrupt
 * the file.
 *
 * SMB note: fs.rename across filesystems fails with EXDEV. We're
 * writing the tmp next to the original, so same filesystem — safe.
 * The Windows SMB client still occasionally throws EBUSY if the file
 * is open; caller should handle that by logging + skipping.
 */
export interface TagWriteResult {
  ok: boolean;
  error?: string;
}

export async function writeTags(
  filePath: string,
  tags: Record<string, string>,
): Promise<TagWriteResult> {
  const ff = getFfmpegPath();
  if (!ff) return { ok: false, error: 'ffmpeg binary not available' };

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  // Sibling tmp path so the rename is on the same filesystem (atomic).
  // Include a random suffix so two concurrent tag-writes on the same
  // file don't collide — rare, but the convert pipeline can run
  // alongside this in the background.
  const tmpPath = path.join(dir, `.${base}.tagtmp.${Date.now()}.${Math.floor(Math.random() * 1e6)}${ext}`);

  // -map_metadata 0 preserves ALL existing metadata from input (else
  // ffmpeg would drop every tag not explicitly listed in -metadata
  // args). Then our -metadata args overwrite the specific fields.
  // -c copy on both audio + video (cover art) streams so nothing
  // gets re-encoded. -map 0 includes every input stream in the
  // output (without this, ffmpeg drops cover-art PNG streams on some
  // containers).
  const args: string[] = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', filePath,
    '-map', '0',
    '-map_metadata', '0',
    '-c', 'copy',
  ];
  for (const [k, v] of Object.entries(tags)) {
    args.push('-metadata', `${k}=${v}`);
  }
  args.push(tmpPath);

  return new Promise((resolve) => {
    const child = spawn(ff, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    trackChild(child);
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', async (err) => {
      try { await fs.unlink(tmpPath); } catch { /* noop */ }
      resolve({ ok: false, error: `ffmpeg spawn failed: ${err.message}` });
    });
    child.on('close', async (code) => {
      if (code !== 0) {
        try { await fs.unlink(tmpPath); } catch { /* noop */ }
        resolve({ ok: false, error: `ffmpeg exit ${code}: ${stderr.slice(-400)}` });
        return;
      }
      // Replace the original. fs.rename is atomic on the same filesystem.
      try {
        await fs.rename(tmpPath, filePath);
        resolve({ ok: true });
      } catch (err: any) {
        // Last-ditch cleanup so a failed rename doesn't litter tmp files.
        try { await fs.unlink(tmpPath); } catch { /* noop */ }
        resolve({ ok: false, error: `rename failed: ${err?.message ?? err}` });
      }
    });
  });
}

/**
 * Convert a single audio file to MP3 using libmp3lame.
 * Preserves metadata tags and embedded cover art.
 *
 * Cancel via the AbortSignal — ffmpeg gets SIGKILL and the partial file is removed.
 */
export function convertToMp3(
  inputPath: string,
  outputPath: string,
  quality: Mp3Quality,
  signal?: AbortSignal,
  onProgress?: (percent: number) => void,
): Promise<ConvertResult> {
  return new Promise(async (resolve) => {
    const ff = getFfmpegPath();
    if (!ff) {
      resolve({ ok: false, outPath: outputPath, error: 'ffmpeg binary not available' });
      return;
    }

    // Build args. Notes:
    //  -y            : overwrite if output already exists (shouldn't normally)
    //  -i <input>    : source file
    //  -vn isn't used because we *want* the cover art video stream mapped through.
    //  -map 0:a      : audio stream(s)
    //  -map 0:v?     : optional cover art stream (? = no error if missing)
    //  -c:v copy     : don't re-encode embedded art
    //  -codec:a libmp3lame : use LAME for MP3 encoding
    //  -q:a / -b:a   : quality preset
    //  -id3v2_version 3 : write ID3v2.3 tags (broadest compatibility)
    //  -map_metadata 0 : copy all metadata from source
    //  -progress pipe:2 : stream progress key=value lines to stderr we can parse
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-map', '0:a',
      '-map', '0:v?',
      '-c:v', 'copy',
      '-codec:a', 'libmp3lame',
      ...qualityArgs(quality),
      '-id3v2_version', '3',
      '-map_metadata', '0',
      '-progress', 'pipe:2',
      outputPath,
    ];

    let stderr = '';
    let durationSec: number | null = null;
    let childKilled = false;

    const child = spawn(ff, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    trackChild(child);

    if (signal) {
      if (signal.aborted) {
        child.kill('SIGKILL');
        childKilled = true;
      } else {
        signal.addEventListener('abort', () => { child.kill('SIGKILL'); childKilled = true; });
      }
    }

    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString();
      stderr += text;
      if (onProgress) {
        // ffmpeg -progress emits `out_time_us=12345678\n` periodically.
        const m = /out_time_us=(\d+)/.exec(text);
        if (m && durationSec) {
          const elapsedSec = Number(m[1]) / 1e6;
          onProgress(Math.min(100, (elapsedSec / durationSec) * 100));
        }
        const dm = /Duration: (\d+):(\d+):(\d+)\.(\d+)/.exec(stderr);
        if (!durationSec && dm) {
          durationSec = +dm[1] * 3600 + +dm[2] * 60 + +dm[3] + +dm[4] / 100;
        }
      }
    });

    child.on('error', (err) => {
      resolve({ ok: false, outPath: outputPath, error: err.message });
    });

    child.on('close', async (code) => {
      if (childKilled) {
        try { await fs.unlink(outputPath); } catch { /* ignore */ }
        resolve({ ok: false, outPath: outputPath, error: 'cancelled' });
        return;
      }
      if (code !== 0) {
        try { await fs.unlink(outputPath); } catch { /* ignore */ }
        resolve({ ok: false, outPath: outputPath, error: `ffmpeg exit ${code}: ${stderr.slice(-400)}` });
        return;
      }
      resolve({ ok: true, outPath: outputPath, durationSec: durationSec ?? undefined });
    });
  });
}

export function mp3PathFor(input: string): string {
  const dir = path.dirname(input);
  const base = path.basename(input, path.extname(input));
  return path.join(dir, `${base}.mp3`);
}
