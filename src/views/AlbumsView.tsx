import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AlbumSort, SortDir } from '../../shared/types';
import { useLibraryRefresh } from '../hooks/useLibraryRefresh';
import ScanProgressPanel from '../components/ScanProgressPanel';

export default function AlbumsView() {
  const [albums, setAlbums] = useState<any[]>([]);
  const [sortBy, setSortBy] = useState<AlbumSort>('title');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [genreFilter, setGenreFilter] = useState<string>('');

  const load = useCallback(() => {
    window.mp.library.albums({ limit: 1000, sortBy, sortDir, genre: genreFilter || undefined }).then(setAlbums);
  }, [sortBy, sortDir, genreFilter]);

  useEffect(() => { load(); }, [load]);
  useLibraryRefresh(load);

  const genres = useMemo(() => {
    const set = new Set<string>();
    for (const a of albums) if (a.genre) set.add(a.genre);
    return [...set].sort();
  }, [albums]);

  return (
    <section className="p-8">
      <ScanProgressPanel />
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-3xl font-bold flex-1">Albums</h1>
        <select className="bg-bg-elev-2 px-2 py-1 rounded text-sm" value={genreFilter} onChange={(e) => setGenreFilter(e.target.value)}>
          <option value="">All genres</option>
          {genres.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select className="bg-bg-elev-2 px-2 py-1 rounded text-sm" value={sortBy} onChange={(e) => setSortBy(e.target.value as AlbumSort)}>
          <option value="title">Title</option>
          <option value="artist">Artist</option>
          <option value="year">Year</option>
          <option value="genre">Genre</option>
          <option value="track_count">Tracks</option>
        </select>
        <button onClick={() => setSortDir((d) => d === 'asc' ? 'desc' : 'asc')} className="bg-bg-elev-2 px-3 py-1 rounded text-sm">
          {sortDir === 'asc' ? '↑' : '↓'}
        </button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
        {albums.map((a) => (
          <div key={a.id} className="bg-bg-elev-1 hover:bg-bg-elev-2 p-3 rounded group relative">
            {a.cover_art_path ? (
              <img src={`mp-media:///${encodeURIComponent(a.cover_art_path)}`} className="aspect-square w-full rounded mb-2" alt="" />
            ) : <div className="aspect-square w-full rounded mb-2 bg-bg-highlight" />}
            <div className="text-sm truncate">{a.title}</div>
            <div className="text-xs text-text-muted truncate">
              {a.artist}{a.year ? ` · ${a.year}` : ''}{a.genre ? ` · ${a.genre}` : ''}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
