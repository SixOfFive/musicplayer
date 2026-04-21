import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type {
  SearchResults, SearchTrackHit, SearchAlbumHit,
  LargestAlbum,
} from '../../shared/types';
import TrackRow, { type RowTrack } from '../components/TrackRow';
import { mediaUrl } from '../lib/mediaUrl';
import LoadingStrip from '../components/LoadingStrip';

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '—';
  const MB = bytes / (1024 * 1024);
  if (MB < 1024) return `${MB.toFixed(1)} MB`;
  return `${(MB / 1024).toFixed(2)} GB`;
}

/**
 * Translate a rich search track hit to the snake_case shape that TrackRow
 * expects. TrackRow was originally wired up to DB-row results; rather than
 * refactor it, we adapt here.
 */
function toRowTrack(t: SearchTrackHit): RowTrack {
  return {
    id: t.id,
    path: t.path,
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration_sec: t.durationSec,
    cover_art_path: t.coverArtPath,
  };
}

/**
 * Run a search with cascading fallback. The radio "Like" button passes up
 * to three pieces of context — title / artist / album — and the user asked
 * for progressively broader queries until SOMETHING matches:
 *
 *     Tier 1:  title + artist + album   (only attempted if all three exist)
 *     Tier 2:  title + artist
 *     Tier 3:  title alone
 *     Tier 4:  artist alone              (last resort — lets the user browse
 *                                         discography when the track itself
 *                                         isn't in the library)
 *
 * We stop at the first tier that returns at least one hit across any of
 * tracks / albums / artists, and report which tier landed so the UI can say
 * "no exact match — showing results for …".
 */
interface CascadeOutcome {
  query: string;
  tier: number; // 0 = literal query (from typed input), 1..4 from above
  results: SearchResults;
}

async function runCascade(opts: { raw?: string; title?: string | null; artist?: string | null; album?: string | null }): Promise<CascadeOutcome> {
  const { raw, title, artist, album } = opts;
  const tiers: Array<{ tier: number; query: string }> = [];
  if (raw && raw.trim()) {
    tiers.push({ tier: 0, query: raw.trim() });
  }
  if (title && artist && album) tiers.push({ tier: 1, query: `${title} ${artist} ${album}` });
  if (title && artist) tiers.push({ tier: 2, query: `${title} ${artist}` });
  if (title) tiers.push({ tier: 3, query: title });
  if (artist) tiers.push({ tier: 4, query: artist });

  // Dedupe — if the user typed exactly "title artist" there's no point
  // re-running the cascade tier with the same query.
  const seen = new Set<string>();
  const ordered = tiers.filter((t) => {
    const k = t.query.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  let last: CascadeOutcome | null = null;
  for (const { tier, query } of ordered) {
    const results: SearchResults = await window.mp.library.search(query);
    last = { query, tier, results };
    const hits = results.tracks.length + results.albums.length + results.artists.length;
    if (hits > 0) return last;
  }
  return last ?? { query: '', tier: 0, results: { tracks: [], albums: [], artists: [] } };
}

export default function SearchView() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();

  // Three modes of arrival:
  //   1. User types into the box → raw query
  //   2. Radio "Like" button navigates with title + artist params
  //   3. Deep-link with just q=... in the URL
  const queryFromUrl = params.get('q') ?? '';
  const titleFromUrl = params.get('title');
  const artistFromUrl = params.get('artist');
  const albumFromUrl = params.get('album');

  const [input, setInput] = useState(queryFromUrl);
  const [results, setResults] = useState<SearchResults>({ tracks: [], albums: [], artists: [] });
  const [tier, setTier] = useState<number>(0);
  const [effectiveQuery, setEffectiveQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [largest, setLargest] = useState<LargestAlbum[]>([]);
  const [largestOpen, setLargestOpen] = useState(false);
  const [largestLoading, setLargestLoading] = useState(false);

  // Track the debounce timer so typing doesn't fire a request per keystroke.
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Run the cascade whenever the URL params change (radio-Like flow) OR
  // the user types (debounced below).
  const runSearch = useCallback(async (opts: { raw?: string; title?: string | null; artist?: string | null; album?: string | null }) => {
    const anyInput = (opts.raw && opts.raw.trim()) || opts.title || opts.artist || opts.album;
    if (!anyInput) {
      setResults({ tracks: [], albums: [], artists: [] });
      setEffectiveQuery('');
      setTier(0);
      return;
    }
    setLoading(true);
    try {
      const out = await runCascade(opts);
      setResults(out.results);
      setEffectiveQuery(out.query);
      setTier(out.tier);
    } catch (err) {
      console.error('[search] failed', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // React to URL-driven searches (radio Like / deep link). Also seeds `input`
  // so the search box reflects the query that was navigated to.
  useEffect(() => {
    // When the user arrives via radio with title+artist params, we combine
    // them for the input box display, but the cascade gets the structured
    // pieces for proper tier-fallback behavior.
    if (titleFromUrl || artistFromUrl || albumFromUrl) {
      const combined = [titleFromUrl, artistFromUrl, albumFromUrl].filter(Boolean).join(' ');
      setInput(combined);
      void runSearch({ title: titleFromUrl, artist: artistFromUrl, album: albumFromUrl });
    } else if (queryFromUrl) {
      setInput(queryFromUrl);
      void runSearch({ raw: queryFromUrl });
    } else {
      setResults({ tracks: [], albums: [], artists: [] });
    }
  }, [queryFromUrl, titleFromUrl, artistFromUrl, albumFromUrl, runSearch]);

  // Debounced typing — also mirror the input to the URL bar so refresh/back
  // preserves what the user typed.
  function onType(v: string) {
    setInput(v);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      // Typing overrides any inbound radio-Like params.
      const next = new URLSearchParams();
      if (v.trim()) next.set('q', v.trim());
      setParams(next, { replace: true });
      if (v.trim()) void runSearch({ raw: v.trim() });
      else setResults({ tracks: [], albums: [], artists: [] });
    }, 250);
  }

  // Fetch top-25 largest albums lazily the first time the panel opens.
  useEffect(() => {
    if (!largestOpen || largest.length > 0) return;
    setLargestLoading(true);
    window.mp.library.largestAlbums(25)
      .then((rows: LargestAlbum[]) => setLargest(rows ?? []))
      .catch((err: unknown) => console.error('[search] largestAlbums failed', err))
      .finally(() => setLargestLoading(false));
  }, [largestOpen, largest.length]);

  const totalHits = results.tracks.length + results.albums.length + results.artists.length;

  const tierNote = useMemo(() => {
    if (tier <= 0) return null;
    const tierLabel =
      tier === 1 ? 'title + artist + album' :
      tier === 2 ? 'title + artist' :
      tier === 3 ? 'title only' :
      tier === 4 ? 'artist only' : '';
    return `No exact match — showing results for ${tierLabel}: “${effectiveQuery}”.`;
  }, [tier, effectiveQuery]);

  // TrackRow treats the array it gets as the queue when the user hits play,
  // so convert once and pass the same array both as `siblings` and for lookup.
  const rowTracks = useMemo(() => results.tracks.map(toRowTrack), [results.tracks]);

  return (
    <section className="p-8">
      <header className="mb-6">
        <div className="text-xs uppercase tracking-wide text-text-muted">Find</div>
        <h1 className="text-4xl font-extrabold my-1">Search</h1>
        <p className="text-sm text-text-muted">
          Songs, albums, and artists from your local library. Tokenized —
          every word you type must appear somewhere in the title, artist, or
          album name.
        </p>
      </header>

      {/* Search input */}
      <input
        autoFocus
        type="search"
        value={input}
        onChange={(e) => onType(e.target.value)}
        placeholder="Search your library…"
        className="w-full max-w-2xl bg-bg-elev-2 px-4 py-3 rounded-full text-sm outline-none focus:ring-2 focus:ring-accent mb-4"
      />

      {/* Top-25 largest albums — collapsible so it doesn't dominate the page. */}
      <div className="mb-6 max-w-3xl">
        <button
          onClick={() => setLargestOpen((v) => !v)}
          className="flex items-center gap-2 text-xs uppercase tracking-wider text-text-muted hover:text-text-primary transition"
        >
          <span>{largestOpen ? '▾' : '▸'}</span>
          <span>Top 25 largest albums</span>
        </button>
        {largestOpen && (
          <div className="mt-3 bg-bg-elev-1 rounded border border-white/5 divide-y divide-white/5">
            {largestLoading && <LoadingStrip label="Loading largest albums…" className="p-3" />}
            {!largestLoading && largest.length === 0 && (
              <div className="p-3 text-sm text-text-muted">No albums with size data yet.</div>
            )}
            {largest.map((a, i) => (
              <div
                key={a.id}
                className="flex items-center gap-3 p-2 pr-3 hover:bg-bg-elev-2 transition cursor-pointer"
                onClick={() => nav(`/album/${a.id}`)}
                title="Go to album"
              >
                <span className="text-xs text-text-muted w-6 text-right tabular-nums flex-shrink-0">{i + 1}</span>
                {a.coverArtPath ? (
                  <img src={mediaUrl(a.coverArtPath)} alt="" className="w-10 h-10 rounded object-cover flex-shrink-0" />
                ) : (
                  <div className="w-10 h-10 rounded bg-bg-highlight flex-shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-text-primary truncate">{a.title}</div>
                  <div className="text-xs text-text-muted truncate">
                    {a.artist ?? 'Unknown artist'} · {a.trackCount} track{a.trackCount === 1 ? '' : 's'}
                  </div>
                </div>
                <span className="text-xs text-text-muted tabular-nums flex-shrink-0 w-20 text-right">{formatBytes(a.bytes)}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); nav(`/album/${a.id}`); }}
                  className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-accent hover:text-black transition flex-shrink-0"
                  title={`Open ${a.title}`}
                >
                  Go →
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {loading && <LoadingStrip label="Searching…" className="my-3" />}

      {tierNote && !loading && (
        <div className="mb-4 text-xs text-amber-300/90 bg-amber-900/20 border border-amber-500/30 rounded px-3 py-2 max-w-2xl">
          {tierNote}
        </div>
      )}

      {!loading && input && totalHits === 0 && (
        <div className="text-sm text-text-muted">No matches. Try a shorter query or fewer words.</div>
      )}

      {/* Tracks */}
      {results.tracks.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-bold mb-3">Tracks <span className="text-text-muted text-sm font-normal">({results.tracks.length})</span></h2>
          <div className="grid grid-cols-[24px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_72px_40px] items-center text-xs text-text-muted uppercase tracking-wider border-b border-white/5 pb-2 px-2">
            <span>#</span>
            <span>Title</span>
            <span>Artist</span>
            <span>Album</span>
            <span className="text-right">Length</span>
            <span></span>
          </div>
          {rowTracks.map((t, i) => (
            <TrackRow key={t.id} track={t} index={i} siblings={rowTracks} />
          ))}
        </div>
      )}

      {/* Albums */}
      {results.albums.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-bold mb-3">Albums <span className="text-text-muted text-sm font-normal">({results.albums.length})</span></h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {results.albums.map((a) => (
              <AlbumCardMini key={a.id} album={a} onClick={() => nav(`/album/${a.id}`)} />
            ))}
          </div>
        </div>
      )}

      {/* Artists */}
      {results.artists.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-bold mb-3">Artists <span className="text-text-muted text-sm font-normal">({results.artists.length})</span></h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {results.artists.map((a) => (
              <div
                key={a.id}
                onClick={() => nav(`/artist/${a.id}`)}
                className="flex items-center gap-3 p-3 rounded bg-bg-elev-1 hover:bg-bg-elev-2 cursor-pointer transition"
              >
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-purple-600 to-blue-500 flex items-center justify-center text-lg font-bold">
                  {a.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{a.name}</div>
                  <div className="text-xs text-text-muted truncate">
                    {a.albumCount} album{a.albumCount === 1 ? '' : 's'} · {a.trackCount} track{a.trackCount === 1 ? '' : 's'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function AlbumCardMini({ album, onClick }: { album: SearchAlbumHit; onClick: () => void }) {
  // Same rich-tooltip shape as AlbumCard (title / artist / year·genre /
  // tracks·duration·size). Duplicated inline rather than extracted to a
  // util because this mini-card is the only other call site and keeping
  // the formatter local keeps imports cheap.
  const lines: string[] = [album.title];
  if (album.artist) lines.push(album.artist);
  const yearGenre = [album.year, album.genre].filter(Boolean).join(' · ');
  if (yearGenre) lines.push(yearGenre);
  const stats: string[] = [];
  if (album.trackCount > 0) stats.push(`${album.trackCount} track${album.trackCount === 1 ? '' : 's'}`);
  if (album.durationSec && album.durationSec > 0) {
    const h = Math.floor(album.durationSec / 3600);
    const m = Math.floor((album.durationSec % 3600) / 60);
    stats.push(h > 0 ? `${h}h ${m}m` : `${m}m`);
  }
  if (album.bytes > 0) stats.push(formatBytes(album.bytes));
  if (stats.length > 0) lines.push(stats.join(' · '));
  const tooltip = lines.join('\n');

  return (
    <div onClick={onClick} className="cursor-pointer group" title={tooltip}>
      <div className="aspect-square rounded bg-bg-highlight overflow-hidden mb-2 relative">
        {album.coverArtPath ? (
          <img src={mediaUrl(album.coverArtPath)} alt="" className="w-full h-full object-cover group-hover:scale-[1.03] transition" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-3xl text-text-muted">♪</div>
        )}
      </div>
      <div className="text-sm font-medium truncate">{album.title}</div>
      <div className="text-xs text-text-muted truncate">
        {album.artist ?? 'Unknown artist'}
        {album.year ? ` · ${album.year}` : ''}
      </div>
    </div>
  );
}
