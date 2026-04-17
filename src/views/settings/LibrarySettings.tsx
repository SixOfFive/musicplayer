import { useEffect, useState } from 'react';

interface Dir { id: number; path: string; enabled: boolean; lastScannedAt: number | null; }

export default function LibrarySettings() {
  const [dirs, setDirs] = useState<Dir[]>([]);
  const [dbPath, setDbPath] = useState('');
  const [cachePath, setCachePath] = useState('');
  const [allowDelete, setAllowDelete] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ phase: string; processed: number; seen: number; msg: string | null } | null>(null);

  async function refresh() {
    const ds = await window.mp.library.listDirs();
    setDirs(ds);
    const s = await window.mp.settings.get();
    setDbPath(s.library.databasePath);
    setCachePath(s.library.coverArtCachePath);
    setAllowDelete(!!s.library.allowFileDeletion);
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
        <h2 className="text-lg font-semibold mb-1">Database & cache</h2>
        <div className="bg-bg-elev-2 rounded p-4 space-y-2 text-sm">
          <div><span className="text-text-muted">Library DB:</span> <span className="font-mono">{dbPath}</span></div>
          <div><span className="text-text-muted">Cover art cache:</span> <span className="font-mono">{cachePath}</span></div>
          <p className="text-xs text-text-muted">Changing these paths will be supported in a later build. They live under your OS app-data dir today.</p>
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
