import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RadioStation, RadioTag } from '../../shared/types';
import { usePlayer } from '../store/player';

type Mode = 'popular' | 'trending' | 'search' | 'tag' | 'country';

/**
 * Online radio — queries the community-maintained Radio-Browser directory
 * (radio-browser.info) which indexes tens of thousands of real Icecast /
 * Shoutcast / HLS streams. Clicking a station hands the stream URL to the
 * player which feeds it into the shared AudioEngine.
 *
 * No API key, no account. The service rate-limits per IP so we debounce
 * searches and cap responses at 100 rows.
 */
export default function RadioView() {
  const playRadio = usePlayer((s) => s.playRadio);
  const currentRadioUrl = usePlayer((s) => s.radio?.streamUrl ?? null);

  const [mode, setMode] = useState<Mode>('popular');
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [country, setCountry] = useState<string | null>(null);
  const [stations, setStations] = useState<RadioStation[]>([]);
  const [tags, setTags] = useState<RadioTag[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Load popular genre tags once — used for the tag chip bar.
  useEffect(() => {
    window.mp.radio.tags(40).then(setTags).catch(() => setTags([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      let list: RadioStation[] = [];
      if (mode === 'popular') list = await window.mp.radio.top(60);
      else if (mode === 'trending') list = await window.mp.radio.trending(60);
      else if (mode === 'search' && query.trim()) list = await window.mp.radio.search(query.trim(), 100);
      else if (mode === 'tag' && tag) list = await window.mp.radio.byTag(tag, 100);
      else if (mode === 'country' && country) list = await window.mp.radio.byCountry(country, 100);
      setStations(list);
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to load stations');
      setStations([]);
    }
    setLoading(false);
  }, [mode, query, tag, country]);

  useEffect(() => { load(); }, [load]);

  // Debounce the search input so we don't fire a request on every keystroke.
  const [typingQuery, setTypingQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      if (typingQuery !== query) setQuery(typingQuery);
    }, 300);
    return () => clearTimeout(t);
  }, [typingQuery, query]);

  const topTags = useMemo(() => tags.slice(0, 20), [tags]);

  async function click(s: RadioStation) {
    playRadio({
      station: s.name,
      streamUrl: s.url_resolved || s.url,
      homepage: s.homepage || null,
      favicon: s.favicon || null,
      country: s.country || null,
      codec: s.codec || null,
      bitrate: s.bitrate || null,
    });
    // Best-effort click-count bump so Radio-Browser's trending list reflects use.
    window.mp.radio.click(s.stationuuid);
  }

  return (
    <section className="p-8">
      <header className="mb-6">
        <div className="text-xs uppercase tracking-wide text-text-muted">Internet</div>
        <h1 className="text-4xl font-extrabold my-1">Radio</h1>
        <p className="text-sm text-text-muted">
          Tens of thousands of live stations worldwide, via the community-maintained{' '}
          <a onClick={() => window.open('https://www.radio-browser.info/', '_blank')} className="text-accent cursor-pointer hover:underline">Radio-Browser</a> directory.
          Click any station to start streaming — no account needed.
        </p>
      </header>

      {/* Mode tabs */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <button onClick={() => setMode('popular')} className={`px-3 py-1 rounded-full text-xs ${mode === 'popular' ? 'bg-accent text-black font-semibold' : 'bg-white/10 hover:bg-white/20'}`}>Top voted</button>
        <button onClick={() => setMode('trending')} className={`px-3 py-1 rounded-full text-xs ${mode === 'trending' ? 'bg-accent text-black font-semibold' : 'bg-white/10 hover:bg-white/20'}`}>Trending</button>
        <button onClick={() => setMode('search')} className={`px-3 py-1 rounded-full text-xs ${mode === 'search' ? 'bg-accent text-black font-semibold' : 'bg-white/10 hover:bg-white/20'}`}>Search</button>
        <button onClick={() => setMode('tag')} className={`px-3 py-1 rounded-full text-xs ${mode === 'tag' ? 'bg-accent text-black font-semibold' : 'bg-white/10 hover:bg-white/20'}`}>By genre</button>
        <button onClick={() => setMode('country')} className={`px-3 py-1 rounded-full text-xs ${mode === 'country' ? 'bg-accent text-black font-semibold' : 'bg-white/10 hover:bg-white/20'}`}>By country</button>
      </div>

      {/* Mode-specific controls */}
      {mode === 'search' && (
        <input
          autoFocus
          placeholder="Search stations by name…"
          value={typingQuery}
          onChange={(e) => setTypingQuery(e.target.value)}
          className="w-full max-w-md bg-bg-elev-2 px-3 py-2 rounded text-sm mb-4 outline-none focus:ring-1 focus:ring-accent"
        />
      )}
      {mode === 'tag' && (
        <div className="flex flex-wrap gap-2 mb-4">
          {topTags.map((t) => (
            <button
              key={t.name}
              onClick={() => setTag(t.name)}
              className={`px-3 py-1 rounded-full text-xs ${tag === t.name ? 'bg-accent text-black font-semibold' : 'bg-white/5 hover:bg-white/15'}`}
              title={`${t.stationcount.toLocaleString()} stations`}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}
      {mode === 'country' && (
        <div className="flex flex-wrap gap-2 mb-4 text-xs">
          {['US', 'GB', 'CA', 'DE', 'FR', 'JP', 'AU', 'BR', 'MX', 'IT', 'ES', 'NL', 'SE', 'RU', 'IN', 'CN', 'ZA'].map((cc) => (
            <button
              key={cc}
              onClick={() => setCountry(cc)}
              className={`px-3 py-1 rounded-full ${country === cc ? 'bg-accent text-black font-semibold' : 'bg-white/5 hover:bg-white/15'}`}
            >
              {cc}
            </button>
          ))}
        </div>
      )}

      {/* Status */}
      {loading && <div className="text-sm text-text-muted">Loading stations…</div>}
      {err && <div className="text-sm text-red-400">Error: {err}</div>}
      {!loading && !err && stations.length === 0 && mode !== 'search' && (
        <div className="text-sm text-text-muted">
          {mode === 'tag' && !tag && 'Pick a genre to see its stations.'}
          {mode === 'country' && !country && 'Pick a country to see its stations.'}
        </div>
      )}
      {!loading && !err && mode === 'search' && !query.trim() && (
        <div className="text-sm text-text-muted">Type to search.</div>
      )}

      {/* Station grid */}
      {!loading && stations.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {stations.map((s) => {
            const isPlaying = currentRadioUrl != null && currentRadioUrl === (s.url_resolved || s.url);
            return (
              <div
                key={s.stationuuid}
                onClick={() => click(s)}
                className={`flex items-center gap-3 p-3 rounded cursor-pointer transition ${isPlaying ? 'bg-accent/20 border border-accent/40' : 'bg-bg-elev-1 hover:bg-bg-elev-2 border border-transparent'}`}
              >
                <div className="w-12 h-12 rounded bg-bg-highlight flex-shrink-0 overflow-hidden flex items-center justify-center">
                  {s.favicon ? (
                    <img src={s.favicon} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} className="w-full h-full object-contain" />
                  ) : (
                    <span className="text-xl">📻</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{s.name}</div>
                  <div className="text-xs text-text-muted truncate">
                    {s.country || '—'}
                    {s.codec ? ` · ${s.codec}` : ''}
                    {s.bitrate ? ` · ${s.bitrate} kbps` : ''}
                    {s.tags ? ` · ${s.tags.split(',').slice(0, 3).join(', ')}` : ''}
                  </div>
                </div>
                {isPlaying && (
                  <div className="text-[10px] text-accent font-semibold uppercase tracking-wider flex-shrink-0">Live</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
