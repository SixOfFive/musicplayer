import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLibraryRefresh } from '../hooks/useLibraryRefresh';
import ScanProgressPanel from '../components/ScanProgressPanel';
import LibraryStatsPanel from '../components/LibraryStatsPanel';
import AlbumCard from '../components/AlbumCard';
import { usePlayer } from '../store/player';
import { mediaUrl } from '../lib/mediaUrl';
import type { LibraryStats } from '../../shared/types';

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

// How many newest-album tiles to show when the section is collapsed vs
// expanded. 12 fills two rows at xl width; 96 is a generous "see my whole
// recent crop" view — eight times as many without being overwhelming.
const NEWEST_COLLAPSED = 12;
const NEWEST_EXPANDED = 96;

export default function Home() {
  const [albums, setAlbums] = useState<any[]>([]);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [newestExpanded, setNewestExpanded] = useState(false);
  const play = usePlayer((s) => s.play);
  const nav = useNavigate();

  async function playRecent(trackId: number) {
    if (!stats) return;
    const queue = stats.mostRecentlyAdded.map((t) => ({
      id: t.id, title: t.title, artist: t.artist, album: t.album,
      path: '', durationSec: null, coverArtPath: t.coverArtPath,
    }));
    // Load full track rows so we have the file paths (stats payload omits them).
    const full = await window.mp.library.tracks({ limit: 100, sortBy: 'date_added', sortDir: 'desc' });
    const paths = new Map<number, any>((full as any[]).map((r: any) => [r.id, r]));
    const hydrated = queue
      .map((q) => {
        const r = paths.get(q.id);
        return r ? { ...q, path: r.path, durationSec: r.duration_sec } : null;
      })
      .filter(Boolean) as any[];
    const startIndex = hydrated.findIndex((t) => t.id === trackId);
    if (startIndex < 0 || hydrated.length === 0) return;
    play(hydrated, startIndex);
    nav('/');
  }

  const load = useCallback(() => {
    // Always fetch the expanded count from the backend — it's cheap (a single
    // indexed SELECT) and lets the "Show more" toggle flip instantly without
    // a round-trip. Slicing happens in the render.
    window.mp.library.albums({ limit: NEWEST_EXPANDED, sortBy: 'date_added', sortDir: 'desc' }).then(setAlbums);
    window.mp.library.stats().then(setStats);
  }, []);
  useEffect(() => { load(); }, [load]);
  useLibraryRefresh(load);

  const hasLibrary = (stats?.trackCount ?? 0) > 0;

  return (
    <section className="p-8">
      <h1 className="text-3xl font-bold mb-6">{greeting()}</h1>

      <ScanProgressPanel />

      {hasLibrary && <LibraryStatsPanel />}

      {/* Recently added tracks — horizontal row */}
      {stats && stats.mostRecentlyAdded.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-3">Recently added</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3">
            {stats.mostRecentlyAdded.map((t) => (
              <div
                key={t.id}
                onClick={() => playRecent(t.id)}
                className="group relative bg-bg-elev-1 hover:bg-bg-elev-2 rounded p-2 transition cursor-pointer"
              >
                <div className="relative aspect-square w-full mb-2">
                  {t.coverArtPath ? (
                    <img src={mediaUrl(t.coverArtPath)} className="w-full h-full rounded" alt="" />
                  ) : <div className="w-full h-full rounded bg-bg-highlight" />}
                  <div className="absolute bottom-1 right-1 w-8 h-8 rounded-full bg-accent text-black flex items-center justify-center text-sm shadow-lg opacity-0 group-hover:opacity-100 transition">▶</div>
                </div>
                <div className="text-xs font-medium truncate">{t.title}</div>
                <div className="text-[10px] text-text-muted truncate">{t.artist ?? '—'}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Albums grid. Shows 12 most-recent tiles by default; click "Show more"
          to expand up to 96. Toggle button is next to the heading so it's
          discoverable without scrolling. If the backend returned fewer than
          the collapsed count, we don't bother showing the toggle. */}
      {hasLibrary && albums.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xl font-semibold">Newest albums</h2>
            {albums.length > NEWEST_COLLAPSED && (
              <button
                onClick={() => setNewestExpanded((v) => !v)}
                className="text-xs text-text-muted hover:text-text-primary transition inline-flex items-center gap-1"
                title={newestExpanded ? 'Collapse to the 12 most recent' : `Show up to ${NEWEST_EXPANDED} recent albums`}
              >
                {newestExpanded ? (
                  <>Show less ▴</>
                ) : (
                  <>Show more ({Math.min(albums.length, NEWEST_EXPANDED)}) ▾</>
                )}
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
            {albums.slice(0, newestExpanded ? NEWEST_EXPANDED : NEWEST_COLLAPSED).map((a) => (
              <AlbumCard key={a.id} album={a} />
            ))}
          </div>
        </div>
      )}

      {!hasLibrary && !stats && (
        <div className="mt-8 text-text-muted text-sm">Loading…</div>
      )}

      {!hasLibrary && stats && <EmptyLibraryCard onAdded={load} />}
    </section>
  );
}

function EmptyLibraryCard({ onAdded }: { onAdded: () => void }) {
  async function pickAndScan() {
    const dir = await window.mp.library.pickDir();
    if (!dir) return;
    await window.mp.library.addDir(dir);
    onAdded();
    window.mp.scan.start();
  }

  return (
    <div className="mt-8 p-10 rounded-xl bg-gradient-to-br from-bg-elev-1 to-bg-elev-2 border border-white/10 text-center">
      <div className="text-5xl mb-4">🎵</div>
      <h2 className="text-2xl font-bold mb-2">No music in your library yet</h2>
      <p className="text-text-secondary mb-6 max-w-lg mx-auto">
        Pick a folder on your computer and we'll scan it for mp3, flac, wav, m4a, aac, ogg, opus and wma files.
        Tags, embedded cover art, and online cover-art lookups all run automatically.
      </p>
      <button
        onClick={pickAndScan}
        className="bg-accent hover:bg-accent-hover text-black font-semibold px-6 py-3 rounded-full text-sm inline-flex items-center gap-2"
      >+ Choose music folder</button>
      <p className="text-xs text-text-muted mt-4">
        Or open <Link to="/settings/library" className="text-accent hover:underline">Settings → Library</Link> to manage folders.
      </p>
    </div>
  );
}
