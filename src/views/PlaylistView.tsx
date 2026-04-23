import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import TrackRow, { type RowTrack } from '../components/TrackRow';
import SortHeader from '../components/SortHeader';
import type { TrackSort, SortDir } from '../../shared/types';
import { LIKED_PLAYLIST_ID } from '../../shared/types';
import { useLibraryRefresh } from '../hooks/useLibraryRefresh';
import ScanProgressPanel from '../components/ScanProgressPanel';
import MiniVisualizer from '../components/MiniVisualizer';

function sortTracks(tracks: RowTrack[], by: TrackSort, dir: SortDir) {
  const mul = dir === 'asc' ? 1 : -1;
  const key: (t: any) => any = (t) => {
    switch (by) {
      case 'title': return (t.title ?? '').toLowerCase();
      case 'artist': return (t.artist ?? '').toLowerCase();
      case 'album': return (t.album ?? '').toLowerCase();
      case 'year': return t.year ?? 0;
      case 'genre': return (t.genre ?? '').toLowerCase();
      case 'duration': return t.duration_sec ?? 0;
      case 'track_no': return t.track_no ?? 0;
      case 'date_added': return t.added_at ?? t.date_added ?? 0;
    }
  };
  return [...tracks].sort((a, b) => {
    const av = key(a), bv = key(b);
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    return 0;
  });
}

export default function PlaylistView() {
  const { id } = useParams();
  const pid = Number(id);
  const [tracks, setTracks] = useState<RowTrack[]>([]);
  const [meta, setMeta] = useState<{ name: string; description: string | null } | null>(null);
  const [sortBy, setSortBy] = useState<TrackSort>('date_added');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Disk I/O state. `busy` disables both buttons while either is in
  // flight; `mergePrompt` holds peek-result details while we wait for
  // the user's overwrite/merge decision; `toast` shows the success
  // / failure summary from the last save or load.
  const [busy, setBusy] = useState<'idle' | 'saving' | 'loading'>('idle');
  const [mergePrompt, setMergePrompt] = useState<null | { path: string; existingTrackCount: number | null }>(null);
  const [toast, setToast] = useState<null | { kind: 'ok' | 'err'; message: string }>(null);

  const load = useCallback(() => {
    window.mp.playlists.get(pid).then((res: any) => {
      setMeta({ name: res.playlist.name ?? 'Playlist', description: res.playlist.description ?? null });
      setTracks(res.tracks);
    });
  }, [pid]);

  useEffect(() => { load(); }, [load]);
  useLibraryRefresh(load);

  async function onSaveClick() {
    if (busy !== 'idle') return;
    setToast(null);
    setBusy('saving');
    try {
      // Peek first so we can surface a merge-vs-overwrite decision.
      // If the file doesn't exist, skip the prompt and just save.
      const peek: any = await (window.mp.playlists as any).saveNowPeek(pid);
      if (peek?.exists) {
        setMergePrompt({ path: peek.path, existingTrackCount: peek.existingTrackCount ?? null });
        return;
      }
      const r: any = await (window.mp.playlists as any).saveNow(pid, 'overwrite');
      setToast({ kind: r.ok ? 'ok' : 'err', message: r.message });
    } catch (err: any) {
      setToast({ kind: 'err', message: err?.message ?? String(err) });
    } finally {
      // Always return to idle after the save flow ends. doSave() (called
      // from the merge-prompt buttons) has its own setBusy lifecycle.
      setBusy('idle');
    }
  }

  async function doSave(mode: 'overwrite' | 'merge') {
    setMergePrompt(null);
    setBusy('saving');
    try {
      const r: any = await (window.mp.playlists as any).saveNow(pid, mode);
      setToast({ kind: r.ok ? 'ok' : 'err', message: r.message });
      if (r.ok && mode === 'merge' && r.addedFromDisk > 0) {
        // Merge pulled tracks into the DB; reload to show them.
        load();
      }
    } catch (err: any) {
      setToast({ kind: 'err', message: err?.message ?? String(err) });
    } finally {
      setBusy('idle');
    }
  }

  async function onLoadClick() {
    if (busy !== 'idle') return;
    setToast(null);
    setBusy('loading');
    try {
      const r: any = await (window.mp.playlists as any).loadNow(pid);
      setToast({ kind: r.ok ? 'ok' : 'err', message: r.message });
      if (r.ok && r.added > 0) load();
    } catch (err: any) {
      setToast({ kind: 'err', message: err?.message ?? String(err) });
    } finally {
      setBusy('idle');
    }
  }

  const sorted = useMemo(() => sortTracks(tracks, sortBy, sortDir), [tracks, sortBy, sortDir]);
  const setSort = (c: TrackSort, d: SortDir) => { setSortBy(c); setSortDir(d); };

  return (
    <section>
      <header className={`px-8 pt-8 pb-6 flex items-start gap-6 ${pid === LIKED_PLAYLIST_ID ? 'bg-gradient-to-b from-purple-900/60 to-transparent' : 'bg-gradient-to-b from-bg-elev-2 to-transparent'}`}>
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-wide text-text-muted">Playlist</div>
          <h1 className="text-5xl font-extrabold my-2 truncate">{meta?.name ?? '...'}</h1>
          {meta?.description && <p className="text-sm text-text-muted">{meta.description}</p>}
          <p className="text-sm text-text-muted mt-2">{tracks.length} tracks</p>

          {/* Save Now / Load Now — forces disk I/O for this one playlist
              regardless of the global save-mode scheduler. Liked Songs
              uses the same buttons; it writes to / reads from "Liked
              Songs.m3u8" in the export folder. */}
          <div className="mt-4 flex items-center gap-2 flex-wrap">
            <button
              onClick={onSaveClick}
              disabled={busy !== 'idle'}
              className="bg-accent hover:bg-accent-hover text-black font-semibold px-4 py-1.5 rounded-full text-sm disabled:opacity-50"
              title="Write this playlist to the configured export folder right now"
            >{busy === 'saving' ? 'Saving…' : 'Save now'}</button>
            <button
              onClick={onLoadClick}
              disabled={busy !== 'idle'}
              className="bg-white/10 hover:bg-white/20 text-white font-semibold px-4 py-1.5 rounded-full text-sm disabled:opacity-50"
              title="Pull any tracks from this playlist's .m3u8 file on disk into the app (de-duped)"
            >{busy === 'loading' ? 'Loading…' : 'Load now'}</button>
            {toast && (
              <span className={`text-xs ${toast.kind === 'ok' ? 'text-accent' : 'text-red-300'}`}>
                {toast.message}
              </span>
            )}
          </div>
        </div>
        <MiniVisualizer className="hidden md:block w-64 h-36 flex-shrink-0 self-end" />
      </header>

      {/* Merge-vs-overwrite modal. Shown when Save Now detects the
          target .m3u8 already exists. Three choices:
            - Merge: union disk + in-app, de-dupe, save back. Also
                     pulls the disk-only tracks into the DB so the app
                     view reflects the merged state.
            - Overwrite: clobber the file with the current in-app state.
            - Cancel: do nothing. */}
      {mergePrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-bg-elev-2 border border-white/10 rounded-lg shadow-2xl p-5 max-w-xl w-full mx-4">
            <div className="text-base font-semibold text-text-primary mb-1">File already exists on disk</div>
            <div className="font-mono text-xs opacity-70 break-all mb-3">{mergePrompt.path}</div>
            <div className="text-sm text-text-muted mb-4">
              {mergePrompt.existingTrackCount != null
                ? <>The existing <code className="font-mono">.m3u8</code> has <span className="text-text-primary">{mergePrompt.existingTrackCount}</span> track{mergePrompt.existingTrackCount === 1 ? '' : 's'}.</>
                : <>Couldn't read the existing file's contents.</>}
              {' '}What should Save Now do?
            </div>
            <ul className="text-xs text-text-muted space-y-1 mb-4 list-disc pl-4">
              <li><strong>Merge</strong> — union of in-app + disk, de-duped by file path. Any disk-only tracks are also added back to the playlist in the app.</li>
              <li><strong>Overwrite</strong> — clobber the file with the current in-app list.</li>
            </ul>
            <div className="flex flex-wrap gap-2 justify-end">
              <button
                onClick={() => setMergePrompt(null)}
                className="text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-text-primary"
              >Cancel</button>
              <button
                onClick={() => doSave('overwrite')}
                className="text-xs px-3 py-1.5 rounded bg-red-500/80 hover:bg-red-500 text-white"
              >Overwrite</button>
              <button
                onClick={() => doSave('merge')}
                className="text-xs px-3 py-1.5 rounded bg-accent text-black font-semibold hover:bg-accent-hover"
              >Merge (de-duped)</button>
            </div>
          </div>
        </div>
      )}
      <div className="px-8 pb-10">
        <ScanProgressPanel />
        <div className="bg-bg-elev-1/40 rounded">
          <div className="grid grid-cols-[24px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.9fr)_92px_72px_40px] gap-3 px-4 py-2 border-b border-white/5">
            <div className="text-right text-text-muted text-xs">#</div>
            <SortHeader col="title" label="Title" sortBy={sortBy} sortDir={sortDir} onChange={setSort} />
            <SortHeader col="album" label="Album" sortBy={sortBy} sortDir={sortDir} onChange={setSort} />
            <SortHeader col="artist" label="Artist" sortBy={sortBy} sortDir={sortDir} onChange={setSort} />
            <div className="text-xs uppercase tracking-wide text-text-muted">Quality</div>
            <SortHeader col="duration" label="Length" sortBy={sortBy} sortDir={sortDir} onChange={setSort} align="right" />
            <div />
          </div>
          {sorted.map((t, i) => <TrackRow key={t.id} track={t} index={i} siblings={sorted} />)}
          {sorted.length === 0 && <div className="p-6 text-text-muted text-sm">No tracks yet.</div>}
        </div>
      </div>
    </section>
  );
}
