import { useEffect, useState } from 'react';

export default function FirstRun({ onDone }: { onDone: () => void }) {
  const [defaultDir, setDefaultDir] = useState<string>('');
  const [picked, setPicked] = useState<string>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.mp.library.defaultMusicDir().then((d) => {
      setDefaultDir(d);
      setPicked(d);
    });
  }, []);

  async function choose() {
    const d = await window.mp.library.pickDir();
    if (d) setPicked(d);
  }

  async function finish() {
    setBusy(true);
    if (picked) {
      await window.mp.library.addDir(picked);
    }
    await window.mp.settings.set({ firstRunComplete: true } as any);

    // Kick off the first scan and keep the modal up until we see the first
    // progress event — otherwise the user stares at a blank Home view with no
    // indication anything is happening.
    let gotProgress = false;
    const off = window.mp.scan.onProgress(() => {
      if (gotProgress) return;
      gotProgress = true;
      off?.();
      onDone();
    });

    window.mp.scan.start();

    // Fallback: if no event in 4s (e.g. empty folder), close anyway.
    setTimeout(() => {
      if (!gotProgress) { off?.(); onDone(); }
    }, 4000);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8">
      <div className="bg-bg-elev-1 rounded-xl w-full max-w-lg p-8">
        <h2 className="text-2xl font-bold mb-2">Welcome</h2>
        <p className="text-sm text-text-secondary mb-6">
          Pick the folder that holds your music. MusicPlayer will scan it (recursively),
          read tags, cache cover art, and build your library database. You can add more
          folders later in Settings.
        </p>
        <div className="bg-bg-base rounded p-3 text-xs font-mono break-all">{picked || '—'}</div>
        <div className="flex items-center gap-2 mt-4">
          <button onClick={choose} className="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-full text-sm">Choose folder…</button>
          {defaultDir && picked !== defaultDir && (
            <button onClick={() => setPicked(defaultDir)} className="text-xs text-accent hover:underline">Reset to OS default ({defaultDir})</button>
          )}
        </div>
        <p className="text-xs text-text-muted mt-4">
          The default follows your OS's standard Music folder (XDG <code className="font-mono">MUSIC</code> on Linux/KDE,
          <code className="font-mono">~/Music</code> on macOS, <code className="font-mono">%USERPROFILE%\Music</code> on Windows).
          Cover art and the library DB live under your app data directory.
        </p>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={() => { window.mp.settings.set({ firstRunComplete: true } as any); onDone(); }} className="text-text-muted text-sm px-3 py-2">Skip for now</button>
          <button onClick={finish} disabled={!picked || busy} className="bg-accent hover:bg-accent-hover disabled:opacity-50 text-black font-semibold px-5 py-2 rounded-full text-sm inline-flex items-center gap-2">
            {busy && <span className="w-3 h-3 border-2 border-black border-t-transparent rounded-full animate-spin" />}
            {busy ? 'Starting scan…' : 'Start scanning'}
          </button>
        </div>
      </div>
    </div>
  );
}
