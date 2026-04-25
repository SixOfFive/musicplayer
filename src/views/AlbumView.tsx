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
  // `loading` is true from mount until the first successful fetch OR
  // until the fetch confirms the album doesn't exist. Previously we
  // distinguished "album not yet loaded" from "album confirmed missing"
  // only by `album === null`, which left the page on a permanent
  // "Loading…" placeholder after a rescan deleted the album row.
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [rescan, setRescan] = useState<null | { running: boolean; result?: { added: number; updated: number; removed: number; errors: number; message: string; albumDeleted: boolean } }>(null);
  const play = usePlayer((s) => s.play);

  const load = useCallback(() => {
    setLoading(true);
    window.mp.library.album(aid).then((res: any) => {
      if (res?.album) {
        setAlbum(res.album);
        setTracks(res.tracks);
        setNotFound(false);
      } else {
        // Backend returned { album: undefined } — album row doesn't exist
        // in the DB. Could be because a rescan just removed it, or the
        // user reached a stale /album/:id URL from history. Either way,
        // show a proper dead-end page rather than spinning forever.
        setAlbum(null);
        setTracks([]);
        setNotFound(true);
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [aid]);

  useEffect(() => { load(); }, [load]);
  useLibraryRefresh(load);

  /**
   * Cheap auto-health check on album open. Main samples ONE track from
   * this album on disk. If it's missing (e.g. the album was re-encoded
   * elsewhere so the extensions changed, or the folder was deleted),
   * main kicks off a full album rescan that reconciles DB with disk.
   *
   * Throttled main-side to one probe per album per 5 minutes so
   * bouncing between albums doesn't spam SMB. Gated by the session-
   * wide "library suspect" flag: if startup found a broken mount, no
   * cleanup runs at all — we'd rather keep stale rows than nuke them
   * when the files might still exist behind an unreachable share.
   *
   * Runs in the background: the initial fetch of tracks happens
   * in parallel via `load()`. If the rescan finds changes, we
   * re-invoke `load()` to show them and fire the global library-
   * changed event so the sidebar counts update too.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r: any = await (window.mp.library as any).probeAlbum(aid);
        if (cancelled) return;
        if (r?.rescanned) {
          // Reuse the same result panel that the manual "Rescan album"
          // button populates so the user sees exactly what changed —
          // "Automatically rescanned — 3 tracks removed, 12 updated"
          // rather than a silent refresh they might not notice.
          setRescan({ running: false, result: {
            added: r.added ?? 0,
            updated: r.updated ?? 0,
            removed: r.removed ?? 0,
            errors: 0,
            albumDeleted: !!r.albumDeleted,
            message: 'Auto-rescan after detecting a missing file.',
          }});
          load();
          window.dispatchEvent(new CustomEvent('mp-library-changed'));
        }
      } catch { /* silent — probe is best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [aid, load]);

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
      // Always re-fetch in place. If the album was actually deleted by the
      // rescan (folder truly empty), load() will set notFound=true and the
      // page switches to the dead-end state with a "Back to albums" button
      // — NOT an automatic redirect that yanks the user out from under
      // their current context.
      load();
      window.dispatchEvent(new CustomEvent('mp-library-changed'));
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

  if (loading && !album) return <section className="p-8 text-text-muted">Loading…</section>;

  if (notFound || !album) {
    return (
      <section className="p-8">
        <div className="text-xs uppercase tracking-wide text-text-muted">Album</div>
        <h1 className="text-4xl font-extrabold my-2">Album not found</h1>
        <p className="text-sm text-text-muted max-w-lg mb-6">
          This album isn't in the library anymore — its folder may have been moved, renamed,
          or emptied on disk, or a rescan found no audio files there. Its tracks may have
          been reassigned to a different album row if their tags changed during a conversion.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => nav('/albums')}
            className="px-4 py-1.5 rounded-full bg-accent text-black font-semibold text-sm"
          >
            Back to Albums
          </button>
          <button
            onClick={load}
            className="px-4 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-sm"
          >
            Try again
          </button>
        </div>
      </section>
    );
  }

  const totalSec = tracks.reduce((n, t) => n + (t.duration_sec ?? 0), 0);
  // Total album size across all tracks — surfaced in the header next to
  // track count / runtime so users can tell "big lossless album" vs
  // "compact mp3 album" at a glance. RowTrack.size is optional (not every
  // caller populates it), so we guard the sum against missing values.
  const totalBytes = tracks.reduce((n, t: any) => n + (t.size ?? 0), 0);

  // Path shown on hover and opened on click when the user clicks the
  // album art. Prefer the album's FOLDER (derived from a track) over
  // the cover file itself — most users who click "show me this on disk"
  // want to see the whole album directory, not just the jpg. Falls back
  // to cover_art_path if we somehow have art but no tracks (shouldn't
  // happen but belt-and-suspenders).
  const albumFolderPath = tracks[0]?.path
    ? tracks[0].path.replace(/[\\/][^\\/]+$/, '') // strip the filename to get the folder
    : album.cover_art_path ?? null;
  const revealAlbum = () => {
    if (!albumFolderPath) return;
    // Fire-and-forget — the IPC shows a native File Explorer / Finder
    // window; there's nothing to do with the result in the UI.
    void window.mp.library.revealInFolder(albumFolderPath);
  };

  return (
    <section>
      <header className="flex gap-6 px-8 pt-8 pb-6 bg-gradient-to-b from-bg-elev-2 to-transparent">
        {album.cover_art_path ? (
          <img
            src={mediaUrl(album.cover_art_path)}
            className="w-56 h-56 rounded shadow-2xl flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-accent transition"
            alt=""
            title={albumFolderPath ?? ''}
            onClick={revealAlbum}
          />
        ) : (
          <div
            className="w-56 h-56 rounded bg-bg-highlight flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-accent transition"
            title={albumFolderPath ?? ''}
            onClick={revealAlbum}
          />
        )}
        <div className="flex flex-col justify-end min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wide text-text-muted">Album</div>
          <h1 className="text-6xl font-extrabold my-2 truncate">{album.title}</h1>
          <div className="text-sm text-text-secondary">
            <span className="font-semibold text-white">{album.artist ?? 'Unknown artist'}</span>
            {album.year ? <> · {album.year}</> : null}
            {album.genre ? <> · {album.genre}</> : null}
            {' · '}{tracks.length} tracks · {Math.floor(totalSec / 60)} min
            {totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : ''}
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
          <div className="grid grid-cols-[24px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.9fr)_92px_56px_72px_40px] gap-3 px-4 py-2 border-b border-white/5 text-xs uppercase tracking-wide text-text-muted">
            <div className="text-right">#</div>
            <div>Title</div>
            <div>Album</div>
            <div>Artist</div>
            <div>Quality</div>
            <div className="text-right" title="Times this track has been played">Plays</div>
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

