import { useEffect, useState } from 'react';
import { usePlayer } from '../store/player';
import { useLibrary } from '../store/library';
import { LIKED_PLAYLIST_ID } from '../../shared/types';
import { mediaUrl } from '../lib/mediaUrl';

export interface RowTrack {
  id: number;
  path: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration_sec: number | null;
  cover_art_path?: string | null;
  size?: number;
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

  return (
    <>
      <div
        onClick={playHere}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
        className="grid grid-cols-[24px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_72px_40px] gap-3 items-center px-4 py-2 text-sm rounded hover:bg-white/5 cursor-pointer select-none"
      >
        <div className="text-text-muted text-right">{index + 1}</div>
        <div className="min-w-0 flex items-center gap-3">
          {track.cover_art_path ? (
            <img src={mediaUrl(track.cover_art_path)} className="w-9 h-9 rounded flex-shrink-0" alt="" />
          ) : <div className="w-9 h-9 rounded bg-bg-highlight flex-shrink-0" />}
          <div className="min-w-0">
            <div className="truncate text-text-primary">{track.title}</div>
            <div className="truncate text-xs text-text-muted">{track.artist ?? ''}</div>
          </div>
        </div>
        <div className="min-w-0 truncate text-text-secondary">{track.album ?? ''}</div>
        <div className="min-w-0 truncate text-text-muted">{track.artist ?? ''}</div>
        <div className="text-text-secondary text-right tabular-nums">{fmt(track.duration_sec)}</div>
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
