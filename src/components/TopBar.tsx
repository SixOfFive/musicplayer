import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';

export default function TopBar() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [scanning, setScanning] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoFwd, setCanGoFwd] = useState(false);

  // History API doesn't expose canGoBack/canGoForward directly, so watch the
  // popstate event and our own navigation signals to keep buttons enabled-state
  // in sync. We estimate via history.length: if > 1, there's probably a back.
  useEffect(() => {
    const update = () => {
      setCanGoBack(window.history.length > 1);
      // No reliable way to detect forward availability without custom tracking.
      // Optimistic: assume forward only after the user has used back.
      setCanGoFwd((prev) => prev);
    };
    update();
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);

  useEffect(() => {
    const off = window.mp.scan.onProgress((p: any) => {
      const active = p?.phase && p.phase !== 'done' && p.phase !== 'error' && p.phase !== 'idle';
      setScanning(!!active);
    });
    return () => { off?.(); };
  }, []);

  async function startScan() {
    await window.mp.scan.start();
  }

  return (
    <div className="titlebar-drag h-14 flex items-center gap-3 px-6 border-b border-white/5">
      <div className="titlebar-nodrag flex items-center gap-2">
        <button
          onClick={() => { nav(-1); setCanGoFwd(true); }}
          disabled={!canGoBack}
          className="w-9 h-9 rounded-full bg-black/50 hover:bg-black/70 disabled:opacity-30 disabled:hover:bg-black/50 text-white flex items-center justify-center text-xl leading-none transition"
          title="Back"
          aria-label="Back"
        >‹</button>
        <button
          onClick={() => nav(1)}
          disabled={!canGoFwd}
          className="w-9 h-9 rounded-full bg-black/50 hover:bg-black/70 disabled:opacity-30 disabled:hover:bg-black/50 text-white flex items-center justify-center text-xl leading-none transition"
          title="Forward"
          aria-label="Forward"
        >›</button>
      </div>
      <div className="titlebar-nodrag flex-1 max-w-md">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) nav(`/library?q=${encodeURIComponent(q)}`); }}
          placeholder="Search your library"
          className="w-full bg-bg-elev-2 text-sm px-4 py-2 rounded-full outline-none focus:ring-1 focus:ring-white/30 text-text-primary"
        />
      </div>
      <div className="flex-1" />
      <div className="titlebar-nodrag flex items-center gap-2">
        <button
          onClick={startScan}
          disabled={scanning}
          className="text-sm px-3 py-1 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-50 text-white inline-flex items-center gap-2"
          title="Re-scan music folders"
        >
          {scanning && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
          {scanning ? 'Scanning…' : 'Rescan'}
        </button>
        <button onClick={() => nav('/settings')} className="text-text-secondary hover:text-white text-sm px-3 py-1">Settings</button>
      </div>
    </div>
  );
}
