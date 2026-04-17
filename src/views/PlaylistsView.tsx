import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLibrary } from '../store/library';
import { LIKED_PLAYLIST_ID } from '../../shared/types';

export default function PlaylistsView() {
  const playlists = useLibrary((s) => s.playlists);
  const refresh = useLibrary((s) => s.refreshPlaylists);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState<'' | 'export' | 'import'>('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { refresh(); }, [refresh]);

  async function create() {
    if (!newName.trim()) { setCreating(false); return; }
    await window.mp.playlists.create(newName.trim());
    setNewName('');
    setCreating(false);
    await refresh();
  }

  async function exportAll() {
    setBusy('export');
    try {
      const r: any = await window.mp.playlists.exportAll();
      setMsg(`Exported ${r.count} playlist${r.count === 1 ? '' : 's'} to ${r.dir}`);
    } catch (e: any) {
      setMsg(`Export failed: ${e?.message ?? e}`);
    }
    setBusy('');
  }

  async function importFolder() {
    setBusy('import');
    try {
      const r: any = await window.mp.playlists.importFromFolder();
      if (r.imported > 0) {
        setMsg(`Imported ${r.imported} new playlist${r.imported === 1 ? '' : 's'} from ${r.dir}`);
        await refresh();
      } else {
        setMsg(`No new .m3u8 files to import in ${r.dir || 'the export folder'}.`);
      }
    } catch (e: any) {
      setMsg(`Import failed: ${e?.message ?? e}`);
    }
    setBusy('');
  }

  return (
    <section className="p-8">
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <h1 className="text-3xl font-bold flex-1">Playlists</h1>
        <button
          onClick={() => setCreating(true)}
          className="px-4 py-1.5 rounded-full bg-accent hover:bg-accent-hover text-black text-sm font-semibold"
        >+ New playlist</button>
        <button
          onClick={exportAll}
          disabled={busy === 'export'}
          className="px-4 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-sm inline-flex items-center gap-2"
          title="Write every playlist (and Liked Songs) as .m3u8 files to the export folder"
        >
          {busy === 'export' && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
          Export all (.m3u8)
        </button>
        <button
          onClick={importFolder}
          disabled={busy === 'import'}
          className="px-4 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-sm inline-flex items-center gap-2"
          title="Scan the export folder for .m3u8 files and import any that aren't already in the library"
        >
          {busy === 'import' && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
          Import from folder
        </button>
      </div>

      {msg && (
        <div className="mb-4 text-xs text-text-muted bg-bg-elev-2 rounded px-3 py-2">{msg}</div>
      )}

      {creating && (
        <div className="mb-4 flex gap-2">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            placeholder="Playlist name"
            className="bg-bg-elev-2 px-3 py-1.5 rounded text-sm flex-1 max-w-sm outline-none focus:ring-1 focus:ring-accent"
          />
          <button onClick={create} className="px-3 py-1.5 rounded bg-accent text-black text-sm font-semibold">Create</button>
          <button onClick={() => setCreating(false)} className="px-3 py-1.5 rounded bg-white/5 text-sm">Cancel</button>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {playlists.map((p) => {
          const isLiked = p.id === LIKED_PLAYLIST_ID;
          return (
            <Link
              key={p.id}
              to={`/playlist/${p.id}`}
              className="bg-bg-elev-1 hover:bg-bg-elev-2 rounded p-3 transition"
            >
              <div className={`aspect-square w-full rounded mb-2 flex items-center justify-center text-5xl ${isLiked ? 'bg-gradient-to-br from-purple-700 to-blue-400 text-white' : 'bg-bg-highlight text-text-muted'}`}>
                {isLiked ? '♥' : '♪'}
              </div>
              <div className="text-sm truncate text-text-primary font-medium">{p.name}</div>
              <div className="text-xs text-text-muted truncate">
                {p.trackCount.toLocaleString()} track{p.trackCount === 1 ? '' : 's'}
                {isLiked ? ' · auto' : ''}
              </div>
            </Link>
          );
        })}
      </div>

      {playlists.length === 0 && (
        <div className="mt-12 text-center text-text-muted text-sm">
          No playlists yet. Create one above, or drop .m3u8 files in your Playlists folder and click Import.
        </div>
      )}
    </section>
  );
}
