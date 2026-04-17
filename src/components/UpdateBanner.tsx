import { useEffect, useRef, useState } from 'react';
import type { UpdateCheckResult } from '../../shared/types';

/**
 * Thin banner at the top of the app that appears when a newer commit is
 * available on the upstream branch. Clickable:
 *   - "Update now"  → git pull --ff-only, then offers to restart
 *   - "Dismiss"     → hides for this session
 *
 * Auto-checks on mount (if setting enabled) and every 30 minutes while open.
 */
export default function UpdateBanner() {
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await window.mp.settings.get();
        const u = s.update ?? { enabled: true, checkOnStartup: true };
        if (!u.enabled) { setEnabled(false); return; }
        if (u.checkOnStartup) await runCheck();
      } catch { /* ignore */ }
    })();
    pollRef.current = setInterval(runCheck, 30 * 60 * 1000);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
      void cancelled;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runCheck() {
    const r: UpdateCheckResult = await window.mp.update.check();
    setResult(r);
  }

  async function apply() {
    setBusy(true);
    const r: any = await window.mp.update.apply();
    setBusy(false);
    setApplied(r.message);
    if (r.ok) await runCheck();
  }

  if (!enabled) return null;
  if (!result) return null;
  if (dismissed) return null;
  if (result.upToDate) return null;
  if (result.error) return null; // don't nag on transient GH API errors

  const headline =
    result.commitsBehind != null
      ? `Update available — ${result.commitsBehind} new commit${result.commitsBehind === 1 ? '' : 's'} on ${result.upstreamUrl.split('/').slice(-2).join('/')}`
      : `Update available on ${result.upstreamUrl.split('/').slice(-2).join('/')}`;

  return (
    <div className="bg-yellow-500/20 border-b border-yellow-500/40 px-4 py-2 flex items-center gap-3 text-xs">
      <span className="text-yellow-200 font-semibold">⤴ {headline}</span>
      {result.latestMessage && (
        <span className="text-text-muted truncate flex-1">— {result.latestMessage}</span>
      )}
      {result.dirtyWorkingTree && (
        <span className="text-red-300" title="Local edits prevent an auto-update">(local changes present)</span>
      )}
      {!applied ? (
        <>
          <button
            onClick={apply}
            disabled={busy || result.dirtyWorkingTree}
            className="px-3 py-1 rounded-full bg-yellow-500 hover:bg-yellow-400 disabled:opacity-50 text-black font-semibold"
            title={result.dirtyWorkingTree ? 'Commit or stash local changes first' : 'Run git pull and restart'}
          >{busy ? 'Updating…' : 'Update now'}</button>
          <button
            onClick={() => window.open(result.upstreamUrl, '_blank')}
            className="text-text-muted hover:text-white"
          >View on GitHub</button>
          <button onClick={() => setDismissed(true)} className="text-text-muted hover:text-white">✕</button>
        </>
      ) : (
        <>
          <span className="text-accent">{applied}</span>
          <button
            onClick={() => location.reload()}
            className="px-3 py-1 rounded-full bg-accent text-black font-semibold"
          >Reload now</button>
          <button onClick={() => setDismissed(true)} className="text-text-muted hover:text-white">Later</button>
        </>
      )}
    </div>
  );
}
