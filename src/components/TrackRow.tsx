import { useEffect, useState } from 'react';
import { usePlayer } from '../store/player';
import { useLibrary } from '../store/library';
import { LIKED_PLAYLIST_ID } from '../../shared/types';
import { mediaUrl } from '../lib/mediaUrl';
import { formatQuality } from '../lib/formatQuality';

export interface RowTrack {
  id: number;
  path: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration_sec: number | null;
  cover_art_path?: string | null;
  size?: number;
  // Quality fields — optional because not every code path has pulled
  // them yet. When present, TrackRow shows a compact quality label
  // (e.g. "FLAC 96 kHz" / "MP3 320k") next to the artist subtitle.
  codec?: string | null;
  bitrate?: number | null;       // bits per second
  sample_rate?: number | null;   // Hz
}

function fmt(sec: number | null) {
  if (!sec) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function TrackRow({
  track, index, siblings,
}: { track: RowTrack; index: number; siblings: RowTrack[] }) {
  const play = usePlayer((s) => s.play);
  const liked = usePlayer((s) => s.likedIds.has(track.id));
  const toggleLike = usePlayer((s) => s.toggleLike);
  // Highlight-when-playing: subscribe to a narrow slice (the current
  // track's id) so a row only re-renders when IT becomes active or
  // stops being active, not on every scrubber tick.
  const isNowPlaying = usePlayer((s) => {
    const cur = s.queue[s.index];
    return !!cur && cur.id === track.id;
  });
  const playlists = useLibrary((s) => s.playlists);
  const refreshPlaylists = useLibrary((s) => s.refreshPlaylists);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [allowDelete, setAllowDelete] = useState(false);

  useEffect(() => {
    if (menu) window.mp.settings.get().then((s: any) => setAllowDelete(!!s.library?.allowFileDeletion));
  }, [menu]);

  const playHere = () =>
    play(
      siblings.map((t) => ({
        id: t.id, title: t.title, artist: t.artist, album: t.album,
        path: t.path, durationSec: t.duration_sec, coverArtPath: t.cover_art_path ?? null,
      })),
      index,
    );

  async function addTo(playlistId: number) {
    await window.mp.playlists.addTracks(playlistId, [track.id]);
    await refreshPlaylists();
    window.dispatchEvent(new CustomEvent('mp-library-changed'));
    setMenu(null);
  }

  async function addToNewPlaylist() {
    const name = prompt('New playlist name')?.trim();
    if (!name) return;
    const id = await window.mp.playlists.create(name);
    await window.mp.playlists.addTracks(id, [track.id]);
    await refreshPlaylists();
    setMenu(null);
  }

  async function removeFromLibrary(deleteFile: boolean) {
    const msg = deleteFile
      ? `Move "${track.title}" to the system trash AND remove it from the library?`
      : `Remove "${track.title}" from the library (file stays on disk)?`;
    if (!confirm(msg)) return;
    const res: any = await window.mp.library.deleteTrack(track.id, deleteFile);
    if (!res.ok) { alert(res.error ?? 'Failed'); return; }
    setMenu(null);
    // A DB refresh is implied — caller re-fetches on nav; emit a window event for siblings.
    window.dispatchEvent(new CustomEvent('mp-library-changed'));
  }

  // Derive the A-Z bucket from the track title so the AlphaRail can jump
  // to this row. Inline the same normalisation AlphaRail uses to avoid a
  // cross-import cycle between a low-level presentational component and
  // a view-level chrome component.
  const alphaLetter = (() => {
    const s = (track.title ?? '').trim().replace(/^[^\p{L}\p{N}]+/u, '');
    const c = s.charAt(0);
    return /^[A-Za-z]$/.test(c) ? c.toUpperCase() : '#';
  })();

  return (
    <>
      <div
        onClick={playHere}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
        data-alpha-letter={alphaLetter}
        className={`grid grid-cols-[24px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.9fr)_92px_72px_40px] gap-3 items-center px-4 py-2 text-sm rounded cursor-pointer select-none ${
          isNowPlaying
            ? 'bg-emerald-500/15 hover:bg-emerald-500/20 ring-1 ring-emerald-500/30'
            : 'hover:bg-white/5'
        }`}
      >
        {/* Track # → ▸ glyph when this row is the current track. The
            pulse draws the eye without being a full animation — Spotify
            + Apple Music both do a similar thing. */}
        <div className={`text-right ${isNowPlaying ? 'text-emerald-400' : 'text-text-muted'}`}>
          {isNowPlaying ? '▸' : index + 1}
        </div>
        <div className="min-w-0 flex items-center gap-3">
          {track.cover_art_path ? (
            // loading="lazy": Library / Playlist / Liked Songs can be
            // thousands of rows; Chromium only fetches once the row is
            // scrolled near the viewport.
            <img src={mediaUrl(track.cover_art_path)} loading="lazy" decoding="async" className="w-9 h-9 rounded flex-shrink-0" alt="" />
          ) : <div className="w-9 h-9 rounded bg-bg-highlight flex-shrink-0" />}
          <div className="min-w-0">
            <div className={`truncate ${isNowPlaying ? 'text-emerald-300 font-medium' : 'text-text-primary'}`}>{track.title}</div>
            <div className="truncate text-xs text-text-muted">{track.artist ?? ''}</div>
          </div>
        </div>
        <div className="min-w-0 truncate text-text-secondary">{track.album ?? ''}</div>
        <div className="min-w-0 truncate text-text-muted">{track.artist ?? ''}</div>
        {/* Dedicated Quality column — previous attempt to inline this
            inside the artist subtitle got eaten by the parent's
            `truncate`. A fixed-width column ensures the chip is
            always visible, truncating its own content if a codec
            name somehow gets too long. */}
        <div className="min-w-0 truncate text-xs text-text-muted tabular-nums" title="Format / bitrate / sample rate">
          {formatQuality(track.codec, track.bitrate, track.sample_rate) ?? ''}
        </div>
        <div className={`text-right tabular-nums ${isNowPlaying ? 'text-emerald-400' : 'text-text-secondary'}`}>{fmt(track.duration_sec)}</div>
        <button
          onClick={(e) => { e.stopPropagation(); toggleLike(track.id); }}
          className={`text-lg ${liked ? 'text-accent' : 'text-text-muted hover:text-text-primary'}`}
          title={liked ? 'Unlike' : 'Like'}
        >{liked ? '♥' : '♡'}</button>
      </div>

      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} />
          <div
            className="fixed z-50 bg-bg-elev-2 border border-white/10 rounded shadow-lg py-1 text-sm w-56"
            style={{ left: menu.x, top: menu.y }}
          >
            <MenuItem onClick={playHere}>Play</MenuItem>
            <MenuItem onClick={() => { toggleLike(track.id); setMenu(null); }}>
              {liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}
            </MenuItem>
            <div className="border-t border-white/10 my-1" />
            <div className="px-3 py-1 text-xs text-text-muted">Add to playlist</div>
            <MenuItem onClick={addToNewPlaylist}>+ New playlist…</MenuItem>
            <MenuItem onClick={() => addTo(LIKED_PLAYLIST_ID)}>Liked Songs</MenuItem>
            <div className="max-h-56 overflow-y-auto">
              {playlists.filter((p) => p.id !== LIKED_PLAYLIST_ID).map((p) => (
                <MenuItem key={p.id} onClick={() => addTo(p.id)}>{p.name}</MenuItem>
              ))}
            </div>
            <div className="border-t border-white/10 my-1" />
            <MenuItem onClick={() => removeFromLibrary(false)}>Remove from library</MenuItem>
            {allowDelete && (
              <MenuItem onClick={() => removeFromLibrary(true)}>
                <span className="text-red-400">Delete file (move to trash)</span>
              </MenuItem>
            )}
          </div>
        </>
      )}
    </>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="block w-full text-left px-3 py-1.5 hover:bg-white/10 text-text-primary"
    >{children}</button>
  );
}
