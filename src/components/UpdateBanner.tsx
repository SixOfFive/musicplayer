import { useEffect, useRef, useState } from 'react';
import type { UpdateCheckResult } from '../../shared/types';

/**
 * Top-of-app yellow strip that appears when a newer version is available.
 *
 * Two modes:
 *   1. Packaged installer build (app.isPackaged = true)
 *      - checkForUpdates() uses electron-updater → reads the latest GitHub
 *        Release. If newer, the installer downloads in the background and
 *        emits 'update:auto-event' progress events.
 *      - When download completes, we show "Restart to install".
 *      - applyUpdate() calls quitAndInstall() → silent NSIS install + relaunch.
 *   2. Source / dev build (app.isPackaged = false)
 *      - checkForUpdates() hits the GitHub REST API for the branch's latest
 *        commit. If newer, we show a pull-and-reload prompt.
 *      - applyUpdate() runs `git pull --ff-only`.
 *
 * Both paths use the same IPC surface so the UI just reacts to state.
 */

interface AutoEvent {
  kind: 'checking' | 'available' | 'none' | 'progress' | 'downloaded' | 'error';
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  info?: { version?: string; releaseName?: string | null; releaseDate?: string; releaseNotes?: string | null };
  message?: string;
}

export default function UpdateBanner() {
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [packaged, setPackaged] = useState(false);
  const [auto, setAuto] = useState<AutoEvent | null>(null);
  const [downloadReady, setDownloadReady] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guard against double-apply when check fires both at startup and
  // on a 30-min poll, or when the packaged 'downloaded' event arrives
  // while we're already mid-apply. Once an auto-apply has been kicked
  // off, further detections in the same session just show UI status.
  const autoAppliedRef = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const s: any = await window.mp.settings.get();
        const u = s.update ?? { enabled: true, checkOnStartup: true };
        if (!u.enabled) { setEnabled(false); return; }
        const info: any = await window.mp.update.info();
        if (info?.packaged) setPackaged(true);
        if (u.checkOnStartup) await runCheck();
      } catch { /* ignore */ }
    })();
    pollRef.current = setInterval(runCheck, 30 * 60 * 1000);

    // Listen for electron-updater events (packaged mode only).
    // When the installer finishes downloading, auto-trigger
    // quitAndInstall via apply() — no "Restart to install" click.
    const off = (window as any).mp.update.onAutoEvent?.((ev: AutoEvent) => {
      setAuto(ev);
      if (ev.kind === 'downloaded') {
        setDownloadReady(true);
        if (!autoAppliedRef.current) {
          autoAppliedRef.current = true;
          // Defer a tick so the "ready to install" strip renders briefly
          // before the app quits itself to run the NSIS installer.
          setTimeout(() => { apply(); }, 300);
        }
      }
    });

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runCheck() {
    const r: UpdateCheckResult = await window.mp.update.check();
    setResult(r);
    // Auto-apply the moment an update is detected. No banner yellow
    // strip, no "Update now" button click, no local-changes check.
    // In packaged mode: check() already kicked off autoDownload — the
    // 'downloaded' listener above will call apply() on completion.
    // In source mode: apply() runs fetch + reset --hard immediately,
    // and the main-side auto-relaunch restarts the app on success.
    if (!r.upToDate && !r.error && !packaged && !autoAppliedRef.current) {
      autoAppliedRef.current = true;
      apply();
    }
  }

  async function apply() {
    setBusy(true);
    const r: any = await window.mp.update.apply();
    setBusy(false);
    setApplied(r.message);
    // Source path auto-relaunches main-side, so runCheck() after apply
    // never gets a chance to fire before the window vanishes — but
    // leave the call in for the rare case where pulledCommits ended
    // up at 0 (already up to date, we caught a race).
    if (r.ok && !packaged) await runCheck();
  }

  if (!enabled) return null;
  if (dismissed) return null;

  // Packaged mode: download-progress strip
  if (packaged && auto?.kind === 'progress') {
    const pct = Math.round(auto.percent ?? 0);
    return (
      <div className="bg-blue-500/20 border-b border-blue-500/40 px-4 py-2 flex items-center gap-3 text-xs">
        <span className="text-blue-200 font-semibold">⬇ Downloading update…</span>
        <span className="text-text-muted tabular-nums">{pct}%</span>
        <div className="flex-1 h-1.5 bg-black/40 rounded overflow-hidden max-w-sm">
          <div className="h-full bg-blue-400 transition-all duration-200" style={{ width: `${pct}%` }} />
        </div>
        {auto.bytesPerSecond != null && (
          <span className="text-text-muted tabular-nums">{formatRate(auto.bytesPerSecond)}</span>
        )}
      </div>
    );
  }

  // Packaged mode: ready-to-install strip
  if (packaged && downloadReady) {
    return (
      <div className="bg-accent/20 border-b border-accent/40 px-4 py-2 flex items-center gap-3 text-xs">
        <span className="text-accent font-semibold">✓ Update ready — restart to install</span>
        {auto?.info?.version && (
          <span className="text-text-muted">→ v{auto.info.version}</span>
        )}
        <span className="flex-1" />
        <button
          onClick={apply}
          disabled={busy}
          className="px-3 py-1 rounded-full bg-accent hover:bg-accent-hover text-black font-semibold disabled:opacity-50"
        >{busy ? 'Restarting…' : 'Restart & install'}</button>
        <button onClick={() => setDismissed(true)} className="text-text-muted hover:text-white">Later</button>
      </div>
    );
  }

  if (!result) return null;
  if (result.upToDate) return null;
  if (result.error) return null;

  const repo = result.upstreamUrl.split('/').slice(-2).join('/');
  const headline = packaged
    ? `Update available on ${repo}`
    : result.commitsBehind != null
      ? `Update available — ${result.commitsBehind} new commit${result.commitsBehind === 1 ? '' : 's'} on ${repo}`
      : `Update available on ${repo}`;

  return (
    <div className="bg-yellow-500/20 border-b border-yellow-500/40 px-4 py-2 flex items-center gap-3 text-xs">
      <span className="text-yellow-200 font-semibold">⤴ {headline}</span>
      {result.latestMessage && (
        <span className="text-text-muted truncate flex-1">— {result.latestMessage}</span>
      )}
      {/* Local changes are no longer a blocker — the backend auto-stashes
          them (git stash push -u) before the hard-reset so nothing is lost.
          A small informational chip lets the user know the stash will happen,
          but there's no more "commit or stash first" gate. */}
      {!packaged && result.dirtyWorkingTree && (
        <span className="text-yellow-300/80" title="Local edits will be stashed automatically before update">
          (local changes will be stashed)
        </span>
      )}
      {!applied ? (
        <>
          <button
            onClick={apply}
            disabled={busy}
            className="px-3 py-1 rounded-full bg-yellow-500 hover:bg-yellow-400 disabled:opacity-50 text-black font-semibold"
            title={packaged ? 'Download installer and restart' : 'Fetch + reset to origin (auto-stashes local changes first)'}
          >{busy ? (packaged ? 'Downloading…' : 'Updating…') : 'Update now'}</button>
          <button
            onClick={() => window.open(result.upstreamUrl, '_blank')}
            className="text-text-muted hover:text-white"
          >View on GitHub</button>
          <button onClick={() => setDismissed(true)} className="text-text-muted hover:text-white">✕</button>
        </>
      ) : (
        <>
          <span className="text-accent">{applied}</span>
          {!packaged && (
            <button
              onClick={() => location.reload()}
              className="px-3 py-1 rounded-full bg-accent text-black font-semibold"
            >Reload now</button>
          )}
          <button onClick={() => setDismissed(true)} className="text-text-muted hover:text-white">Later</button>
        </>
      )}
    </div>
  );
}

function formatRate(bps: number) {
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}
