import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import TrackRow, { type RowTrack } from '../components/TrackRow';
import { usePlayer } from '../store/player';
import { useLibraryRefresh } from '../hooks/useLibraryRefresh';
import { mediaUrl } from '../lib/mediaUrl';
import ShrinkAlbumButton from '../components/ShrinkAlbumButton';
import type { LibraryStats } from '../../shared/types';

interface AlbumMeta {
  id: number;
  title: string;
  artist: string | null;
  year: number | null;
  genre: string | null;
  cover_art_path: string | null;
}

export default function AlbumView() {
  const { id } = useParams();
  const aid = Number(id);
  const [album, setAlbum] = useState<AlbumMeta | null>(null);
  const [tracks, setTracks] = useState<RowTrack[]>([]);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const play = usePlayer((s) => s.play);

  const load = useCallback(() => {
    window.mp.library.album(aid).then((res: any) => {
      setAlbum(res.album);
      setTracks(res.tracks);
    });
    window.mp.library.stats().then(setStats).catch(() => {});
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

  if (!album) return <section className="p-8 text-text-muted">Loading…</section>;

  const totalSec = tracks.reduce((n, t) => n + (t.duration_sec ?? 0), 0);

  return (
    <section>
      <header className="flex gap-6 px-8 pt-8 pb-6 bg-gradient-to-b from-bg-elev-2 to-transparent">
        {album.cover_art_path ? (
          <img
            src={mediaUrl(album.cover_art_path)}
            className="w-56 h-56 rounded shadow-2xl flex-shrink-0"
            alt=""
          />
        ) : (
          <div className="w-56 h-56 rounded bg-bg-highlight flex-shrink-0" />
        )}
        <div className="flex flex-col justify-end min-w-0">
          <div className="text-xs uppercase tracking-wide text-text-muted">Album</div>
          <h1 className="text-6xl font-extrabold my-2 truncate">{album.title}</h1>
          <div className="text-sm text-text-secondary">
            <span className="font-semibold text-white">{album.artist ?? 'Unknown artist'}</span>
            {album.year ? <> · {album.year}</> : null}
            {album.genre ? <> · {album.genre}</> : null}
            {' · '}{tracks.length} tracks · {Math.floor(totalSec / 60)} min
          </div>
        </div>
      </header>

      <div className="px-8 pb-4 flex items-start gap-4 flex-wrap">
        <button
          onClick={() => playAll(0)}
          disabled={tracks.length === 0}
          className="w-14 h-14 rounded-full bg-accent hover:bg-accent-hover hover:scale-105 transition text-black flex items-center justify-center text-2xl font-bold shadow-lg"
          title="Play album"
        >▶</button>

        {(() => {
          const flacCount = tracks.filter((t) => /\.flac$/i.test(t.path)).length;
          const bytes = tracks.reduce((n, t: any) => n + (t.size ?? 0), 0);
          const threshold = stats?.albumSizeThresholdBytes ?? Number.MAX_SAFE_INTEGER;
          const oversized = bytes >= threshold;
          if (flacCount === 0) return null;
          // Always available from the album page — hide it only on tiny albums
          // that would free <20 MB, where the effort isn't worth it.
          const worthwhile = bytes > 20 * 1024 * 1024;
          if (!worthwhile) return null;
          return (
            <div className="flex flex-col gap-1">
              <ShrinkAlbumButton albumId={aid} albumTitle={album.title} flacCount={flacCount} bytes={bytes} />
              {oversized && (
                <div className="text-[10px] text-text-muted">
                  ↑ above the 66th-percentile album size — good candidate for conversion
                </div>
              )}
            </div>
          );
        })()}
      </div>

      <div className="px-8 pb-10">
        <div className="bg-bg-elev-1/40 rounded">
          <div className="grid grid-cols-[24px_1fr_1fr_1fr_60px_40px] gap-3 px-4 py-2 border-b border-white/5 text-xs uppercase tracking-wide text-text-muted">
            <div className="text-right">#</div>
            <div>Title</div>
            <div>Album</div>
            <div>Artist</div>
            <div className="text-right">Dur</div>
            <div />
          </div>
          {tracks.map((t, i) => <TrackRow key={t.id} track={t} index={i} siblings={tracks} />)}
          {tracks.length === 0 && <div className="p-6 text-text-muted text-sm">No tracks.</div>}
        </div>
      </div>
    </section>
  );
}

