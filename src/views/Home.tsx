import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLibraryRefresh } from '../hooks/useLibraryRefresh';
import ScanProgressPanel from '../components/ScanProgressPanel';

export default function Home() {
  const [albums, setAlbums] = useState<any[]>([]);
  const load = useCallback(() => { window.mp.library.albums({ limit: 12 }).then(setAlbums); }, []);
  useEffect(() => { load(); }, [load]);
  useLibraryRefresh(load);

  return (
    <section className="p-8">
      <h1 className="text-3xl font-bold mb-6">Good evening</h1>
      <ScanProgressPanel />
      <h2 className="text-xl font-semibold mb-4">Recently added</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
        {albums.map((a) => (
          <Link key={a.id} to={`/playlist/${a.id}`} className="bg-bg-elev-1 hover:bg-bg-elev-2 p-3 rounded">
            {a.cover_art_path ? (
              <img src={`mp-media:///${encodeURIComponent(a.cover_art_path)}`} className="aspect-square w-full rounded mb-2" alt="" />
            ) : <div className="aspect-square w-full rounded mb-2 bg-bg-highlight" />}
            <div className="text-sm truncate">{a.title}</div>
            <div className="text-xs text-text-muted truncate">{a.artist}</div>
          </Link>
        ))}
        {albums.length === 0 && (
          <div className="col-span-full text-text-muted text-sm">
            No music yet. Go to <Link to="/settings/library" className="text-accent">Settings → Library</Link> and add a folder.
          </div>
        )}
      </div>
    </section>
  );
}
