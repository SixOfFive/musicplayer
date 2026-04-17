import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';

export default function TopBar() {
  const nav = useNavigate();
  const location = useLocation();
  const navType = useNavigationType(); // 'PUSH' | 'POP' | 'REPLACE'
  const [q, setQ] = useState('');
  const [scanning, setScanning] = useState(false);

  // The browser's native `history.length` and `popstate` can't tell us which
  // side of the stack we're on — so we maintain our own history model that
  // mirrors what the user has navigated through.
  //
  //   stack  : ordered list of location keys we've visited (push order)
  //   cursor : index of the CURRENT entry within `stack`
  //
  //   → PUSH truncates everything after `cursor` and appends a new entry.
  //   → POP  (back/forward) finds the entry's existing index and moves cursor.
  //   → REPLACE overwrites the entry at `cursor`.
  const stack = useRef<string[]>([]);
  const cursor = useRef(-1);
  const [, force] = useState(0);
  const bump = () => force((n) => n + 1);

  useEffect(() => {
    const key = location.key;
    if (cursor.current < 0) {
      // Very first render.
      stack.current = [key];
      cursor.current = 0;
    } else if (navType === 'PUSH') {
      stack.current = stack.current.slice(0, cursor.current + 1);
      stack.current.push(key);
      cursor.current = stack.current.length - 1;
    } else if (navType === 'POP') {
      const idx = stack.current.indexOf(key);
      if (idx >= 0) cursor.current = idx;
      else { stack.current.push(key); cursor.current = stack.current.length - 1; }
    } else if (navType === 'REPLACE') {
      stack.current[cursor.current] = key;
    }
    bump();
  }, [location.key, navType]);

  const canGoBack = cursor.current > 0;
  const canGoFwd = cursor.current < stack.current.length - 1;

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
          onClick={() => nav(-1)}
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
