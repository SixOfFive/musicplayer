import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLibrary } from '../store/library';
import { LIKED_PLAYLIST_ID } from '../../shared/types';
import { buildPlaylistTooltip } from '../lib/playlistTooltip';

// Shape returned by pl:import-from-folder. Defined here rather than
// in shared/types.ts because only this file consumes it.
interface ImportCorruption {
  file: string;
  absPath: string;
  kind: 'parseFailed' | 'partial';
  message: string;
  skippedLines: Array<{ lineNo: number; raw: string; reason: string }>;
  scanned: number | null;
  kept: number | null;
}
interface ImportResult {
  imported: number;
  dir: string;
  corruptions: ImportCorruption[];
}

export default function PlaylistsView() {
  const playlists = useLibrary((s) => s.playlists);
  const refresh = useLibrary((s) => s.refreshPlaylists);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState<'' | 'export' | 'import' | 'fix'>('');
  const [msg, setMsg] = useState<string | null>(null);
  /** Corruption report from the most recent import. null when there's
   *  nothing to show. Lives in state so the Fix / Skip buttons can
   *  update it locally after a successful rewrite. */
  const [corruptions, setCorruptions] = useState<ImportCorruption[]>([]);

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
    setCorruptions([]);
    try {
      const r: ImportResult = await (window.mp.playlists as any).importFromFolder();
      if (r.imported > 0) {
        setMsg(`Imported ${r.imported} new playlist${r.imported === 1 ? '' : 's'} from ${r.dir}`);
        await refresh();
      } else if (r.corruptions.length === 0) {
        setMsg(`No new .m3u8 files to import in ${r.dir || 'the export folder'}.`);
      } else {
        setMsg(`No new playlists imported — ${r.corruptions.length} file${r.corruptions.length === 1 ? '' : 's'} needed attention (below).`);
      }
      setCorruptions(r.corruptions ?? []);
    } catch (e: any) {
      setMsg(`Import failed: ${e?.message ?? e}`);
    }
    setBusy('');
  }

  /** Rewrite the specified playlist files, dropping bad lines. Updates
   *  the local corruptions state so the fixed entries disappear from
   *  the banner. */
  async function fixCorrupt(absPaths: string[]) {
    setBusy('fix');
    try {
      const r: { fixed: number; errors: Array<{ path: string; error: string }> } =
        await (window.mp.playlists as any).fixCorrupt(absPaths);
      setCorruptions((prev) => prev.filter((c) => !absPaths.includes(c.absPath)));
      const errPart = r.errors.length > 0 ? ` (${r.errors.length} failed)` : '';
      setMsg(`Rewrote ${r.fixed} playlist file${r.fixed === 1 ? '' : 's'}${errPart}. Run Import again to load them.`);
    } catch (e: any) {
      setMsg(`Fix failed: ${e?.message ?? e}`);
    }
    setBusy('');
  }

  function dismiss(absPath: string) {
    setCorruptions((prev) => prev.filter((c) => c.absPath !== absPath));
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

      {/* Corruption report from the most recent import. Shows each
          problem file with its issue, the offending lines (collapsed
          behind a disclosure), and per-file Fix / Skip buttons. "Fix"
          rewrites the .m3u8 in place keeping only the salvageable
          entries; "Skip" dismisses the entry from this list (the
          file is left untouched). Parse-failed files (totally
          unreadable) don't get a Fix button — nothing to salvage. */}
      {corruptions.length > 0 && (
        <div className="mb-4 bg-amber-500/10 border border-amber-500/30 rounded p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-amber-400 font-semibold text-sm">
              {corruptions.length} playlist file{corruptions.length === 1 ? '' : 's'} need{corruptions.length === 1 ? 's' : ''} attention
            </span>
            {corruptions.some((c) => c.kind === 'partial') && (
              <button
                onClick={() => fixCorrupt(corruptions.filter((c) => c.kind === 'partial').map((c) => c.absPath))}
                disabled={busy === 'fix'}
                className="ml-auto px-3 py-1 rounded bg-accent text-black text-xs font-semibold disabled:opacity-50"
                title="Rewrite every partial-parse file, keeping only the salvageable entries"
              >
                {busy === 'fix' && <span className="inline-block w-3 h-3 border-2 border-black/50 border-t-transparent rounded-full animate-spin mr-1 align-middle" />}
                Fix all
              </button>
            )}
          </div>
          <p className="text-xs text-amber-200/80">
            Bad lines were skipped during import. You can rewrite each file, keeping
            only the successfully-parsed tracks, or leave the files alone. Files
            marked "unreadable" can't be auto-fixed — open them in a text editor
            to investigate.
          </p>
          <ul className="space-y-2">
            {corruptions.map((c) => (
              <li key={c.absPath} className="bg-bg-base rounded p-3 text-xs">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-text-primary truncate">{c.file}</span>
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] ${c.kind === 'parseFailed' ? 'bg-red-500/20 text-red-300' : 'bg-amber-500/20 text-amber-300'}`}>
                        {c.kind === 'parseFailed' ? 'unreadable' : 'partial'}
                      </span>
                    </div>
                    <div className="text-text-muted mt-1">{c.message}</div>
                    {c.kept !== null && c.scanned !== null && (
                      <div className="text-text-muted mt-0.5">Kept {c.kept} of {c.scanned} lines.</div>
                    )}
                    {c.skippedLines.length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-text-muted hover:text-text-primary">
                          Show skipped lines ({c.skippedLines.length})
                        </summary>
                        <ul className="mt-1 ml-4 list-disc max-h-40 overflow-y-auto space-y-0.5">
                          {c.skippedLines.map((s, i) => (
                            <li key={i} className="text-[11px] text-text-muted">
                              <span className="tabular-nums">L{s.lineNo}</span>
                              <span className="text-red-400/80"> · {s.reason}</span>
                              <div className="font-mono truncate opacity-60">{s.raw}</div>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 flex-shrink-0">
                    {c.kind === 'partial' && (
                      <button
                        onClick={() => fixCorrupt([c.absPath])}
                        disabled={busy === 'fix'}
                        className="px-2 py-1 rounded bg-accent text-black text-[10px] font-semibold disabled:opacity-50"
                        title="Rewrite this file, keeping only the salvageable entries"
                      >Fix</button>
                    )}
                    <button
                      onClick={() => dismiss(c.absPath)}
                      className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-[10px]"
                      title="Leave this file as-is and hide this entry"
                    >Skip</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
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
              // Multi-line hover tooltip matching the AlbumCard pattern:
              // name, optional description, stats (tracks · duration · size).
              // See `src/lib/playlistTooltip.ts`.
              title={buildPlaylistTooltip(p)}
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
