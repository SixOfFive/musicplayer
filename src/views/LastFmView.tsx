import { useCallback, useEffect, useState } from 'react';
import type {
  LastFmAlbum, LastFmArtist, LastFmPeriod, LastFmProfile, LastFmStatus, LastFmTrackLite,
} from '../../shared/types';
import MiniVisualizer from '../components/MiniVisualizer';
import LoadingStrip from '../components/LoadingStrip';

type Tab = 'topArtists' | 'topTracks' | 'topAlbums' | 'recent' | 'charts';

const PERIOD_LABELS: Record<LastFmPeriod, string> = {
  '7day': 'Last 7 days',
  '1month': 'Last month',
  '3month': 'Last 3 months',
  '6month': 'Last 6 months',
  '12month': 'Last 12 months',
  overall: 'All time',
};

/**
 * Last.fm hub.
 *
 * Disconnected → explainer card + "Get started" flow (enter API key/secret
 * from the user's registered Last.fm app, then browser-auth).
 * Connected → profile header + tabs for Top Artists / Top Tracks /
 * Top Albums / Recently Scrobbled, plus a global Charts tab that works
 * without connecting.
 */
export default function LastFmView() {
  const [status, setStatus] = useState<LastFmStatus | null>(null);
  const [profile, setProfile] = useState<LastFmProfile | null>(null);

  const refreshStatus = useCallback(async () => {
    const s = await window.mp.lastfm.status();
    setStatus(s as LastFmStatus);
    if ((s as LastFmStatus).connected) {
      const p = await window.mp.lastfm.profile().catch(() => null);
      setProfile(p as LastFmProfile | null);
    } else {
      setProfile(null);
    }
  }, []);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  if (!status) return <section className="p-8"><LoadingStrip label="Loading Last.fm status…" /></section>;

  return (
    <section>
      <header className="flex items-start gap-6 px-8 pt-8 pb-6 bg-gradient-to-b from-red-900/30 to-transparent">
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-wide text-text-muted">Last.fm</div>
          {status.connected && profile ? (
            <>
              <h1 className="text-5xl font-extrabold my-2 truncate">{profile.name}</h1>
              <div className="text-sm text-text-secondary">
                {profile.realname ? <>{profile.realname} · </> : null}
                {profile.country ?? 'Unknown country'} · {profile.playcount.toLocaleString()} scrobbles
                {profile.registered ? ` · member since ${new Date(profile.registered).getFullYear()}` : ''}
              </div>
              <div className="flex items-center gap-3 mt-3">
                <a
                  onClick={() => window.open(profile.url, '_blank')}
                  className="text-xs text-accent cursor-pointer hover:underline"
                >Open profile on last.fm</a>
                <ScrobbleToggle status={status} onChange={refreshStatus} />
                <button
                  onClick={async () => { await window.mp.lastfm.disconnect(); await refreshStatus(); }}
                  className="text-xs text-text-muted hover:text-red-300"
                >Disconnect</button>
              </div>
            </>
          ) : (
            <h1 className="text-5xl font-extrabold my-2">Last.fm</h1>
          )}
        </div>
        <MiniVisualizer className="hidden md:block w-64 h-36 flex-shrink-0 self-end" />
      </header>

      {!status.connected ? (
        <Disconnected status={status} onConnected={refreshStatus} />
      ) : (
        <Connected />
      )}
    </section>
  );
}

function ScrobbleToggle({ status, onChange }: { status: LastFmStatus; onChange: () => void }) {
  return (
    <label className="inline-flex items-center gap-1 text-xs cursor-pointer">
      <input
        type="checkbox"
        checked={status.scrobbleEnabled}
        onChange={async (e) => {
          await window.mp.lastfm.setScrobble(e.target.checked);
          onChange();
        }}
      />
      <span className={status.scrobbleEnabled ? 'text-accent' : 'text-text-muted'}>
        Scrobbling {status.scrobbleEnabled ? 'on' : 'off'}
      </span>
    </label>
  );
}

// ------- Disconnected -------

function Disconnected({ status, onConnected }: { status: LastFmStatus; onConnected: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [savedKeys, setSavedKeys] = useState(status.hasCredentials);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function saveKeys() {
    if (!apiKey.trim() || !apiSecret.trim()) return;
    await window.mp.lastfm.setKeys(apiKey.trim(), apiSecret.trim());
    setSavedKeys(true);
    setErr(null);
  }

  async function startAuth() {
    setBusy(true);
    setErr(null);
    try {
      const r: any = await window.mp.lastfm.beginAuth();
      setAuthToken(r.token);
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to start auth');
    }
    setBusy(false);
  }

  async function completeAuth() {
    if (!authToken) return;
    setBusy(true);
    setErr(null);
    try {
      await window.mp.lastfm.finishAuth(authToken);
      await onConnected();
    } catch (e: any) {
      setErr(e?.message ?? 'Authorization failed');
    }
    setBusy(false);
  }

  return (
    <div className="px-8 pb-10 max-w-3xl">
      <div className="bg-bg-elev-1 rounded-xl p-6 border border-white/10">
        <h2 className="text-xl font-bold mb-2">Connect your Last.fm account</h2>
        <p className="text-sm text-text-secondary mb-4">
          Scrobble your local plays to your Last.fm profile, see your top artists / tracks / albums over any time range,
          and browse global charts — all in this tab. Nothing else changes; playback works the same whether you connect or not.
        </p>

        {!savedKeys ? (
          <>
            <ol className="text-sm text-text-secondary space-y-2 mb-4 list-decimal pl-5">
              <li>
                Go to{' '}
                <a
                  onClick={() => window.open('https://www.last.fm/api/account/create', '_blank')}
                  className="text-accent cursor-pointer hover:underline"
                >last.fm/api/account/create</a>
                {' '}(need a Last.fm account first — free).
              </li>
              <li>Fill in any name + description. Leave callback URL blank.</li>
              <li>Copy the <strong>API key</strong> and <strong>Shared secret</strong> from the resulting page.</li>
              <li>Paste them below.</li>
            </ol>

            <div className="space-y-2">
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="API key (public, 32 hex chars)"
                className="w-full bg-bg-base px-3 py-2 rounded text-xs font-mono"
              />
              <input
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder="Shared secret (32 hex chars)"
                type="password"
                className="w-full bg-bg-base px-3 py-2 rounded text-xs font-mono"
              />
              <button
                onClick={saveKeys}
                disabled={!apiKey.trim() || !apiSecret.trim()}
                className="px-4 py-1.5 rounded-full bg-accent hover:bg-accent-hover disabled:opacity-50 text-black font-semibold text-sm"
              >Save keys</button>
            </div>
          </>
        ) : !authToken ? (
          <>
            <p className="text-sm text-text-secondary mb-3">Keys saved. Now authorize this app on Last.fm.</p>
            <button
              onClick={startAuth}
              disabled={busy}
              className="px-4 py-2 rounded-full bg-accent hover:bg-accent-hover disabled:opacity-50 text-black font-semibold text-sm"
            >{busy ? 'Opening browser…' : 'Authorize on Last.fm'}</button>
          </>
        ) : (
          <>
            <p className="text-sm text-text-secondary mb-3">
              We've opened Last.fm in your browser. Sign in there and click <strong>Yes, allow access</strong>.
              Then come back here and click <strong>Finish connecting</strong>.
            </p>
            <button
              onClick={completeAuth}
              disabled={busy}
              className="px-4 py-2 rounded-full bg-accent hover:bg-accent-hover disabled:opacity-50 text-black font-semibold text-sm"
            >{busy ? 'Finishing…' : 'Finish connecting'}</button>
          </>
        )}

        {err && <div className="text-xs text-red-400 mt-3">{err}</div>}
      </div>

      {/* Even disconnected, the global charts are public so we can show them. */}
      <div className="mt-8">
        <Charts />
      </div>
    </div>
  );
}

// ------- Connected tabs -------

function Connected() {
  const [tab, setTab] = useState<Tab>('topArtists');
  const [period, setPeriod] = useState<LastFmPeriod>('1month');

  return (
    <div className="px-8 pb-10">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <TabButton active={tab === 'topArtists'} onClick={() => setTab('topArtists')}>Top artists</TabButton>
        <TabButton active={tab === 'topTracks'} onClick={() => setTab('topTracks')}>Top tracks</TabButton>
        <TabButton active={tab === 'topAlbums'} onClick={() => setTab('topAlbums')}>Top albums</TabButton>
        <TabButton active={tab === 'recent'} onClick={() => setTab('recent')}>Recently scrobbled</TabButton>
        <TabButton active={tab === 'charts'} onClick={() => setTab('charts')}>Global charts</TabButton>
        {(tab === 'topArtists' || tab === 'topTracks' || tab === 'topAlbums') && (
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as LastFmPeriod)}
            className="ml-auto bg-bg-elev-2 px-2 py-1 rounded text-xs"
          >
            {(Object.keys(PERIOD_LABELS) as LastFmPeriod[]).map((p) => (
              <option key={p} value={p}>{PERIOD_LABELS[p]}</option>
            ))}
          </select>
        )}
      </div>

      {tab === 'topArtists' && <TopArtists period={period} />}
      {tab === 'topTracks' && <TopTracks period={period} />}
      {tab === 'topAlbums' && <TopAlbums period={period} />}
      {tab === 'recent' && <RecentTracks />}
      {tab === 'charts' && <Charts />}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-xs ${active ? 'bg-accent text-black font-semibold' : 'bg-white/10 hover:bg-white/20'}`}
    >{children}</button>
  );
}

function TopArtists({ period }: { period: LastFmPeriod }) {
  const [items, setItems] = useState<LastFmArtist[] | null>(null);
  useEffect(() => { setItems(null); window.mp.lastfm.userTopArtists(period, 50).then((a) => setItems(a as LastFmArtist[])); }, [period]);
  if (!items) return <LoadingStrip label="Loading from Last.fm…" className="py-3" />;
  if (items.length === 0) return <div className="text-text-muted text-sm">No artists for this period yet.</div>;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
      {items.map((a, i) => (
        <div key={a.url} className="bg-bg-elev-1 p-3 rounded hover:bg-bg-elev-2 cursor-pointer" onClick={() => window.open(a.url, '_blank')}>
          {a.image ? <img src={a.image} className="aspect-square w-full rounded mb-2" alt="" /> : <div className="aspect-square w-full rounded mb-2 bg-bg-highlight flex items-center justify-center text-4xl">🎤</div>}
          <div className="text-sm font-medium truncate">#{i + 1} {a.name}</div>
          <div className="text-xs text-text-muted">{a.playcount?.toLocaleString() ?? 0} plays</div>
        </div>
      ))}
    </div>
  );
}

function TopTracks({ period }: { period: LastFmPeriod }) {
  const [items, setItems] = useState<LastFmTrackLite[] | null>(null);
  useEffect(() => { setItems(null); window.mp.lastfm.userTopTracks(period, 50).then((a) => setItems(a as LastFmTrackLite[])); }, [period]);
  if (!items) return <LoadingStrip label="Loading from Last.fm…" className="py-3" />;
  if (items.length === 0) return <div className="text-text-muted text-sm">No tracks for this period yet.</div>;
  return (
    <ol className="bg-bg-elev-1/40 rounded divide-y divide-white/5">
      {items.map((t, i) => (
        <li key={t.url} className="px-4 py-2 flex items-center gap-3 hover:bg-white/5 cursor-pointer" onClick={() => window.open(t.url, '_blank')}>
          <span className="w-8 text-right text-text-muted tabular-nums">{i + 1}</span>
          {t.image ? <img src={t.image} className="w-10 h-10 rounded" alt="" /> : <div className="w-10 h-10 rounded bg-bg-highlight" />}
          <div className="min-w-0 flex-1">
            <div className="text-sm truncate">{t.name}</div>
            <div className="text-xs text-text-muted truncate">{t.artist}</div>
          </div>
          <span className="text-xs text-text-muted tabular-nums">{t.playcount?.toLocaleString() ?? 0} plays</span>
        </li>
      ))}
    </ol>
  );
}

function TopAlbums({ period }: { period: LastFmPeriod }) {
  const [items, setItems] = useState<LastFmAlbum[] | null>(null);
  useEffect(() => { setItems(null); window.mp.lastfm.userTopAlbums(period, 50).then((a) => setItems(a as LastFmAlbum[])); }, [period]);
  if (!items) return <LoadingStrip label="Loading from Last.fm…" className="py-3" />;
  if (items.length === 0) return <div className="text-text-muted text-sm">No albums for this period yet.</div>;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
      {items.map((a, i) => (
        <div key={a.url} className="bg-bg-elev-1 p-3 rounded hover:bg-bg-elev-2 cursor-pointer" onClick={() => window.open(a.url, '_blank')}>
          {a.image ? <img src={a.image} className="aspect-square w-full rounded mb-2" alt="" /> : <div className="aspect-square w-full rounded mb-2 bg-bg-highlight" />}
          <div className="text-sm font-medium truncate">#{i + 1} {a.name}</div>
          <div className="text-xs text-text-muted truncate">{a.artist}</div>
          <div className="text-xs text-text-muted">{a.playcount?.toLocaleString() ?? 0} plays</div>
        </div>
      ))}
    </div>
  );
}

function RecentTracks() {
  const [items, setItems] = useState<LastFmTrackLite[] | null>(null);
  useEffect(() => {
    const load = () => window.mp.lastfm.userRecent(50).then((a) => setItems(a as LastFmTrackLite[]));
    load();
    const t = setInterval(load, 30_000);  // refresh every 30s for "now playing"
    return () => clearInterval(t);
  }, []);
  if (!items) return <LoadingStrip label="Loading from Last.fm…" className="py-3" />;
  if (items.length === 0) return <div className="text-text-muted text-sm">No scrobbles yet.</div>;
  return (
    <ol className="bg-bg-elev-1/40 rounded divide-y divide-white/5">
      {items.map((t, i) => (
        <li key={`${t.url}-${t.scrobbledAt ?? i}`} className="px-4 py-2 flex items-center gap-3 hover:bg-white/5 cursor-pointer" onClick={() => window.open(t.url, '_blank')}>
          {t.image ? <img src={t.image} className="w-10 h-10 rounded" alt="" /> : <div className="w-10 h-10 rounded bg-bg-highlight" />}
          <div className="min-w-0 flex-1">
            <div className="text-sm truncate">{t.name}</div>
            <div className="text-xs text-text-muted truncate">{t.artist}{t.album ? ` · ${t.album}` : ''}</div>
          </div>
          {t.nowPlaying ? (
            <span className="text-xs text-accent font-semibold uppercase tracking-wider">Now playing</span>
          ) : t.scrobbledAt ? (
            <span className="text-xs text-text-muted tabular-nums" title={new Date(t.scrobbledAt).toLocaleString()}>
              {relTime(t.scrobbledAt)}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function Charts() {
  const [artists, setArtists] = useState<LastFmArtist[] | null>(null);
  const [tracks, setTracks] = useState<LastFmTrackLite[] | null>(null);
  useEffect(() => {
    window.mp.lastfm.chartsArtists(30).then((a) => setArtists(a as LastFmArtist[]));
    window.mp.lastfm.chartsTracks(30).then((t) => setTracks(t as LastFmTrackLite[]));
  }, []);
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-3">Top artists worldwide</h3>
        {!artists ? <LoadingStrip label="Loading global top artists…" className="py-3" /> : (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {artists.map((a, i) => (
              <div key={a.url} className="bg-bg-elev-1 p-3 rounded hover:bg-bg-elev-2 cursor-pointer" onClick={() => window.open(a.url, '_blank')}>
                {a.image ? <img src={a.image} className="aspect-square w-full rounded mb-2" alt="" /> : <div className="aspect-square w-full rounded mb-2 bg-bg-highlight" />}
                <div className="text-sm font-medium truncate">#{i + 1} {a.name}</div>
                <div className="text-xs text-text-muted">{a.listeners?.toLocaleString() ?? 0} listeners</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div>
        <h3 className="text-lg font-semibold mb-3">Top tracks worldwide</h3>
        {!tracks ? <LoadingStrip label="Loading global top tracks…" className="py-3" /> : (
          <ol className="bg-bg-elev-1/40 rounded divide-y divide-white/5">
            {tracks.map((t, i) => (
              <li key={t.url} className="px-4 py-2 flex items-center gap-3 hover:bg-white/5 cursor-pointer" onClick={() => window.open(t.url, '_blank')}>
                <span className="w-8 text-right text-text-muted tabular-nums">{i + 1}</span>
                {t.image ? <img src={t.image} className="w-10 h-10 rounded" alt="" /> : <div className="w-10 h-10 rounded bg-bg-highlight" />}
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{t.name}</div>
                  <div className="text-xs text-text-muted truncate">{t.artist}</div>
                </div>
                <span className="text-xs text-text-muted tabular-nums">{t.listeners?.toLocaleString() ?? 0} listeners</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function relTime(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
