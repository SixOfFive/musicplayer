// Filesystem helpers that work around OS-level name-resolution quirks on
// edge-case filenames (trailing dots, case drift) across Windows + SMB
// shares. Factored out so both the mp-media protocol handler (playback)
// and the FLAC→MP3 convert pipeline can use the same resolver.
//
// Background: the user's library contains tracks with titles ending in a
// period ("Yippee-Ki-Yay.", "Joyride."), producing filenames with two
// consecutive dots before the extension ("Yippee-Ki-Yay..flac"). On a
// freshly-mounted SMB share, fs.stat against these paths succeeds. After
// the share has been exercised, the Windows SMB client's name-resolution
// cache desyncs with Win32 path canonicalization (which strips trailing
// dots) and fs.stat starts returning ENOENT intermittently even though
// the file is still physically present. readdir doesn't suffer from the
// same caching because it enumerates rather than looks up by exact name.

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve a filesystem path, falling back to a parent-directory listing
 * on ENOENT. Returns the actual on-disk path (which may differ from
 * `requested` in case or dot-normalization) plus its stat.
 *
 * Tried in order:
 *   1. Exact match — shouldn't reach here (stat already missed) but
 *      harmless if it does.
 *   2. Case-insensitive match — SMB shares sometimes report case
 *      differently than how the DB stored it during scan.
 *   3. Dot-normalized match on the basename's stem — strips trailing
 *      dots from the part before the final extension. Catches
 *      "Joyride..flac" ↔ "Joyride.flac" in either direction.
 *
 * Throws the original ENOENT if none of the tiers match. Other errors
 * (EACCES, ENOTDIR, etc.) propagate unchanged.
 */
export async function statWithFallback(requested: string): Promise<{ path: string; stat: import('node:fs').Stats }> {
  try {
    const st = await fs.stat(requested);
    return { path: requested, stat: st };
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;

    const dir = path.dirname(requested);
    const targetName = path.basename(requested);
    let entries: string[];
    try { entries = await fs.readdir(dir); }
    catch { throw err; /* folder itself unreachable — surface original ENOENT */ }

    let hit = entries.find((e) => e === targetName);
    if (!hit) hit = entries.find((e) => e.toLowerCase() === targetName.toLowerCase());
    if (!hit) {
      const normalize = (name: string) => {
        const ext = path.extname(name);
        const stem = ext ? name.slice(0, -ext.length) : name;
        return (stem.replace(/\.+$/, '') + ext).toLowerCase();
      };
      const normalizedTarget = normalize(targetName);
      hit = entries.find((e) => normalize(e) === normalizedTarget);
    }
    if (!hit) throw err;

    const resolved = path.join(dir, hit);
    const st = await fs.stat(resolved);
    // Log at the shared helper so we can see resolution happening regardless
    // of which subsystem triggered it (playback, convert, etc.).
    process.stdout.write(`[fs-fallback] resolved "${targetName}" → "${hit}" in ${dir}\n`);
    return { path: resolved, stat: st };
  }
}

/**
 * Like `statWithFallback` but returns just the resolved path string, for
 * callers that don't need the stat (e.g. feeding ffmpeg). Returns the
 * original path on ENOENT with no fallback match — caller decides what to
 * do with that (skip, error, etc.).
 */
export async function resolveExistingPath(requested: string): Promise<string> {
  try {
    const r = await statWithFallback(requested);
    return r.path;
  } catch {
    return requested;
  }
}
