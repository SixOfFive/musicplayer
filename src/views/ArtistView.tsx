import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import TrackRow, { type RowTrack } from '../components/TrackRow';
import AlbumCard from '../components/AlbumCard';
import { usePlayer } from '../store/player';
import { useLibraryRefresh } from '../hooks/useLibraryRefresh';
import ScanProgressPanel from '../components/ScanProgressPanel';

interface Artist {
  id: number;
  name: string;
  album_count: number;
  track_count: number;
  total_duration_sec: number;
}

interface AlbumRow {
  id: number;
  title: string;
  year: number | null;
  genre: string | null;
  cover_art_path: string | null;
  track_count: number;
  bytes?: number;
  duration_sec?: number;
}

function formatDur(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function ArtistView() {
  const { id } = useParams();
  const aid = Number(id);
  const [artist, setArtist] = useState<Artist | null>(null);
  const [albums, setAlbums] = useState<AlbumRow[]>([]);
  const [tracks, setTracks] = useState<RowTrack[]>([]);
  const play = usePlayer((s) => s.play);

  const load = useCallback(() => {
    window.mp.library.artist(aid).then((res: any) => {
      setArtist(res.artist);
      setAlbums(res.albums);
      setTracks(res.tracks);
    });
  }, [aid]);

  useEffect(() => { load(); }, [load]);
  useLibraryRefresh(load);

  function playAll(startIndex = 0) {
    if (tracks.length === 0) return;
    play(
      tracks.map((t) => ({
        id: t.id, title: t.title, artist: t.artist, album: t.album,
        path: t.path, durationSec: t.duration_sec, coverArtPath: t.cover_art_path ?? null,
      })),
      startIndex,
    );
  }

  if (!artist) return <section className="p-8 text-text-muted">Loading…</section>;

  return (
    <section>
      <header className="px-8 pt-8 pb-6 bg-gradient-to-b from-bg-elev-2 to-transparent">
        <div className="text-xs uppercase tracking-wide text-text-muted">Artist</div>
        <h1 className="text-6xl font-extrabold my-2">{artist.name}</h1>
        <div className="text-sm text-text-secondary">
          {artist.album_count.toLocaleString()} album{artist.album_count === 1 ? '' : 's'} · {artist.track_count.toLocaleString()} track{artist.track_count === 1 ? '' : 's'} · {formatDur(artist.total_duration_sec)}
        </div>
      </header>

      <div className="px-8 pb-4">
        <button
          onClick={() => playAll(0)}
          disabled={tracks.length === 0}
          className="w-14 h-14 rounded-full bg-accent hover:bg-accent-hover hover:scale-105 transition text-black flex items-center justify-center text-2xl font-bold shadow-lg"
          title="Play all"
        >▶</button>
      </div>

      <ScanProgressPanel />

      {/* Albums grid */}
      {albums.length > 0 && (
        <div className="px-8 pb-8">
          <h2 className="text-xl font-semibold mb-4">Albums</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
            {albums.map((a) => (
              <AlbumCard key={a.id} album={{
                id: a.id, title: a.title, artist: artist.name,
                year: a.year, genre: a.genre, cover_art_path: a.cover_art_path,
                // Pass the aggregate fields (added to the artist query) so
                // AlbumCard's hover tooltip can show track/runtime/size.
                track_count: a.track_count,
                bytes: a.bytes,
                duration_sec: a.duration_sec,
              }} />
            ))}
          </div>
        </div>
      )}

      {/* Tracks list */}
      {tracks.length > 0 && (
        <div className="px-8 pb-10">
          <h2 className="text-xl font-semibold mb-4">All tracks</h2>
          <div className="bg-bg-elev-1/40 rounded">
            <div className="grid grid-cols-[24px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.9fr)_92px_72px_40px] gap-3 px-4 py-2 border-b border-white/5 text-xs uppercase tracking-wide text-text-muted">
              <div className="text-right">#</div>
              <div>Title</div>
              <div>Album</div>
              <div>Artist</div>
              <div>Quality</div>
              <div className="text-right">Length</div>
              <div />
            </div>
            {tracks.map((t, i) => <TrackRow key={t.id} track={t} index={i} siblings={tracks} />)}
          </div>
        </div>
      )}

      {tracks.length === 0 && albums.length === 0 && (
        <div className="px-8 pb-10 text-text-muted">No tracks for this artist yet.</div>
      )}
    </section>
  );
}
