import { useNavigate } from 'react-router-dom';
import { usePlayer } from '../store/player';
import { mediaUrl } from '../lib/mediaUrl';

interface Props {
  album: {
    id: number;
    title: string;
    artist: string | null;
    year?: number | null;
    genre?: string | null;
    cover_art_path: string | null;
    bytes?: number;
    flac_count?: number;
    projected_mp3_savings?: number;
  };
  // Minimum % savings required to show the 🗜 badge. Default 5 (=5%).
  minSavingsPercent?: number;
}

export default function AlbumCard({ album, minSavingsPercent = 5 }: Props) {
  const nav = useNavigate();
  const play = usePlayer((s) => s.play);
  // Show badge when converting FLACs on this album would reclaim at least
  // minSavingsPercent of its total size. Zero FLACs ⇒ zero savings ⇒ never shown.
  const savingsPct =
    (album.bytes ?? 0) > 0
      ? ((album.projected_mp3_savings ?? 0) / album.bytes!) * 100
      : 0;
  const shrinkable = (album.flac_count ?? 0) > 0 && savingsPct >= minSavingsPercent;

  async function playAlbum(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const res: any = await window.mp.library.album(album.id);
    if (!res?.tracks?.length) return;
    play(
      res.tracks.map((t: any) => ({
        id: t.id, title: t.title, artist: t.artist, album: t.album,
        path: t.path, durationSec: t.duration_sec, coverArtPath: t.cover_art_path ?? null,
      })),
      0,
    );
  }

  return (
    <div
      onClick={() => nav(`/album/${album.id}`)}
      className="group relative bg-bg-elev-1 hover:bg-bg-elev-2 p-3 rounded cursor-pointer transition"
    >
      <div className="relative aspect-square w-full mb-2">
        {album.cover_art_path ? (
          <img src={mediaUrl(album.cover_art_path)} className="w-full h-full rounded" alt="" />
        ) : (
          <div className="w-full h-full rounded bg-bg-highlight" />
        )}
        <button
          onClick={playAlbum}
          className="absolute bottom-2 right-2 w-11 h-11 rounded-full bg-accent text-black flex items-center justify-center text-lg shadow-xl opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition hover:scale-105 hover:bg-accent-hover"
          title={`Play ${album.title}`}
        >▶</button>
        {shrinkable && (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); nav(`/album/${album.id}`); }}
            className="absolute top-2 left-2 w-8 h-8 rounded-full bg-yellow-500/90 text-black flex items-center justify-center shadow-lg hover:scale-105 transition"
            title={`Shrinkable — converting ${album.flac_count} FLAC→MP3 would save about ${Math.round(savingsPct)}% of this album's size`}
          >🗜</button>
        )}
      </div>
      <div className="text-sm truncate">{album.title}</div>
      <div className="text-xs text-text-muted truncate">
        {album.artist ?? '—'}
        {album.year ? ` · ${album.year}` : ''}
        {album.genre ? ` · ${album.genre}` : ''}
      </div>
    </div>
  );
}
