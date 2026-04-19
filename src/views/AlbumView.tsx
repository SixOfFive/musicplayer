import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import TrackRow, { type RowTrack } from '../components/TrackRow';
import { usePlayer } from '../store/player';
import { useLibraryRefresh } from '../hooks/useLibraryRefresh';
import { mediaUrl } from '../lib/mediaUrl';
import ShrinkAlbumButton from '../components/ShrinkAlbumButton';
import MiniVisualizer from '../components/MiniVisualizer';
import { formatBytes } from '../hooks/useScanProgress';

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
  const nav = useNavigate();
  const [album, setAlbum] = useState<AlbumMeta | null>(null);
  const [tracks, setTracks] = useState<RowTrack[]>([]);
  const [rescan, setRescan] = useState<null | { running: boolean; result?: { added: number; updated: number; removed: number; errors: number; message: string; albumDeleted: boolean } }>(null);
  const play = usePlayer((s) => s.play);

  const load = useCallback(() => {
    window.mp.library.album(aid).then((res: any) => {
      setAlbum(res.album);
      setTracks(res.tracks);
    });
  }, [aid]);

  useEffect(() => { load(); }, [load]);
  useLibraryRefresh(load);

  /**
   * Re-scan just this album's folder(s): re-read tags on every audio file,
   * pick up new tracks that were dropped in, and remove rows for files that
   * have been deleted. Cheaper than a whole-library scan. Button is in the
   * action row next to Play / Shrink.
   */
  async function runRescan() {
    setRescan({ running: true });
    try {
      const result = await (window.mp.scan as any).album(aid);
      setRescan({ running: false, result });
      if (result?.albumDeleted) {
        // Every track got removed — no album to show anymore. Kick the user
        // back to the album grid rather than leave them on a 404-in-progress.
        window.dispatchEvent(new CustomEvent('mp-library-changed'));
        setTimeout(() => nav('/albums'), 1500);
      } else {
        // Re-fetch album + tracks so the UI reflects new metadata, added/
        // removed tracks, etc.
        load();
        window.dispatchEvent(new CustomEvent('mp-library-changed'));
      }
    } catch (err: any) {
      setRescan({ running: false, result: { added: 0, updated: 0, removed: 0, errors: 1, message: err?.message ?? 'Rescan failed', albumDeleted: false } });
    }
  }

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
        <div className="flex flex-col justify-end min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wide text-text-muted">Album</div>
          <h1 className="text-6xl font-extrabold my-2 truncate">{album.title}</h1>
          <div className="text-sm text-text-secondary">
            <span className="font-semibold text-white">{album.artist ?? 'Unknown artist'}</span>
            {album.year ? <> · {album.year}</> : null}
            {album.genre ? <> · {album.genre}</> : null}
            {' · '}{tracks.length} tracks · {Math.floor(totalSec / 60)} min
          </div>
        </div>
        <MiniVisualizer className="hidden md:block w-64 h-36 flex-shrink-0 self-end" />
      </header>

      <div className="px-8 pb-4 flex items-start gap-4 flex-wrap">
        <button
          onClick={() => playAll(0)}
          disabled={tracks.length === 0}
          className="w-14 h-14 rounded-full bg-accent hover:bg-accent-hover hover:scale-105 transition text-black flex items-center justify-center text-2xl font-bold shadow-lg"
          title="Play album"
        >▶</button>

        <div className="flex flex-col gap-1">
          <button
            onClick={runRescan}
            disabled={rescan?.running}
            className="px-4 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-sm inline-flex items-center gap-2 disabled:opacity-50"
            title="Re-read tags on every file in this album's folder, pick up new tracks, and remove entries for deleted files"
          >
            {rescan?.running ? (
              <>
                <span className="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                Rescanning…
              </>
            ) : (
              <>↻ Rescan album</>
            )}
          </button>
          {rescan?.result && (
            <div className={`text-[10px] ${rescan.result.errors > 0 ? 'text-red-400' : 'text-text-muted'}`}>
              {rescan.result.message}
            </div>
          )}
        </div>

        {(() => {
          const flacCount = tracks.filter((t) => /\.flac$/i.test(t.path)).length;
          if (flacCount === 0) return null;
          const bytes = tracks.reduce((n, t: any) => n + (t.size ?? 0), 0);
          const flacBytes = tracks
            .filter((t) => /\.flac$/i.test(t.path))
            .reduce((n, t: any) => n + (t.size ?? 0), 0);
          // Same estimate used by the library query: V0 MP3 ≈ 35% of FLAC size.
          const projectedSavings = flacBytes * 0.65;
          const savingsPct = bytes > 0 ? (projectedSavings / bytes) * 100 : 0;
          // Always show the button on the album page so users can force-convert
          // even small albums, but label it with the projected savings so they
          // can see whether it's worth it.
          return (
            <div className="flex flex-col gap-1">
              <ShrinkAlbumButton albumId={aid} albumTitle={album.title} flacCount={flacCount} bytes={bytes} />
              <div className="text-[10px] text-text-muted">
                Estimated savings: ~{formatBytes(projectedSavings)} ({savingsPct.toFixed(1)}% of album)
              </div>
            </div>
          );
        })()}
      </div>

      <div className="px-8 pb-10">
        <div className="bg-bg-elev-1/40 rounded">
          <div className="grid grid-cols-[24px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_72px_40px] gap-3 px-4 py-2 border-b border-white/5 text-xs uppercase tracking-wide text-text-muted">
            <div className="text-right">#</div>
            <div>Title</div>
            <div>Album</div>
            <div>Artist</div>
            <div className="text-right">Length</div>
            <div />
          </div>
          {tracks.map((t, i) => <TrackRow key={t.id} track={t} index={i} siblings={tracks} />)}
          {tracks.length === 0 && <div className="p-6 text-text-muted text-sm">No tracks.</div>}
        </div>
      </div>
    </section>
  );
}

