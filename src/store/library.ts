import { create } from 'zustand';
import type { Playlist } from '../../shared/types';

interface LibState {
  playlists: Playlist[];
  refreshPlaylists: () => Promise<void>;
}

export const useLibrary = create<LibState>((set) => ({
  playlists: [],
  async refreshPlaylists() {
    const list = await window.mp.playlists.list();
    set({ playlists: list as Playlist[] });
  },
}));
