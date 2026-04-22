import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { UpdateCheckResult } from '../../shared/types';
import { getSettings } from './settings-store';

const exec = promisify(execFile);

/**
 * True when the app was packaged by electron-builder (installer/.exe build).
 * In packaged builds we use electron-updater to download + apply a new
 * installer from GitHub Releases. In dev / source-cloned builds we use
 * `git pull --ff-only` against the project directory.
 */
function isPackaged(): boolean { return app.isPackaged; }

// ---- electron-updater integration (packaged builds only) -------------------
// Loaded lazily so a missing dep doesn't break `npm run electron:dev` during
// development (in dev mode isPackaged() returns false so we never reach this).
let _autoUpdater: typeof import('electron-updater').autoUpdater | null = null;
let autoUpdaterInitialised = false;
let mainWindowGetter: () => BrowserWindow | null = () => null;

export function setAutoUpdaterWindow(getter: () => BrowserWindow | null) {
  mainWindowGetter = getter;
}

async function getAutoUpdater() {
  if (_autoUpdater) return _autoUpdater;
  const mod = await import('electron-updater');
  _autoUpdater = mod.autoUpdater;
  if (!autoUpdaterInitialised) {
    autoUpdaterInitialised = true;
    // Pipe electron-updater's internal events to the renderer so the banner
    // can show download progress + "ready to install" UI.
    const emit = (channel: string, payload?: unknown) =>
      mainWindowGetter()?.webContents.send(channel, payload);
    _autoUpdater.autoDownload = true;           // start download as soon as update is detected
    _autoUpdater.autoInstallOnAppQuit = true;   // apply the update when the user next quits
    _autoUpdater.on('checking-for-update', () => emit('update:auto-event', { kind: 'checking' }));
    _autoUpdater.on('update-available', (info) => emit('update:auto-event', { kind: 'available', info }));
    _autoUpdater.on('update-not-available', (info) => emit('update:auto-event', { kind: 'none', info }));
    _autoUpdater.on('error', (err) => emit('update:auto-event', { kind: 'error', message: err?.message ?? String(err) }));
    _autoUpdater.on('download-progress', (p) => emit('update:auto-event', { kind: 'progress', percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond }));
    _autoUpdater.on('update-downloaded', (info) => emit('update:auto-event', { kind: 'downloaded', info }));
  }
  return _autoUpdater;
}

// Where this Electron process was started from — doubles as the project root
// in dev mode. In packaged builds the git repo isn't shipped, so updates via
// git pull just aren't applicable.
function projectRoot(): string {
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

  // Packaged path: let electron-updater consult GitHub Releases directly.
  // It compares the version in our package.json with the latest release tag
  // and, if newer, starts the download (autoDownload = true).
  if (isPackaged()) {
    try {
      const updater = await getAutoUpdater();
      const res: any = await updater.checkForUpdates();
      const info = res?.updateInfo;
      const latestVer = info?.version ?? null;
      const upToDate = !latestVer || latestVer === currentVersion;
      return {
        upToDate,
        currentVersion,
        currentSha,
        latestSha: null,
        commitsBehind: upToDate ? 0 : null,
        latestMessage: info?.releaseName ?? info?.releaseNotes ?? null,
        latestDate: info?.releaseDate ?? null,
        dirtyWorkingTree: false,
        error: null,
        upstreamUrl,
      };
    } catch (err: any) {
      return {
        upToDate: true,
        currentVersion, currentSha, latestSha: null,
        commitsBehind: null, latestMessage: null, latestDate: null,
        dirtyWorkingTree: false,
        error: err?.message ?? 'electron-updater error',
        upstreamUrl,
      };
    }
  }

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
  // True when the updater ran `npm install` because package.json changed
  // during the pull. The banner can show this so the user understands why
  // the update took a minute instead of a couple of seconds.
  ranNpmInstall?: boolean;
}

/**
 * Did the `git pull` from `beforeSha` to `afterSha` touch package.json or
 * package-lock.json? If so, node_modules is stale and we need to run
 * `npm install` before restarting — otherwise the next launch will crash
 * on a missing dependency (exactly the hls.js case that bit v0.2.2).
 */
async function dependencyManifestsChanged(beforeSha: string, afterSha: string): Promise<boolean> {
  try {
    const { stdout } = await exec('git', ['diff', '--name-only', `${beforeSha}..${afterSha}`], { cwd: projectRoot() });
    const files = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    return files.some((f) => f === 'package.json' || f === 'package-lock.json');
  } catch {
    // If we can't determine the diff, be cautious and assume YES — running
    // `npm install` unnecessarily takes a few seconds; skipping it when
    // it's needed leaves the app broken.
    return true;
  }
}

/**
 * Pull the latest from `origin/branch`. Uses `--ff-only` so local edits are
 * never overwritten — if the working tree is dirty or local has diverged,
 * the pull aborts with a clear message and the user can resolve manually.
 *
 * npm install is NOT run here — that's handled by run.bat / run.sh on the
 * next launch via the package.json mtime check.
 *
 * In packaged builds this function refuses to run — the user needs to
 * download a new installer from GitHub Releases instead.
 */
export async function applyUpdate(): Promise<ApplyUpdateResult> {
  if (isPackaged()) {
    // Packaged path: electron-updater downloaded the new installer in the
    // background the moment `checkForUpdates()` ran (autoDownload = true in
    // getAutoUpdater). Calling `quitAndInstall()` closes the window, runs
    // the NSIS installer silently, and restarts the app on the new version.
    try {
      const updater = await getAutoUpdater();
      // `isUpdaterActive` is `true` only in packaged builds with a valid
      // publish config — guards against misconfig in dev-like scenarios.
      if (!updater.isUpdaterActive()) {
        return {
          ok: false, needsRestart: false, newSha: null, pulledCommits: 0,
          message: 'Auto-updater is not available in this build.',
        };
      }
      // setImmediate so this IPC handler can return before the app quits.
      // Args: (isSilent, isForceRunAfter).
      //   isSilent=true — run the NSIS installer without the UI wizard, so
      //     there's no window for Windows to steal focus from, no "click
      //     next" prompts, no race where the user's click happens while a
      //     file is still held by the exiting process. With `oneClick: true`
      //     in package.json's nsis config this is what the updater wants
      //     anyway; explicit is safer than relying on the default.
      //   isForceRunAfter=true — the installer launches the new version
      //     as the last step. Without this, a silent install just exits
      //     and the user sees the app disappear with no indication it
      //     upgraded.
      setImmediate(() => updater.quitAndInstall(true, true));
      return {
        ok: true, needsRestart: true, newSha: null, pulledCommits: 1,
        message: 'Installing update and restarting…',
      };
    } catch (err: any) {
      return {
        ok: false, needsRestart: false, newSha: null, pulledCommits: 0,
        message: `Auto-update failed: ${err?.message ?? err}`,
      };
    }
  }
  const settings = getSettings();
  const { branch } = settings.update;

  // The old code refused to update when the working tree was dirty,
  // which meant a user running from source could get stuck if the
  // app itself (or a package-lock churn from `npm install` during a
  // prior update, or a build artifact escaping .gitignore) wrote
  // into the tree. User asked for unconditional override: clicking
  // "Update" means "bring me to origin, discard whatever's in the
  // way."
  //
  // Safety net: before the reset, stash any dirty state (including
  // untracked files with `-u`) with a timestamped message. If nothing
  // is dirty, `git stash push` exits non-zero and we ignore — the
  // reset below is harmless on a clean tree. If something WAS
  // stashed, the user can recover with `git stash list` + `git
  // stash pop` from the project directory.
  const dirty = await isDirty();
  if (dirty) {
    process.stdout.write('[updater] working tree dirty — stashing before reset\n');
    try {
      await exec('git', ['stash', 'push', '-u', '-m', `auto-stash from updater ${new Date().toISOString()}`], { cwd: projectRoot() });
    } catch { /* nothing to stash, or stash disabled — proceed to reset anyway */ }
  }

  const beforeSha = await readLocalSha();
  try {
    // Fetch first, then hard-reset to origin's tip. `git reset --hard
    // origin/<branch>` replaces the `git pull --ff-only` that refused
    // on a dirty tree — this version rewrites tracked files to
    // match origin verbatim, leaves untracked files alone, and
    // never fails on local modifications.
    await exec('git', ['fetch', 'origin', branch], { cwd: projectRoot() });
    await exec('git', ['reset', '--hard', `origin/${branch}`], { cwd: projectRoot() });
  } catch (err: any) {
    return {
      ok: false, needsRestart: false, newSha: null, pulledCommits: 0,
      message: `Update failed: ${err?.stderr?.toString?.() ?? err?.message ?? err}`.trim(),
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

  // If package.json / package-lock.json changed in this pull, run npm install
  // before returning — otherwise the next launch will fail to resolve any
  // newly-added dependency (e.g. hls.js added in v0.2.2). We rely on `exec`
  // with a generous timeout; the user sees the banner spinner until this
  // completes. Never block RESTART on install failure — better to launch
  // with a warning than leave the app completely broken.
  let ranNpmInstall = false;
  if (beforeSha && afterSha && beforeSha !== afterSha) {
    const needsInstall = await dependencyManifestsChanged(beforeSha, afterSha);
    if (needsInstall) {
      console.log('[updater] package.json changed — running npm install');
      try {
        // Windows: node/execFile can't run `.cmd` shims without help —
        // npm on Windows is installed as `npm.cmd`. Everywhere else it's
        // a plain executable.
        const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        await exec(npmBin, ['install', '--no-audit', '--no-fund'], {
          cwd: projectRoot(),
          // 5-minute ceiling — npm install on a cold cache can take a while,
          // especially when native deps rebuild against Electron's ABI.
          timeout: 5 * 60 * 1000,
          maxBuffer: 32 * 1024 * 1024,
          // Inherit PATH so `npm` is findable on Windows/Linux/macOS.
          env: process.env,
        });
        ranNpmInstall = true;
        console.log('[updater] npm install finished cleanly');
      } catch (err: any) {
        console.error('[updater] npm install FAILED', err?.message ?? err);
        return {
          ok: false,
          needsRestart: false,
          newSha: afterSha,
          pulledCommits,
          message: `Code was pulled but \`npm install\` failed: ${err?.message ?? err}. Run it manually from the project directory.`,
          ranNpmInstall: false,
        };
      }
    }
  }

  return {
    ok: true,
    needsRestart: pulledCommits > 0,
    newSha: afterSha,
    pulledCommits,
    ranNpmInstall,
    message: pulledCommits > 0
      ? (ranNpmInstall
          ? `Pulled ${pulledCommits} new commit${pulledCommits === 1 ? '' : 's'} and installed new dependencies. Restart to load them.`
          : `Pulled ${pulledCommits} new commit${pulledCommits === 1 ? '' : 's'}. Restart to load them.`)
      : 'Already up to date.',
  };
}

export async function getUpdateInfo(): Promise<{ version: string; sha: string | null; dirty: boolean; packaged: boolean }> {
  return {
    version: await readPkgVersion(),
    sha: await readLocalSha(),
    dirty: await isDirty(),
    packaged: isPackaged(),
  };
}
