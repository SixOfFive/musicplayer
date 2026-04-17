import { useCallback, useEffect, useState } from 'react';
import { useLibraryRefresh } from '../hooks/useLibraryRefresh';
import ScanProgressPanel from '../components/ScanProgressPanel';

export default function ArtistsView() {
  const [artists, setArtists] = useState<any[]>([]);
  const load = useCallback(() => { window.mp.library.artists().then(setArtists); }, []);
  useEffect(() => { load(); }, [load]);
  useLibraryRefresh(load);
  return (
    <section className="p-8">
      <h1 className="text-3xl font-bold mb-6">Artists</h1>
      <ScanProgressPanel />
      <ul className="divide-y divide-white/5 bg-bg-elev-1/40 rounded">
        {artists.map((a) => (
          <li key={a.id} className="px-4 py-3 text-sm flex justify-between hover:bg-white/5">
            <span>{a.name}</span>
            <span className="text-text-muted">{a.album_count} albums · {a.track_count} tracks</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
