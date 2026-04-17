import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import NowPlayingBar from './components/NowPlayingBar';
import FirstRun from './components/FirstRun';
import Home from './views/Home';
import LibraryView from './views/LibraryView';
import AlbumsView from './views/AlbumsView';
import ArtistsView from './views/ArtistsView';
import PlaylistView from './views/PlaylistView';
import Settings from './views/Settings';
import Visualizer from './views/Visualizer';
import { useLibrary } from './store/library';
import { usePlayer } from './store/player';

export default function App() {
  const refreshPlaylists = useLibrary((s) => s.refreshPlaylists);
  const setLikedIds = usePlayer((s) => s.setLikedIds);
  const [showFirstRun, setShowFirstRun] = useState(false);

  useEffect(() => {
    refreshPlaylists();
    window.mp.likes.list().then((ids: number[]) => setLikedIds(ids));
    window.mp.settings.get().then((s: any) => {
      if (!s.firstRunComplete) setShowFirstRun(true);
    });
  }, [refreshPlaylists, setLikedIds]);

  return (
    <div className="h-screen w-screen flex flex-col bg-black">
      <div className="flex-1 min-h-0 grid grid-cols-[260px_1fr]">
        <Sidebar />
        <div className="flex flex-col min-h-0 bg-bg-base rounded-tl-lg">
          <TopBar />
          <div className="flex-1 min-h-0 overflow-y-auto">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/library" element={<LibraryView />} />
              <Route path="/albums" element={<AlbumsView />} />
              <Route path="/artists" element={<ArtistsView />} />
              <Route path="/playlist/:id" element={<PlaylistView />} />
              <Route path="/visualizer" element={<Visualizer />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/:tab" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </div>
      </div>
      <NowPlayingBar />
      {showFirstRun && <FirstRun onDone={() => setShowFirstRun(false)} />}
    </div>
  );
}
