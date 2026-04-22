import { useEffect, useState } from 'react';
import YearTagAudit from './YearTagAudit';
import type { PlaylistSaveMode } from '../../../shared/types';

interface Dir { id: number; path: string; enabled: boolean; lastScannedAt: number | null; }

export default function LibrarySettings() {
  const [dirs, setDirs] = useState<Dir[]>([]);
  const [dbPath, setDbPath] = useState('');
  const [cachePath, setCachePath] = useState('');
  const [artStorage, setArtStorage] = useState<'cache' | 'album-folder'>('cache');
  const [artFilename, setArtFilename] = useState('cover');
  const [allowDelete, setAllowDelete] = useState(false);
  const [plExportEnabled, setPlExportEnabled] = useState(true);
  const [plExportFolder, setPlExportFolder] = useState('');
  const [plPathStyle, setPlPathStyle] = useState<'absolute' | 'relative'>('absolute');
  const [plExportLiked, setPlExportLiked] = useState(true);
  const [scanProgress, setScanProgress] = useState<{ phase: string; processed: number; seen: number; msg: string | null } | null>(null);

  async function refresh() {
    const ds = await window.mp.library.listDirs();
    setDirs(ds);
    const s = await window.mp.settings.get();
    setDbPath(s.library.databasePath);
    setCachePath(s.library.coverArtCachePath);
    setArtStorage(s.library.coverArtStorage ?? 'cache');
    setArtFilename(s.library.coverArtFilename ?? 'cover');
    setAllowDelete(!!s.library.allowFileDeletion);
    const pe = s.playlistExport ?? { enabled: true, folder: '', pathStyle: 'absolute', exportLiked: true };
    setPlExportEnabled(!!pe.enabled);
    setPlExportFolder(pe.folder ?? '');
    setPlPathStyle(pe.pathStyle ?? 'absolute');
    setPlExportLiked(!!pe.exportLiked);
  }
  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    const off = window.mp.scan.onProgress((p: any) => {
      setScanProgress({ phase: p.phase, processed: p.filesProcessed, seen: p.filesSeen, msg: p.message });
    });
    return () => { off?.(); };
  }, []);

  async function addDir() {
    const picked = await window.mp.library.pickDir();
    if (!picked) return;
    await window.mp.library.addDir(picked);
    refresh();
  }
  async function removeDir(id: number) {
    await window.mp.library.removeDir(id);
    refresh();
  }
  async function startScan() { await window.mp.scan.start(); }
  async function cancelScan() { await window.mp.scan.cancel(); }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold mb-1">Music folders</h2>
        <p className="text-sm text-text-muted mb-3">Folders that will be scanned for audio files. Scans are recursive.</p>
        <div className="bg-bg-elev-2 rounded divide-y divide-white/5">
          {dirs.map((d) => (
            <div key={d.id} className="flex items-center justify-between px-4 py-3 text-sm">
              <div className="min-w-0">
                <div className="truncate">{d.path}</div>
                <div className="text-xs text-text-muted">
                  {d.lastScannedAt ? `Last scanned ${new Date(d.lastScannedAt).toLocaleString()}` : 'Not scanned yet'}
                </div>
              </div>
              <button onClick={() => removeDir(d.id)} className="text-text-muted hover:text-red-400">Remove</button>
            </div>
          ))}
          {dirs.length === 0 && <div className="px-4 py-6 text-sm text-text-muted">No folders yet.</div>}
        </div>
        <div className="flex gap-2 mt-3">
          <button onClick={addDir} className="bg-accent hover:bg-accent-hover text-black font-semibold px-4 py-1.5 rounded-full text-sm">+ Add folder</button>
          <button onClick={startScan} className="bg-white/10 hover:bg-white/20 text-white px-4 py-1.5 rounded-full text-sm">Scan now</button>
          {scanProgress && scanProgress.phase !== 'idle' && scanProgress.phase !== 'done' && (
            <button onClick={cancelScan} className="bg-white/5 text-text-muted px-4 py-1.5 rounded-full text-sm">Cancel</button>
          )}
        </div>
        {scanProgress && (
          <div className="mt-3 text-sm text-text-muted">
            <span className="inline-block w-24 capitalize">{scanProgress.phase}</span>
            <span>{scanProgress.processed} / {scanProgress.seen}</span>
            {scanProgress.msg && <span className="ml-2">· {scanProgress.msg}</span>}
          </div>
        )}
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-1">Database & cover art</h2>
        <div className="bg-bg-elev-2 rounded p-4 space-y-4 text-sm">
          <div>
            <div><span className="text-text-muted">Library DB:</span> <span className="font-mono">{dbPath}</span></div>
            <div><span className="text-text-muted">Cover art cache:</span> <span className="font-mono">{cachePath}</span></div>
            <p className="text-xs text-text-muted mt-1">Changing these paths will be supported in a later build.</p>
          </div>

          <div className="pt-3 border-t border-white/5">
            <div className="font-medium mb-2">Where should new cover art be saved?</div>
            <label className="flex items-start gap-2 mb-2 cursor-pointer">
              <input
                type="radio"
                name="art-storage"
                className="mt-1"
                checked={artStorage === 'cache'}
                onChange={async () => {
                  setArtStorage('cache');
                  await window.mp.settings.set({ library: { coverArtStorage: 'cache' } } as any);
                }}
              />
              <span>
                <span className="font-medium">App cache folder</span>
                <p className="text-xs text-text-muted mt-0.5">
                  Stored under your OS app-data dir. Your music folders are never written to.
                </p>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="art-storage"
                className="mt-1"
                checked={artStorage === 'album-folder'}
                onChange={async () => {
                  setArtStorage('album-folder');
                  await window.mp.settings.set({ library: { coverArtStorage: 'album-folder' } } as any);
                  // Auto-migrate existing cached art so the user doesn't have
                  // to remember to click the button. Idempotent — re-running
                  // later via the button does no harm.
                  try {
                    const res = await (window.mp.library as any).migrateCoverArt();
                    if (res.moved > 0 || res.skippedExisting > 0) {
                      console.log(`[settings] cover-art migration: moved=${res.moved}, kept=${res.skippedExisting}, failed=${res.failed}`);
                    }
                  } catch (err) { console.error('[settings] auto cover-art migration failed', err); }
                }}
              />
              <span>
                <span className="font-medium">Alongside the audio files</span>
                <p className="text-xs text-text-muted mt-0.5">
                  Saves as <code className="font-mono">{artFilename}.jpg</code> in the album's folder.
                  This is the layout Jellyfin, Plex, MusicBee and foobar2000 all read from — your art travels with your collection.
                  If a folder isn't writable (e.g. read-only share), falls back to the app cache.
                </p>
              </span>
            </label>

            {/* Migration button — moves existing art out of the cache folder.
                Shown regardless of the currently-selected strategy so users
                can consolidate after toggling, or re-run if a previous
                migration left some albums behind. */}
            <MigrateArtButton />

            {artStorage === 'album-folder' && (
              <div className="mt-3 flex items-center gap-2">
                <label className="text-xs text-text-muted w-24">Filename</label>
                <input
                  value={artFilename}
                  onChange={(e) => setArtFilename(e.target.value.replace(/[^a-zA-Z0-9._-]/g, ''))}
                  onBlur={async () => {
                    await window.mp.settings.set({ library: { coverArtFilename: artFilename || 'cover' } } as any);
                  }}
                  className="bg-bg-base px-2 py-1 rounded text-xs font-mono w-32"
                  placeholder="cover"
                />
                <span className="text-xs text-text-muted">
                  .jpg / .png (extension picked from the image type)
                </span>
              </div>
            )}

            <p className="text-xs text-text-muted mt-3">
              Switching to "Alongside the audio files" automatically moves your existing cached
              cover art into each album's folder. If you want to consolidate again later (or
              after a bulk scan), use the button above.
            </p>
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-1">Playlist export (.m3u8)</h2>
        <p className="text-sm text-text-muted mb-3">
          Playlists are written as universal <code className="font-mono">.m3u8</code> files — the same format Jellyfin,
          foobar2000, MusicBee, VLC, Plex, Navidrome and every Android music player understand.
          The <strong>Liked Songs</strong> list is also exported automatically.
          Any <code className="font-mono">.m3u8</code> files found in this folder on startup are imported
          as new playlists (existing ones are never overwritten).
        </p>
        <div className="bg-bg-elev-2 rounded p-4 space-y-3 text-sm">
          <label className="flex items-start gap-2">
            <input
              type="checkbox" className="mt-1"
              checked={plExportEnabled}
              onChange={async (e) => {
                setPlExportEnabled(e.target.checked);
                await window.mp.settings.set({ playlistExport: { enabled: e.target.checked } } as any);
              }}
            />
            <span><span className="font-medium">Write playlists to disk</span></span>
          </label>

          <div>
            <label className="text-xs text-text-muted">Export folder — absolute path, used exactly as picked (leave blank for app's private data folder)</label>
            <div className="flex gap-2 mt-1">
              <input
                value={plExportFolder}
                onChange={(e) => setPlExportFolder(e.target.value)}
                onBlur={async () => {
                  await window.mp.settings.set({ playlistExport: { folder: plExportFolder.trim() } } as any);
                }}
                className="flex-1 bg-bg-base px-2 py-1 rounded text-xs font-mono"
                placeholder="Auto — will use the app's private data folder"
              />
              <button
                onClick={async () => {
                  const d = await window.mp.library.pickDir();
                  if (!d) return;
                  setPlExportFolder(d);
                  await window.mp.settings.set({ playlistExport: { folder: d } } as any);
                }}
                className="bg-white/10 hover:bg-white/20 px-3 py-1 rounded text-xs"
              >Pick…</button>
            </div>
          </div>

          <div>
            <div className="text-xs text-text-muted mb-1">Path style in playlists</div>
            <label className="inline-flex items-center gap-2 mr-4">
              <input type="radio" name="plpath" checked={plPathStyle === 'absolute'} onChange={async () => { setPlPathStyle('absolute'); await window.mp.settings.set({ playlistExport: { pathStyle: 'absolute' } } as any); }} />
              Absolute
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="radio" name="plpath" checked={plPathStyle === 'relative'} onChange={async () => { setPlPathStyle('relative'); await window.mp.settings.set({ playlistExport: { pathStyle: 'relative' } } as any); }} />
              Relative (portable)
            </label>
          </div>

          <label className="flex items-start gap-2">
            <input
              type="checkbox" className="mt-1"
              checked={plExportLiked}
              onChange={async (e) => {
                setPlExportLiked(e.target.checked);
                await window.mp.settings.set({ playlistExport: { exportLiked: e.target.checked } } as any);
              }}
            />
            <span>Also export Liked Songs as <code className="font-mono">Liked Songs.m3u8</code></span>
          </label>

          <PlaylistSaveModeControl />

          <CopyLikedToFolder />
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-1">Destructive operations</h2>
        <div className="bg-bg-elev-2 rounded p-4 text-sm space-y-3">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1"
              checked={allowDelete}
              onChange={async (e) => {
                const next = e.target.checked;
                setAllowDelete(next);
                await window.mp.settings.set({ library: { allowFileDeletion: next } } as any);
              }}
            />
            <span>
              <span className="font-medium">Allow deleting song/album files from disk</span>
              <p className="text-xs text-text-muted mt-1">
                When enabled, context menus on tracks and albums gain a "Delete file" item that moves files to
                the system trash (not permanent). The library database is automatically refreshed after a delete.
                Leave off for a safe, library-only deletion mode.
              </p>
            </span>
          </label>
        </div>
      </div>

      {/* Year-tag audit + fix. Self-contained component — scans for
          two-digit / zero / future / album-outlier year tags and
          rewrites the file tag via ffmpeg when the user confirms.
          Section heading matches the visual rhythm of the other
          Library groupings above. */}
      <div>
        <h2 className="text-lg font-semibold mb-1">Tag audit</h2>
        <YearTagAudit />
      </div>
    </div>
  );
}

/**
 * Button + status readout for the cover-art migration (cache → album folder).
 * Idempotent — clicking more than once is safe; a second click just reports
 * `moved: 0`.
 */
function MigrateArtButton() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<null | {
    total: number; moved: number; skippedExisting: number;
    skippedNoFolder: number; failed: number; errors: string[];
  }>(null);

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const r = await (window.mp.library as any).migrateCoverArt();
      setResult(r);
    } catch (err: any) {
      setResult({ total: 0, moved: 0, skippedExisting: 0, skippedNoFolder: 0, failed: 1, errors: [err?.message ?? String(err)] });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mt-2 p-3 bg-bg-base rounded border border-white/5">
      <div className="flex items-center gap-3">
        <button
          onClick={run}
          disabled={running}
          className="text-xs px-3 py-1.5 rounded bg-accent text-black font-semibold hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
          title="Relocate cached cover art into each album's folder"
        >
          {running ? 'Moving…' : 'Move cached cover art to album folders'}
        </button>
        <span className="text-xs text-text-muted">
          One-shot consolidation. Safe to run anytime; albums already in their folder are skipped.
        </span>
      </div>
      {result && (
        <div className="mt-3 text-xs text-text-muted space-y-0.5">
          <div>Total cached albums considered: <span className="text-text-primary">{result.total}</span></div>
          <div>Moved into album folder: <span className="text-text-primary">{result.moved}</span></div>
          {result.skippedExisting > 0 && (
            <div>Already had a cover file (DB re-pointed): <span className="text-text-primary">{result.skippedExisting}</span></div>
          )}
          {result.skippedNoFolder > 0 && (
            <div>Skipped — couldn't resolve album folder: <span className="text-text-primary">{result.skippedNoFolder}</span></div>
          )}
          {result.failed > 0 && (
            <div className="text-red-400">Failed: {result.failed}</div>
          )}
          {result.errors.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-text-muted">Errors ({result.errors.length})</summary>
              <ul className="mt-1 ml-4 list-disc">
                {result.errors.map((e, i) => <li key={i} className="text-red-400">{e}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Radio-group control for `playlistExport.saveMode` + a live status
 * readout showing which mode is currently effective and how many
 * edits are queued (only meaningful in on-close mode).
 *
 * User-visible states:
 *   Auto           — immediate saves until a >1s write, then switches
 *                    itself to on-close for the rest of the session.
 *                    Status line reveals the auto-detected current mode.
 *   Immediate      — always save on every edit, even if slow.
 *   Save on close  — queue edits, flush on app quit (or manual button).
 *
 * Flipping from auto → any explicit mode resets `autoDetectedMode` to
 * 'immediate' so a later flip back to auto starts fresh.
 */
function PlaylistSaveModeControl() {
  const [mode, setMode] = useState<PlaylistSaveMode>('auto');
  const [status, setStatus] = useState<{
    saveMode: PlaylistSaveMode;
    autoDetectedMode: 'immediate' | 'on-close';
    effective: 'immediate' | 'on-close';
    pending: number;
    effectiveDir: string | null;
    lastError: { message: string; at: number; path: string | null } | null;
  } | null>(null);
  const [flushing, setFlushing] = useState(false);

  async function refreshStatus() {
    try {
      const s = await (window.mp.playlists as any).schedStatus();
      setStatus(s);
      setMode(s.saveMode);
    } catch { /* noop — settings panel shouldn't die if IPC hiccups */ }
  }

  // Poll status every 2s while the panel is open so the "pending" count
  // reflects new edits that landed while the user is looking.
  useEffect(() => {
    void refreshStatus();
    const t = setInterval(refreshStatus, 2000);
    return () => clearInterval(t);
  }, []);

  async function pickMode(next: PlaylistSaveMode) {
    setMode(next);
    // Flipping to an explicit mode resets the auto-detected latch so a
    // later switch back to 'auto' starts fresh and re-observes timing.
    const patch: any = { playlistExport: { saveMode: next } };
    if (next !== 'auto') patch.playlistExport.autoDetectedMode = 'immediate';
    await window.mp.settings.set(patch);
    void refreshStatus();
  }

  async function flushNow() {
    setFlushing(true);
    try {
      await (window.mp.playlists as any).flushNow();
      await refreshStatus();
    } catch { /* reported via the status poll */ }
    setFlushing(false);
  }

  return (
    <div className="pt-3 border-t border-white/5">
      <div className="text-xs text-text-muted mb-1">When to save playlists to disk</div>
      <div className="flex flex-col gap-1">
        <label className="inline-flex items-center gap-2">
          <input type="radio" name="plsave" checked={mode === 'auto'} onChange={() => pickMode('auto')} />
          <span>
            Auto
            <span className="text-text-muted text-xs ml-2">
              (save immediately; switch to on-close after any slow write &gt; 1s)
            </span>
          </span>
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="radio" name="plsave" checked={mode === 'immediate'} onChange={() => pickMode('immediate')} />
          <span>
            Always save immediately
            <span className="text-text-muted text-xs ml-2">(keeps disk in sync on every edit; may cause UI lag on big playlists over SMB)</span>
          </span>
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="radio" name="plsave" checked={mode === 'on-close'} onChange={() => pickMode('on-close')} />
          <span>
            Save on app close
            <span className="text-text-muted text-xs ml-2">(snappy edits; pending changes flush at quit)</span>
          </span>
        </label>
      </div>

      {/* Live status. Helpful in 'auto' mode where the effective mode
          can change mid-session. Also shows the pending-queue count
          when we're in on-close mode, with a manual flush button. */}
      {status && (
        <div className="mt-2 text-xs text-text-muted space-y-1">
          <div className="flex items-center gap-3 flex-wrap">
            <span>
              Currently saving{' '}
              <span className="text-text-primary">
                {status.effective === 'immediate' ? 'immediately' : 'on close'}
              </span>
              {status.saveMode === 'auto' && status.effective === 'on-close' && (
                <> — auto-switched after a slow write</>
              )}
            </span>
            {status.pending > 0 && (
              <>
                <span className="text-amber-400">{status.pending} edit{status.pending === 1 ? '' : 's'} queued</span>
                <button
                  onClick={flushNow}
                  disabled={flushing}
                  className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[10px] disabled:opacity-50"
                  title="Write every queued playlist to disk right now"
                >
                  {flushing ? 'Saving…' : 'Save now'}
                </button>
              </>
            )}
          </div>
          {/* Effective write location. Important when the explicit
              folder is a network share — the user can see at a glance
              whether exports are still going there. Falls back to the
              userData path only when no explicit folder is set (no
              silent fallback to userData when a share fails; that
              path now throws loudly instead). */}
          {status.effectiveDir && (
            <div className="flex items-start gap-2">
              <span className="text-text-muted">Writing to:</span>
              <code className="font-mono text-text-primary text-[11px] break-all">{status.effectiveDir}</code>
            </div>
          )}
          {/* Last export error banner — surfaces network-share
              disconnects, permission rejections, read-only filesystems.
              Clears automatically on the next successful write; the
              dismiss (×) button acknowledges without waiting. */}
          {status.lastError && (
            <div className="mt-1 p-2 rounded bg-red-500/10 border border-red-500/30 flex items-start gap-2">
              <div className="flex-1 text-red-200 text-[11px]">
                <div className="font-semibold">Playlist export failed</div>
                <div className="opacity-80 mt-0.5 break-all">{status.lastError.message}</div>
                {status.lastError.path && (
                  <div className="mt-0.5 font-mono opacity-60 break-all">while writing {status.lastError.path}</div>
                )}
              </div>
              <button
                onClick={async () => {
                  await (window.mp.playlists as any).clearLastError();
                  void refreshStatus();
                }}
                className="text-red-200/60 hover:text-red-100 text-xs flex-shrink-0"
                title="Dismiss"
              >✕</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "Copy Liked to folder" — portable-export button.
 *
 * Flow:
 *   1. Click button → native folder picker (main-side, so createDirectory works).
 *   2. Confirm destination → kick off `copyLikedStart` on main.
 *   3. Main streams progress events. On a conflict (dest file already
 *      exists) or error (copy/mkdir failed), main pauses the run and
 *      pushes a prompt event; we show a modal with Skip / Overwrite /
 *      Skip All / Overwrite All / Abort (conflict) or Continue / Skip
 *      / Skip All / Abort (error). Our reply via `copyLikedDecide`
 *      unblocks main.
 *   4. Terminal event `pl:copy-liked-done` carries the summary — we
 *      show it in the same panel and reset.
 *
 * Only ONE run can be active at a time (main enforces this; UI just
 * disables the button until `done` arrives). Unmounting mid-run sends
 * an explicit `copyLikedAbort` so main doesn't sit on a dangling
 * prompt-resolver promise.
 */
function CopyLikedToFolder() {
  type Phase =
    | { kind: 'idle' }
    | { kind: 'picking' }
    | { kind: 'running'; done: number; total: number; currentFile: string | null }
    | { kind: 'done'; summary: { total: number; copied: number; overwritten: number; skipped: number; failed: number; aborted: boolean; errors: Array<{ path: string; error: string }> } };

  type ConflictPrompt = { id: number; srcPath: string; destPath: string; artist: string };
  type ErrorPrompt = { id: number; srcPath: string; destPath: string; error: string; artist: string };

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [destDir, setDestDir] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);
  const [error, setError] = useState<ErrorPrompt | null>(null);

  // Wire up the main → renderer push listeners once per mount. Each
  // handler updates the appropriate piece of state; the Abort /
  // Continue / Skip buttons just call copyLikedDecide(id, action).
  useEffect(() => {
    const offProgress = (window.mp.playlists as any).onCopyLikedProgress((p: { done: number; total: number; currentFile: string | null }) => {
      setPhase((prev) =>
        prev.kind === 'running'
          ? { ...prev, ...p }
          : { kind: 'running', ...p });
    });
    const offConflict = (window.mp.playlists as any).onCopyLikedConflict((p: ConflictPrompt) => {
      setConflict(p);
    });
    const offError = (window.mp.playlists as any).onCopyLikedError((p: ErrorPrompt) => {
      setError(p);
    });
    const offDone = (window.mp.playlists as any).onCopyLikedDone((summary: any) => {
      setPhase({ kind: 'done', summary });
      setConflict(null);
      setError(null);
    });
    return () => {
      offProgress?.();
      offConflict?.();
      offError?.();
      offDone?.();
      // If the panel unmounts while a prompt is outstanding, tell main
      // to stop waiting. Main will resolve as 'abort' and the run ends
      // cleanly; otherwise we'd leave a dangling promise in main memory.
      (window.mp.playlists as any).copyLikedAbort?.();
    };
  }, []);

  async function pickAndStart() {
    setPhase({ kind: 'picking' });
    try {
      const picked = await (window.mp.playlists as any).copyLikedPickDest();
      if (!picked) {
        setPhase({ kind: 'idle' });
        return;
      }
      setDestDir(picked);
      // Immediately transition to 'running' with a 0/0 placeholder so
      // the UI shows "Starting…" instead of flickering back to idle
      // while main is counting likes.
      setPhase({ kind: 'running', done: 0, total: 0, currentFile: null });
      await (window.mp.playlists as any).copyLikedStart(picked);
    } catch (err) {
      console.error('[copy-liked] start failed', err);
      setPhase({ kind: 'idle' });
    }
  }

  function decide(id: number, action: string, clearKind: 'conflict' | 'error') {
    (window.mp.playlists as any).copyLikedDecide(id, action);
    if (clearKind === 'conflict') setConflict(null);
    else setError(null);
  }

  return (
    <div className="pt-3 border-t border-white/5">
      <div className="font-medium mb-1">Copy Liked songs to a folder</div>
      <p className="text-xs text-text-muted mb-2">
        Duplicates every liked track's AUDIO FILE into
        <code className="font-mono mx-1">&lt;chosen folder&gt;/&lt;Artist&gt;/&lt;original filename&gt;</code>.
        Useful for making a portable copy on a USB stick or another drive. Originals are left untouched.
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={pickAndStart}
          disabled={phase.kind === 'picking' || phase.kind === 'running'}
          className="text-xs px-3 py-1.5 rounded bg-accent text-black font-semibold hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {phase.kind === 'picking' ? 'Waiting for folder…'
            : phase.kind === 'running' ? 'Copying…'
            : 'Copy Liked to folder…'}
        </button>
        {destDir && (phase.kind === 'running' || phase.kind === 'done') && (
          <span className="text-xs text-text-muted font-mono break-all">→ {destDir}</span>
        )}
      </div>

      {/* Live progress */}
      {phase.kind === 'running' && (
        <div className="mt-2 text-xs text-text-muted space-y-1">
          <div>
            <span className="text-text-primary">{phase.done}</span> / {phase.total || '?'} files
            {phase.total > 0 && (
              <span className="ml-2">({Math.round((phase.done / phase.total) * 100)}%)</span>
            )}
          </div>
          {phase.currentFile && (
            <div className="font-mono text-[11px] opacity-60 break-all">
              {phase.currentFile}
            </div>
          )}
          {phase.total > 0 && (
            <div className="h-1 rounded bg-white/5 overflow-hidden">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${Math.min(100, (phase.done / phase.total) * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Final summary + per-failure detail list */}
      {phase.kind === 'done' && (
        <div className="mt-2 p-3 bg-bg-base rounded border border-white/5 text-xs space-y-1">
          <div className="font-medium text-text-primary">
            {phase.summary.aborted ? 'Aborted' : 'Done'}
          </div>
          <div>Total liked tracks: <span className="text-text-primary">{phase.summary.total}</span></div>
          <div>Copied: <span className="text-text-primary">{phase.summary.copied}</span></div>
          {phase.summary.overwritten > 0 && (
            <div>Overwrote existing: <span className="text-text-primary">{phase.summary.overwritten}</span></div>
          )}
          {phase.summary.skipped > 0 && (
            <div>Skipped (already existed): <span className="text-text-primary">{phase.summary.skipped}</span></div>
          )}
          {phase.summary.failed > 0 && (
            <div className="text-red-300">Failed: {phase.summary.failed}</div>
          )}
          {phase.summary.errors.length > 0 && (
            <details>
              <summary className="cursor-pointer text-text-muted">Errors ({phase.summary.errors.length})</summary>
              <ul className="mt-1 ml-4 list-disc space-y-1">
                {phase.summary.errors.map((e, i) => (
                  <li key={i} className="text-red-300 break-all">
                    <span className="font-mono">{e.path}</span>
                    <div className="opacity-70">{e.error}</div>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <button
            onClick={() => { setPhase({ kind: 'idle' }); setDestDir(null); }}
            className="mt-2 text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20"
          >Dismiss</button>
        </div>
      )}

      {/* Conflict modal — destination file already exists. Skip /
          Overwrite / Skip All / Overwrite All / Abort. The extra two
          "All" variants were added per user request ("or skip all as
          well") so they don't have to click five hundred times on a
          re-run. Abort is always available even when a blanket
          decision would apply. */}
      {conflict && (
        <PromptModal
          title="File already exists"
          subtitle={conflict.destPath}
          detail={<>Artist: <span className="font-medium">{conflict.artist}</span></>}
          buttons={[
            { label: 'Skip', action: 'skip', variant: 'ghost' },
            { label: 'Overwrite', action: 'overwrite', variant: 'accent' },
            { label: 'Skip All', action: 'skip-all', variant: 'ghost' },
            { label: 'Overwrite All', action: 'overwrite-all', variant: 'accent' },
            { label: 'Abort', action: 'abort', variant: 'danger' },
          ]}
          onDecide={(action) => decide(conflict.id, action, 'conflict')}
        />
      )}

      {/* Error modal — copy or mkdir failed. Continue (retry) / Skip /
          Skip All / Abort. Continue keeps re-trying the same file so a
          transient network blip can be recovered from without aborting
          the whole run; Skip All silences future errors for the rest
          of this run. */}
      {error && (
        <PromptModal
          title="Copy failed"
          subtitle={error.srcPath}
          detail={<>
            <div>Artist: <span className="font-medium">{error.artist}</span></div>
            <div className="mt-1 text-red-300">{error.error}</div>
          </>}
          buttons={[
            { label: 'Continue', action: 'continue', variant: 'accent' },
            { label: 'Skip', action: 'skip', variant: 'ghost' },
            { label: 'Skip All', action: 'skip-all', variant: 'ghost' },
            { label: 'Abort', action: 'abort', variant: 'danger' },
          ]}
          onDecide={(action) => decide(error.id, action, 'error')}
        />
      )}
    </div>
  );
}

/**
 * Generic inline-modal prompt for the copy-liked flow. Not a real
 * portal'd modal — just an absolutely-positioned overlay above the
 * settings panel. Deliberately blocking: the copy loop in main is
 * paused until the user picks an option, so we want full attention
 * here rather than a dismissable toast.
 */
function PromptModal({
  title,
  subtitle,
  detail,
  buttons,
  onDecide,
}: {
  title: string;
  subtitle: string;
  detail: React.ReactNode;
  buttons: Array<{ label: string; action: string; variant: 'accent' | 'ghost' | 'danger' }>;
  onDecide: (action: string) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-bg-elev-2 border border-white/10 rounded-lg shadow-2xl p-5 max-w-xl w-full mx-4">
        <div className="text-base font-semibold text-text-primary mb-1">{title}</div>
        <div className="font-mono text-xs opacity-70 break-all mb-2">{subtitle}</div>
        <div className="text-xs text-text-muted mb-4">{detail}</div>
        <div className="flex flex-wrap gap-2 justify-end">
          {buttons.map((b) => (
            <button
              key={b.action}
              onClick={() => onDecide(b.action)}
              className={
                b.variant === 'accent'
                  ? 'text-xs px-3 py-1.5 rounded bg-accent text-black font-semibold hover:bg-accent-hover'
                  : b.variant === 'danger'
                    ? 'text-xs px-3 py-1.5 rounded bg-red-500/80 hover:bg-red-500 text-white'
                    : 'text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-text-primary'
              }
            >{b.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
