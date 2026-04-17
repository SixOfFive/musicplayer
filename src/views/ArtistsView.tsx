import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLibraryRefresh } from '../hooks/useLibraryRefresh';
import ScanProgressPanel from '../components/ScanProgressPanel';

interface ArtistRow {
  id: number;
  name: string;
  album_count: number;
  track_count: number;
}

export default function ArtistsView() {
  const [artists, setArtists] = useState<ArtistRow[]>([]);
  const [q, setQ] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'album_count' | 'track_count'>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const nav = useNavigate();

  const load = useCallback(() => { window.mp.library.artists().then(setArtists); }, []);
  useEffect(() => { load(); }, [load]);
  useLibraryRefresh(load);

  const filtered = useMemo(() => {
    const mul = sortDir === 'asc' ? 1 : -1;
    const needle = q.trim().toLowerCase();
    return artists
      .filter((a) => !needle || a.name.toLowerCase().includes(needle))
      .sort((a, b) => {
        if (sortBy === 'name') return a.name.localeCompare(b.name) * mul;
        return ((a as any)[sortBy] - (b as any)[sortBy]) * mul;
      });
  }, [artists, q, sortBy, sortDir]);

  return (
    <section className="p-8">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-3xl font-bold flex-1">Artists</h1>
        <input
          placeholder="Filter…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="bg-bg-elev-2 text-sm px-3 py-1.5 rounded-full outline-none focus:ring-1 focus:ring-white/30 w-48"
        />
        <select className="bg-bg-elev-2 px-2 py-1 rounded text-sm" value={sortBy} onChange={(e) => setSortBy(e.target.value as any)}>
          <option value="name">Name</option>
          <option value="album_count">Albums</option>
          <option value="track_count">Tracks</option>
        </select>
        <button onClick={() => setSortDir((d) => d === 'asc' ? 'desc' : 'asc')} className="bg-bg-elev-2 px-3 py-1 rounded text-sm">
          {sortDir === 'asc' ? '↑' : '↓'}
        </button>
      </div>

      <ScanProgressPanel />

      <ul className="divide-y divide-white/5 bg-bg-elev-1/40 rounded">
        {filtered.map((a) => (
          <li
            key={a.id}
            onClick={() => nav(`/artist/${a.id}`)}
            onDoubleClick={() => nav(`/artist/${a.id}`)}
            className="px-4 py-3 text-sm flex justify-between items-center hover:bg-white/5 cursor-pointer"
            title={`Open ${a.name}`}
          >
            <span className="text-text-primary font-medium">{a.name}</span>
            <span className="text-text-muted">
              {a.album_count.toLocaleString()} album{a.album_count === 1 ? '' : 's'} ·{' '}
              {a.track_count.toLocaleString()} track{a.track_count === 1 ? '' : 's'}
            </span>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="px-4 py-6 text-sm text-text-muted">
            {q ? `No artists match "${q}".` : 'No artists yet — run a scan.'}
          </li>
        )}
      </ul>
    </section>
  );
}
