/**
 * Library health + auto-cleanup safeguards.
 *
 * The DB thinks certain files exist at certain paths. Reality diverges
 * over time: users re-encode albums on another machine, delete files,
 * rename folders, or remount shares that are temporarily empty. This
 * service gives the rest of the app a few cheap primitives to react
 * to that without accidentally nuking the library when a mount just
 * happens to be down.
 *
 * Key invariant: every auto-cleanup path consults `isLibraryDirHealthy()`
 * first. If the library dir containing the track is unreachable or
 * empty, we refuse to delete DB rows — the user's files may still
 * exist, we just can't see them right now. Genuine deletions survive
 * the next successful probe once the mount's back.
 *
 * Session-wide suspect flag: set by main at startup if the initial
 * probe found ANY library dir missing/empty and the user picked
 * "Continue anyway" in the dialog. While the flag is on, no auto-
 * cleanup runs at all — the user is operating in a degraded state
 * deliberately, don't punish them for it by erasing metadata.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getSettings } from './settings-store';

export interface LibraryDirHealth {
  path: string;
  /** Root directory exists and is reachable. */
  exists: boolean;
  /** Root directory has any child entries (files or subdirs). An
   *  empty root nearly always means a mount got replaced with a
   *  blank target — e.g. SMB share reconnecting to a stale mount
   *  point. We treat empty == unhealthy to err on safety. */
  nonEmpty: boolean;
}

/** True if the startup check found any problem and the user chose to
 *  continue anyway. All auto-cleanup is disabled for this session. */
let librarySuspect = false;

export function setLibrarySuspect(v: boolean): void { librarySuspect = v; }
export function isLibrarySuspect(): boolean { return librarySuspect; }

/**
 * Probe a single library directory for existence + non-emptiness.
 * Never throws — unreachable = {exists:false, nonEmpty:false}.
 *
 * `readdir` gives us content check in the same round-trip the shell
 * would make to list the mount point; no separate stat-per-child.
 */
export async function probeLibraryDir(dirPath: string): Promise<LibraryDirHealth> {
  try {
    const st = await fs.stat(dirPath);
    if (!st.isDirectory()) return { path: dirPath, exists: false, nonEmpty: false };
  } catch {
    return { path: dirPath, exists: false, nonEmpty: false };
  }
  try {
    const entries = await fs.readdir(dirPath);
    return { path: dirPath, exists: true, nonEmpty: entries.length > 0 };
  } catch {
    // Permission error on the root is effectively unhealthy — we can't
    // see anything, so we can't safely make "file is gone" claims.
    return { path: dirPath, exists: true, nonEmpty: false };
  }
}

/**
 * Probe every enabled library dir from settings. Returns one health
 * entry per dir in settings order. Disabled dirs are skipped; the
 * caller only needs to react to the dirs that would be scanned.
 */
export async function probeAllLibraryDirs(): Promise<LibraryDirHealth[]> {
  const dirs = getSettings().library?.directories ?? [];
  const enabled = dirs.filter((d) => d.enabled);
  return Promise.all(enabled.map((d) => probeLibraryDir(d.path)));
}

/**
 * Case-insensitive on Windows, case-sensitive on POSIX — matches how
 * the filesystem actually resolves paths. Normalize both sides so
 * `M:\music\foo\bar.flac` lines up with `M:\music` regardless of
 * slash direction or trailing separators.
 */
export function findContainingLibraryDir(trackPath: string): string | null {
  const dirs = getSettings().library?.directories ?? [];
  const needle = path.normalize(trackPath);
  const needleLower = process.platform === 'win32' ? needle.toLowerCase() : needle;
  for (const d of dirs) {
    const hay = path.normalize(d.path);
    const hayLower = process.platform === 'win32' ? hay.toLowerCase() : hay;
    // Exact-prefix match, but only on a directory boundary — avoids
    // `M:\music` matching a sibling `M:\music-backup`.
    if (needleLower === hayLower) return d.path;
    if (needleLower.startsWith(hayLower + path.sep)) return d.path;
    // Windows: also accept forward slashes, though path.normalize
    // should have handled that.
    if (process.platform === 'win32' && needleLower.startsWith(hayLower + '/')) return d.path;
  }
  return null;
}

/**
 * Quick health check for the library dir containing a specific track.
 * Used as the gate in front of any auto-cleanup: callers probe this
 * before deleting a track row so a transient mount failure can't cost
 * the user their whole collection's metadata.
 *
 * Returns TRUE only when:
 *   - session-wide suspect flag is off, AND
 *   - the containing library dir exists AND is non-empty.
 *
 * Returns FALSE when:
 *   - suspect flag is on
 *   - the containing dir is missing, empty, or inaccessible
 *   - the track's path doesn't fall under any library dir (unknown
 *     location — refuse to reason about it; caller should just leave
 *     the row alone)
 */
export async function isTrackLibraryDirHealthy(trackPath: string): Promise<boolean> {
  if (librarySuspect) return false;
  const dir = findContainingLibraryDir(trackPath);
  if (!dir) return false;
  const h = await probeLibraryDir(dir);
  return h.exists && h.nonEmpty;
}
