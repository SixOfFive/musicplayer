import { NavLink, useNavigate } from 'react-router-dom';
import { useLibrary } from '../store/library';
import { useRef, useState } from 'react';
import { LIKED_PLAYLIST_ID } from '../../shared/types';
import EqualizerPanel from './EqualizerPanel';

export default function Sidebar() {
  const playlists = useLibrary((s) => s.playlists);
  const refresh = useLibrary((s) => s.refreshPlaylists);
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [eqOpen, setEqOpen] = useState(false);
  // Guard against double-create when Enter triggers both keydown AND blur.
  const creatingLock = useRef(false);

  async function createPlaylist() {
    if (creatingLock.current) return;
    creatingLock.current = true;
    try {
      if (!newName.trim()) { setCreating(false); return; }
      const id = await window.mp.playlists.create(newName.trim());
      setNewName('');
      setCreating(false);
      await refresh();
      nav(`/playlist/${id}`);
    } finally {
      // Release on next tick so blur-after-enter doesn't slip through.
      setTimeout(() => { creatingLock.current = false; }, 100);
    }
  }

  return (
    <aside className="bg-bg-sidebar text-text-secondary flex flex-col min-h-0">
      <div className="titlebar-drag h-9 flex items-center px-4 text-xs text-text-muted">MusicPlayer</div>

      <nav className="px-3 pt-2 space-y-1">
        <NavItem to="/" label="Home" />
        <NavItem to="/library" label="Library" />
        <NavItem to="/albums" label="Albums" />
        <NavItem to="/artists" label="Artists" />
        <NavItem to="/playlists" label="Playlists" />
        <NavItem to="/visualizer" label="Visualizer" />
      </nav>

      <div className="px-3 mt-6 flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wider text-text-muted">Playlists</h3>
        <button
          className="text-text-muted hover:text-text-primary text-lg leading-none"
          onClick={() => setCreating(true)}
          title="New playlist"
        >+</button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-1 mt-2">
        {creating && (
          <div className="px-2 mb-2">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={createPlaylist}
              onKeyDown={(e) => e.key === 'Enter' && createPlaylist()}
              placeholder="New playlist"
              className="w-full bg-bg-elev-2 px-2 py-1 rounded text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        )}
        <NavLink
          to={`/playlist/${LIKED_PLAYLIST_ID}`}
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2 rounded hover:bg-bg-elev-1 ${isActive ? 'bg-bg-elev-1 text-text-primary' : ''}`
          }
        >
          <div className="w-10 h-10 rounded bg-gradient-to-br from-purple-700 to-blue-400 flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M12 21s-7-4.35-7-10a5 5 0 019-3 5 5 0 019 3c0 5.65-7 10-7 10z"/></svg>
          </div>
          <div className="min-w-0">
            <div className="text-sm text-text-primary truncate">Liked Songs</div>
            <div className="text-xs text-text-muted">
              {playlists.find((p) => p.id === LIKED_PLAYLIST_ID)?.trackCount ?? 0} songs
            </div>
          </div>
        </NavLink>

        {playlists.filter((p) => p.id !== LIKED_PLAYLIST_ID).map((p) => (
          <NavLink
            key={p.id}
            to={`/playlist/${p.id}`}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded hover:bg-bg-elev-1 ${isActive ? 'bg-bg-elev-1 text-text-primary' : ''}`
            }
          >
            <div className="w-10 h-10 rounded bg-bg-highlight flex items-center justify-center text-text-muted text-sm">♪</div>
            <div className="min-w-0">
              <div className="text-sm text-text-primary truncate">{p.name}</div>
              <div className="text-xs text-text-muted truncate">{p.trackCount} songs</div>
            </div>
          </NavLink>
        ))}
      </div>

      <div className="border-t border-white/5">
        <button
          onClick={() => setEqOpen((v) => !v)}
          className="w-full flex items-center justify-between px-3 py-2 text-xs uppercase tracking-wider text-text-muted hover:text-text-primary transition"
          title={eqOpen ? 'Hide equalizer' : 'Show equalizer'}
        >
          <span>Equalizer</span>
          <span>{eqOpen ? '▾' : '▸'}</span>
        </button>
        {eqOpen && <EqualizerPanel />}
      </div>
    </aside>
  );
}

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `block px-3 py-2 rounded text-sm font-medium hover:text-text-primary ${
          isActive ? 'text-text-primary bg-bg-elev-1' : ''
        }`
      }
    >
      {label}
    </NavLink>
  );
}
