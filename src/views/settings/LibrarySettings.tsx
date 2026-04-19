import { useEffect, useState } from 'react';

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
            <label className="text-xs text-text-muted">Export folder (leave blank for auto: <code className="font-mono">&lt;music folder&gt;/Playlists</code>)</label>
            <div className="flex gap-2 mt-1">
              <input
                value={plExportFolder}
                onChange={(e) => setPlExportFolder(e.target.value)}
                onBlur={async () => {
                  await window.mp.settings.set({ playlistExport: { folder: plExportFolder.trim() } } as any);
                }}
                className="flex-1 bg-bg-base px-2 py-1 rounded text-xs font-mono"
                placeholder="Auto — will use <music folder>/Playlists"
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
