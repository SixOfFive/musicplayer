import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Mp3Quality } from '../../shared/types';

// Resolve the ffmpeg binary shipped with ffmpeg-static. The package exports
// a single string — the absolute path to the right binary for this platform.
// Lazily required so we don't crash at startup if the dep is missing.
let _ffmpegPath: string | null | undefined;
export function getFfmpegPath(): string | null {
  if (_ffmpegPath !== undefined) return _ffmpegPath;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require('ffmpeg-static');
    _ffmpegPath = (typeof p === 'string' ? p : p?.default) ?? null;
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
