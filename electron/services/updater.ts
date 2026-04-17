import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { UpdateCheckResult } from '../../shared/types';
import { getSettings } from './settings-store';

const exec = promisify(execFile);

// Where this Electron process was started from — doubles as the project root
// in dev mode. In packaged builds the git repo isn't shipped, so updates via
// git pull just aren't applicable.
function projectRoot(): string {
  // app.getAppPath() returns the directory of package.json in dev; for packaged
  // builds it's inside app.asar (no git). Either way, that's where we operate.
  return app.getAppPath();
}

/** Current semver from package.json. */
async function readPkgVersion(): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(projectRoot(), 'package.json'), 'utf8');
    return JSON.parse(raw).version ?? '0.0.0';
  } catch { return '0.0.0'; }
}

/** Local HEAD commit SHA, or null if this isn't a git checkout. */
async function readLocalSha(): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: projectRoot() });
    return stdout.trim();
  } catch { return null; }
}

/** True if `git status --porcelain` has output — i.e. uncommitted changes. */
async function isDirty(): Promise<boolean> {
  try {
    const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: projectRoot() });
    return stdout.trim().length > 0;
  } catch { return false; }
}

/** Commits on `origin/branch` ahead of local HEAD (requires a fetch first). */
async function countCommitsBehind(branch: string): Promise<number | null> {
  try {
    const { stdout } = await exec('git', ['rev-list', '--count', `HEAD..origin/${branch}`], { cwd: projectRoot() });
    return Number(stdout.trim()) || 0;
  } catch { return null; }
}

/**
 * Check whether the `origin/branch` tip is newer than our HEAD.
 * Uses the public GitHub REST API so we don't need to shell out to `git
 * fetch` just to find out. (Packaged builds don't have git at all.)
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const settings = getSettings();
  const { repoSlug, branch } = settings.update;
  const upstreamUrl = `https://github.com/${repoSlug}`;

  const currentVersion = await readPkgVersion();
  const currentSha = await readLocalSha();
  const dirty = await isDirty();

  try {
    const r = await fetch(`https://api.github.com/repos/${repoSlug}/commits/${branch}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `MusicPlayer/${currentVersion}`,
      },
    });
    if (!r.ok) {
      return {
        upToDate: true,
        currentVersion, currentSha, latestSha: null,
        commitsBehind: null, latestMessage: null, latestDate: null,
        dirtyWorkingTree: dirty, error: `GitHub HTTP ${r.status}`, upstreamUrl,
      };
    }
    const json: any = await r.json();
    const latestSha: string | null = json?.sha ?? null;
    const latestMessage: string | null = json?.commit?.message?.split('\n', 1)[0] ?? null;
    const latestDate: string | null = json?.commit?.author?.date ?? null;

    // commitsBehind: if we can, count precisely using local git. Otherwise
    // fall back to 0/1 based on SHA equality.
    let commitsBehind: number | null = null;
    if (currentSha && latestSha) {
      if (currentSha === latestSha) {
        commitsBehind = 0;
      } else {
        try {
          await exec('git', ['fetch', '--quiet', 'origin', branch], { cwd: projectRoot() });
          commitsBehind = await countCommitsBehind(branch);
        } catch {
          commitsBehind = 1; // we know they differ, but can't count
        }
      }
    }

    const upToDate = currentSha != null && latestSha != null && currentSha === latestSha;
    return {
      upToDate, currentVersion, currentSha, latestSha,
      commitsBehind, latestMessage, latestDate,
      dirtyWorkingTree: dirty, error: null, upstreamUrl,
    };
  } catch (err: any) {
    return {
      upToDate: true,
      currentVersion, currentSha, latestSha: null,
      commitsBehind: null, latestMessage: null, latestDate: null,
      dirtyWorkingTree: dirty,
      error: err?.message ?? 'Network error',
      upstreamUrl,
    };
  }
}

export interface ApplyUpdateResult {
  ok: boolean;
  needsRestart: boolean;
  newSha: string | null;
  pulledCommits: number;
  message: string;
}

/**
 * Pull the latest from `origin/branch`. Uses `--ff-only` so local edits are
 * never overwritten — if the working tree is dirty or local has diverged,
 * the pull aborts with a clear message and the user can resolve manually.
 *
 * npm install is NOT run here — that's handled by run.bat / run.sh on the
 * next launch via the package.json mtime check.
 */
export async function applyUpdate(): Promise<ApplyUpdateResult> {
  const settings = getSettings();
  const { branch } = settings.update;
  const dirty = await isDirty();
  if (dirty) {
    return {
      ok: false, needsRestart: false, newSha: null, pulledCommits: 0,
      message: 'Working tree has uncommitted changes. Commit or stash them, then try again.',
    };
  }
  const beforeSha = await readLocalSha();
  try {
    await exec('git', ['fetch', 'origin', branch], { cwd: projectRoot() });
    await exec('git', ['pull', '--ff-only', 'origin', branch], { cwd: projectRoot() });
  } catch (err: any) {
    return {
      ok: false, needsRestart: false, newSha: null, pulledCommits: 0,
      message: `Pull failed: ${err?.stderr?.toString?.() ?? err?.message ?? err}`.trim(),
    };
  }
  const afterSha = await readLocalSha();
  let pulledCommits = 0;
  if (beforeSha && afterSha && beforeSha !== afterSha) {
    try {
      const { stdout } = await exec('git', ['rev-list', '--count', `${beforeSha}..${afterSha}`], { cwd: projectRoot() });
      pulledCommits = Number(stdout.trim()) || 0;
    } catch { /* leave as 0 */ }
  }
  return {
    ok: true,
    needsRestart: pulledCommits > 0,
    newSha: afterSha,
    pulledCommits,
    message: pulledCommits > 0
      ? `Pulled ${pulledCommits} new commit${pulledCommits === 1 ? '' : 's'}. Restart to load them.`
      : 'Already up to date.',
  };
}

export async function getUpdateInfo(): Promise<{ version: string; sha: string | null; dirty: boolean }> {
  return {
    version: await readPkgVersion(),
    sha: await readLocalSha(),
    dirty: await isDirty(),
  };
}
