import { useNavigate } from 'react-router-dom';
import { usePlayer } from '../store/player';
import { mediaUrl } from '../lib/mediaUrl';
import { firstLetter } from './AlphaRail';
import { formatBytes } from '../hooks/useScanProgress';

interface Props {
  album: {
    id: number;
    title: string;
    artist: string | null;
    year?: number | null;
    genre?: string | null;
    cover_art_path: string | null;
    bytes?: number;
    track_count?: number;
    duration_sec?: number;
    flac_count?: number;
    projected_mp3_savings?: number;
  };
  // Minimum % savings required to show the 🗜 badge. Default 5 (=5%).
  minSavingsPercent?: number;
}

/**
 * Format a duration in seconds as "Xh Ym" for albums (hours ≥ 1) or
 * "Ym Zs" for shorter items. Returns null on missing/zero so callers
 * can hide the field entirely. Matches the style used in the album
 * header metadata line so hover tooltips look consistent with the
 * page content.
 */
function formatDuration(sec: number | null | undefined): string | null {
  if (!sec || sec <= 0) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
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

  // Multi-line hover tooltip. The browser renders `\n` inside a `title`
  // attribute as line breaks on most platforms (Chromium / Electron
  // definitely), which is exactly what we want: album, artist, year,
  // genre, then the "numbers" bundle — track count, runtime, on-disk
  // size. Skip lines for fields we don't have so the tooltip doesn't
  // advertise missing data.
  const tooltipLines: string[] = [album.title];
  if (album.artist) tooltipLines.push(album.artist);
  const yearGenre = [album.year, album.genre].filter(Boolean).join(' · ');
  if (yearGenre) tooltipLines.push(yearGenre);
  const statsBits: string[] = [];
  if (typeof album.track_count === 'number' && album.track_count > 0) {
    statsBits.push(`${album.track_count} track${album.track_count === 1 ? '' : 's'}`);
  }
  const dur = formatDuration(album.duration_sec);
  if (dur) statsBits.push(dur);
  if (typeof album.bytes === 'number' && album.bytes > 0) statsBits.push(formatBytes(album.bytes));
  if (statsBits.length > 0) tooltipLines.push(statsBits.join(' · '));
  const tooltip = tooltipLines.join('\n');

  return (
    <div
      onClick={() => nav(`/album/${album.id}`)}
      // `data-alpha-letter` lets AlphaRail jump to the start of each letter's
      // section via querySelector, without needing a ref per card. Safe to
      // add unconditionally — the browser ignores unrecognised data-attrs.
      data-alpha-letter={firstLetter(album.title)}
      title={tooltip}
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
