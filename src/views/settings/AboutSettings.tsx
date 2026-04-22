import { useEffect, useState } from 'react';
import type { AppSettings, UpdateCheckResult } from '../../../shared/types';

export default function AboutSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<{ version: string; sha: string | null; dirty: boolean } | null>(null);
  const [check, setCheck] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setSettings(await window.mp.settings.get());
      setInfo(await window.mp.update.info());
    })();
  }, []);

  async function patch(p: Partial<AppSettings['update']>) {
    const next = await window.mp.settings.set({ update: p } as any);
    setSettings(next as AppSettings);
  }

  async function runCheck() {
    setChecking(true);
    setApplyResult(null);
    setCheck(await window.mp.update.check());
    setChecking(false);
  }

  async function apply() {
    setApplying(true);
    const r: any = await window.mp.update.apply();
    setApplying(false);
    setApplyResult(r.message);
    if (r.ok) setCheck(await window.mp.update.check());
  }

  if (!settings || !info) return <div className="text-text-muted">Loading…</div>;
  const u = settings.update;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold mb-1">About</h2>
        <div className="bg-bg-elev-2 rounded p-4 space-y-2 text-sm">
          <div><span className="text-text-muted">Version:</span> <span className="font-mono">{info.version}</span></div>
          <div>
            <span className="text-text-muted">Commit:</span>{' '}
            <span className="font-mono">{info.sha ? info.sha.slice(0, 10) : 'not a git checkout'}</span>
            {info.dirty && <span className="ml-2 text-yellow-400 text-xs">(local changes)</span>}
          </div>
          <div><span className="text-text-muted">Upstream:</span>{' '}
            <a
              onClick={() => window.open(`https://github.com/${u.repoSlug}`, '_blank')}
              className="text-accent hover:underline cursor-pointer"
            >github.com/{u.repoSlug}</a>
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-1">Updates</h2>
        <div className="bg-bg-elev-2 rounded p-4 space-y-3 text-sm">
          <label className="flex items-start gap-2">
            <input
              type="checkbox" className="mt-1" checked={u.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            <span>
              <span className="font-medium">Enable update checking</span>
              <p className="text-xs text-text-muted mt-0.5">Off = no banners, no automatic checks. Manual check still works.</p>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox" className="mt-1" checked={u.checkOnStartup} disabled={!u.enabled}
              onChange={(e) => patch({ checkOnStartup: e.target.checked })}
            />
            <span>
              <span className="font-medium">Check on every startup</span>
              <p className="text-xs text-text-muted mt-0.5">Also re-checks every 30 minutes while the app is open.</p>
            </span>
          </label>

          <div className="flex items-center gap-3 mb-1">
            <label className="w-20 text-text-muted text-xs">Repo</label>
            <input
              value={u.repoSlug}
              onChange={(e) => setSettings({ ...settings, update: { ...u, repoSlug: e.target.value } })}
              onBlur={() => patch({ repoSlug: u.repoSlug })}
              className="flex-1 bg-bg-base px-2 py-1 rounded font-mono text-xs"
              placeholder="owner/repo"
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="w-20 text-text-muted text-xs">Branch</label>
            <input
              value={u.branch}
              onChange={(e) => setSettings({ ...settings, update: { ...u, branch: e.target.value } })}
              onBlur={() => patch({ branch: u.branch })}
              className="w-48 bg-bg-base px-2 py-1 rounded font-mono text-xs"
              placeholder="main"
            />
          </div>

          <div className="pt-3 border-t border-white/5 flex items-center gap-3">
            <button
              onClick={runCheck}
              disabled={checking}
              className="bg-white/10 hover:bg-white/20 disabled:opacity-50 px-4 py-1.5 rounded-full text-sm inline-flex items-center gap-2"
            >
              {checking && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              Check now
            </button>
            {check && !check.error && (check.upToDate ? (
              <span className="text-accent">✓ Up to date.</span>
            ) : (
              <span className="text-yellow-400">
                Update available{check.commitsBehind != null ? ` (${check.commitsBehind} commit${check.commitsBehind === 1 ? '' : 's'} behind)` : ''}
              </span>
            ))}
            {check?.error && <span className="text-red-400">{check.error}</span>}
          </div>

          {check && !check.upToDate && !check.error && (
            <div className="bg-bg-base rounded p-3 text-xs space-y-1">
              <div><span className="text-text-muted">Latest:</span> <span className="font-mono">{check.latestSha?.slice(0, 10)}</span></div>
              {check.latestMessage && <div><span className="text-text-muted">Message:</span> {check.latestMessage}</div>}
              {check.latestDate && <div><span className="text-text-muted">Date:</span> {new Date(check.latestDate).toLocaleString()}</div>}
              <div className="pt-2 flex items-center gap-3">
                {!applyResult && (
                  <button
                    onClick={apply}
                    disabled={applying}
                    className="bg-accent hover:bg-accent-hover disabled:opacity-50 text-black font-semibold px-4 py-1.5 rounded-full inline-flex items-center gap-2"
                    title="Fetch + reset to origin (auto-stashes any local changes first)"
                  >
                    {applying && <span className="w-3 h-3 border-2 border-black border-t-transparent rounded-full animate-spin" />}
                    {applying ? 'Updating…' : 'Update now'}
                  </button>
                )}
                {applyResult && (
                  <>
                    <span className="text-accent">{applyResult}</span>
                    <button onClick={() => location.reload()} className="bg-accent text-black px-3 py-1 rounded-full text-xs font-semibold">Reload</button>
                  </>
                )}
                {/* Local changes are no longer a blocker — the backend auto-stashes them
                    with `git stash push -u` before the hard-reset. Shown as info, not a warning. */}
                {check.dirtyWorkingTree && !applyResult && (
                  <span className="text-xs text-text-muted">(local changes will be auto-stashed)</span>
                )}
              </div>
            </div>
          )}

          <p className="text-xs text-text-muted">
            Update applies via <code className="font-mono">git fetch</code> + <code className="font-mono">git reset --hard origin/&lt;branch&gt;</code>.
            Any local edits are auto-stashed first (<code className="font-mono">git stash push -u</code> with a timestamped message),
            so clicking "Update now" will <em>always</em> proceed — nothing gets lost, and you can recover stashed edits with <code className="font-mono">git stash list</code> afterwards.
            Native dependencies (like <code className="font-mono">better-sqlite3</code>) are re-linked automatically by <code className="font-mono">run.bat</code> / <code className="font-mono">run.sh</code> the next time the app launches — they detect that <code className="font-mono">package.json</code> changed.
          </p>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-1">Debug</h2>
        <div className="bg-bg-elev-2 rounded p-4 space-y-3 text-sm">
          <label className="flex items-start gap-2">
            <input
              type="checkbox" className="mt-1"
              checked={!!settings.debug?.openDevToolsOnStartup}
              onChange={async (e) => {
                const next = await window.mp.settings.set({ debug: { openDevToolsOnStartup: e.target.checked } } as any);
                setSettings(next as AppSettings);
              }}
            />
            <span>
              <span className="font-medium">Open DevTools on startup</span>
              <p className="text-xs text-text-muted mt-0.5">Off by default. When on, the Chromium inspector pops out as a separate window every launch.</p>
            </span>
          </label>

          <label className="flex items-start gap-2">
            <input
              type="checkbox" className="mt-1"
              checked={!!settings.debug?.logRendererToMain}
              onChange={async (e) => {
                const next = await window.mp.settings.set({ debug: { logRendererToMain: e.target.checked } } as any);
                setSettings(next as AppSettings);
              }}
            />
            <span>
              <span className="font-medium">Mirror renderer console to terminal</span>
              <p className="text-xs text-text-muted mt-0.5">Forwards every <code className="font-mono">console.log</code> / <code className="font-mono">console.error</code> from the UI into the <code className="font-mono">npm run electron:dev</code> output. Noisy — only useful when diagnosing.</p>
            </span>
          </label>

          <div className="pt-2 border-t border-white/5">
            <button
              onClick={() => window.mp.debug.toggleDevTools()}
              className="bg-white/10 hover:bg-white/20 px-4 py-1.5 rounded-full text-sm"
              title="Open or close DevTools right now without changing the startup setting"
            >Toggle DevTools now</button>
            <span className="ml-3 text-xs text-text-muted">Keyboard: <code className="font-mono">F12</code> works in dev builds as well.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
