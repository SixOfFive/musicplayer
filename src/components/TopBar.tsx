import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';

export default function TopBar() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [scanning, setScanning] = useState(false);

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
        <button onClick={() => history.back()} className="w-8 h-8 rounded-full bg-black/40 text-text-secondary hover:text-white">‹</button>
        <button onClick={() => history.forward()} className="w-8 h-8 rounded-full bg-black/40 text-text-secondary hover:text-white">›</button>
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
