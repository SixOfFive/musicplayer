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

  const load = useCallback(() => {
    window.mp.playlists.get(pid).then((res: any) => {
      setMeta({ name: res.playlist.name ?? 'Playlist', description: res.playlist.description ?? null });
      setTracks(res.tracks);
    });
  }, [pid]);

  useEffect(() => { load(); }, [load]);
  useLibraryRefresh(load);

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
        </div>
        <MiniVisualizer className="hidden md:block w-64 h-36 flex-shrink-0 self-end" />
      </header>
      <div className="px-8 pb-10">
        <ScanProgressPanel />
        <div className="bg-bg-elev-1/40 rounded">
          <div className="grid grid-cols-[24px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_72px_40px] gap-3 px-4 py-2 border-b border-white/5">
            <div className="text-right text-text-muted text-xs">#</div>
            <SortHeader col="title" label="Title" sortBy={sortBy} sortDir={sortDir} onChange={setSort} />
            <SortHeader col="album" label="Album" sortBy={sortBy} sortDir={sortDir} onChange={setSort} />
            <SortHeader col="artist" label="Artist" sortBy={sortBy} sortDir={sortDir} onChange={setSort} />
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
