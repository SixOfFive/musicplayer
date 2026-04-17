import { useEffect, useState } from 'react';
import type { AppSettings, MetadataProvider, MetadataProviderId } from '../../../shared/types';

export default function ScanSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [providers, setProviders] = useState<MetadataProvider[]>([]);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  async function refresh() {
    setSettings(await window.mp.settings.get());
    setProviders(await window.mp.metadata.providers());
  }
  useEffect(() => { refresh(); }, []);

  if (!settings) return <div className="text-text-muted">Loading…</div>;

  async function patch(p: Partial<AppSettings['scan']>) {
    const next = await window.mp.settings.set({ scan: p });
    setSettings(next as AppSettings);
  }

  const activeIds = new Set(settings.scan.providers);

  function toggleProvider(id: MetadataProviderId) {
    const next = activeIds.has(id)
      ? settings!.scan.providers.filter((p) => p !== id)
      : [...settings!.scan.providers, id];
    patch({ providers: next });
  }

  async function testProvider(id: string) {
    setTesting(id);
    const res: any = await window.mp.metadata.testProvider(id);
    setTestResult((r) => ({ ...r, [id]: res.ok ? `OK (HTTP ${res.status})` : `Fail${res.message ? `: ${res.message}` : ` (HTTP ${res.status})`}` }));
    setTesting(null);
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold mb-1">Scan behavior</h2>
        <div className="bg-bg-elev-2 rounded p-4 space-y-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={settings.scan.incremental} onChange={(e) => patch({ incremental: e.target.checked })} />
            Incremental scan (only changed files)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={settings.scan.fetchCoverArt} onChange={(e) => patch({ fetchCoverArt: e.target.checked })} />
            Fetch & cache cover art
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={settings.scan.writeBackTags} onChange={(e) => patch({ writeBackTags: e.target.checked })} />
            Write fetched tags back into files (risky — makes an edit per track)
          </label>
          <div>
            <div className="text-text-muted mb-1">File extensions</div>
            <input
              value={settings.scan.extensions.join(', ')}
              onChange={(e) => patch({ extensions: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })}
              className="w-full bg-bg-base px-2 py-1.5 rounded font-mono text-xs"
            />
            <p className="text-xs text-text-muted mt-1">mp3, flac, wav are supported out of the box.</p>
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-1">Metadata providers</h2>
        <p className="text-sm text-text-muted mb-3">
          During a scan, these services are consulted in order to fill in missing tags, cover art, or verify lossless rips.
        </p>
        <div className="bg-bg-elev-2 rounded divide-y divide-white/5">
          {providers.map((p) => (
            <div key={p.id} className="p-4 flex items-start gap-3">
              <input type="checkbox" className="mt-1" checked={activeIds.has(p.id)} onChange={() => toggleProvider(p.id)} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <div className="font-medium">{p.label}</div>
                  {p.freeTier && <span className="text-xs px-2 py-0.5 rounded bg-accent/20 text-accent">Free</span>}
                  {p.requiresKey && <span className="text-xs px-2 py-0.5 rounded bg-white/10 text-text-muted">API key</span>}
                </div>
                <p className="text-xs text-text-muted mt-1">{p.description}</p>
                {p.requiresKey && (
                  <input
                    placeholder="API key"
                    defaultValue={settings.scan.apiKeys[p.id] ?? ''}
                    onBlur={(e) => patch({ apiKeys: { ...settings.scan.apiKeys, [p.id]: e.target.value } })}
                    className="mt-2 w-full bg-bg-base px-2 py-1 rounded text-xs font-mono"
                  />
                )}
                <div className="flex items-center gap-3 mt-2">
                  <button onClick={() => testProvider(p.id)} className="text-xs text-accent hover:underline">
                    {testing === p.id ? 'Testing…' : 'Test connection'}
                  </button>
                  {testResult[p.id] && <span className="text-xs text-text-muted">{testResult[p.id]}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
