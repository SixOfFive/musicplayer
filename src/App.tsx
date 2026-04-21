import { useEffect, useRef, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useScrollRestoration } from './hooks/useScrollRestoration';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import NowPlayingBar from './components/NowPlayingBar';
import FirstRun from './components/FirstRun';
import ArtStatusStrip from './components/ArtStatusStrip';
import UpdateBanner from './components/UpdateBanner';
import Home from './views/Home';
import LibraryView from './views/LibraryView';
import AlbumsView from './views/AlbumsView';
import AlbumView from './views/AlbumView';
import ArtistsView from './views/ArtistsView';
import ArtistView from './views/ArtistView';
import PlaylistView from './views/PlaylistView';
import PlaylistsView from './views/PlaylistsView';
import RadioView from './views/RadioView';
import LastFmView from './views/LastFmView';
import SearchView from './views/SearchView';
import Settings from './views/Settings';
import SuggestedView from './views/SuggestedView';
import Visualizer from './views/Visualizer';
import { useLibrary } from './store/library';
import { usePlayer } from './store/player';
// Side-effect import: wires the global IPC listener for convert:progress
// events so the Shrink-album progress bar survives navigation. Importing
// here (instead of relying on ShrinkAlbumButton to pull it in first)
// guarantees the subscription is live for the entire app lifetime.
import './store/convert';

export default function App() {
  const refreshPlaylists = useLibrary((s) => s.refreshPlaylists);
  const setLikedIds = usePlayer((s) => s.setLikedIds);
  const [showFirstRun, setShowFirstRun] = useState(false);
  const mainRef = useRef<HTMLDivElement | null>(null);
  useScrollRestoration(mainRef);

  useEffect(() => {
    refreshPlaylists();
    window.mp.likes.list().then((ids: number[]) => setLikedIds(ids));
    window.mp.settings.get().then((s: any) => {
      if (!s.firstRunComplete) setShowFirstRun(true);
    });
  }, [refreshPlaylists, setLikedIds]);

  return (
    <div className="h-screen w-screen flex flex-col bg-black">
      <UpdateBanner />
      <div className="flex-1 min-h-0 grid grid-cols-[260px_minmax(0,1fr)]">
        <Sidebar />
        <div className="flex flex-col min-h-0 min-w-0 bg-bg-base rounded-tl-lg">
          <TopBar />
          <div ref={mainRef} className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/library" element={<LibraryView />} />
              <Route path="/albums" element={<AlbumsView />} />
              <Route path="/album/:id" element={<AlbumView />} />
              <Route path="/artists" element={<ArtistsView />} />
              <Route path="/artist/:id" element={<ArtistView />} />
              <Route path="/playlists" element={<PlaylistsView />} />
              <Route path="/playlist/:id" element={<PlaylistView />} />
              <Route path="/search" element={<SearchView />} />
              <Route path="/suggested" element={<SuggestedView />} />
              <Route path="/radio" element={<RadioView />} />
              <Route path="/lastfm" element={<LastFmView />} />
              <Route path="/visualizer" element={<Visualizer />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/:tab" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </div>
      </div>
      <ArtStatusStrip />
      <NowPlayingBar />
      {showFirstRun && <FirstRun onDone={() => setShowFirstRun(false)} />}
    </div>
  );
}
