import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import TrackRow, { type RowTrack } from '../components/TrackRow';
import SortHeader from '../components/SortHeader';
import type { TrackSort, SortDir } from '../../shared/types';
import { useLibraryRefresh } from '../hooks/useLibraryRefresh';
import ScanProgressPanel from '../components/ScanProgressPanel';

export default function LibraryView() {
  const [params] = useSearchParams();
  const [tracks, setTracks] = useState<RowTrack[]>([]);
  const [sortBy, setSortBy] = useState<TrackSort>('date_added');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const q = params.get('q') ?? '';

  const load = useCallback(() => {
    window.mp.library.tracks({ limit: 1000, query: q || undefined, sortBy, sortDir }).then(setTracks);
  }, [q, sortBy, sortDir]);

  useEffect(() => { load(); }, [load]);
  useLibraryRefresh(load);

  const setSort = (c: TrackSort, d: SortDir) => { setSortBy(c); setSortDir(d); };

  return (
    <section className="p-8">
      <h1 className="text-3xl font-bold mb-6">{q ? `Results for "${q}"` : 'All tracks'}</h1>
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
        {tracks.map((t, i) => <TrackRow key={t.id} track={t} index={i} siblings={tracks} />)}
        {tracks.length === 0 && (
          <div className="p-6 text-sm text-text-muted">Nothing yet — add folders in Settings and run a scan.</div>
        )}
      </div>
    </section>
  );
}
