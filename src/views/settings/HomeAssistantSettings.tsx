// Settings panel for Home Assistant integration. Captures baseUrl +
// long-lived access token and lets the user verify the pair via HA's
// /api/ + /api/config endpoints before committing.
//
// Security notes, per the project's "don't leak tokens" rule:
//
//   1. The token round-trips via IPC (unavoidable — main is the only
//      process that talks to HA) but never appears in a log line
//      originated from the renderer. The console.log calls in this
//      file are scoped to non-sensitive fields (connection status,
//      entity counts). If you add another log, keep the token out.
//
//   2. We treat the token like a password in the UI: masked input with
//      show/hide toggle, masked placeholder (•••…••• + last-4) when a
//      value is already saved so the user knows one's there without
//      the actual string being recovered by an onlooker at a screen.
//
//   3. Saving is explicit (Save button). Test-connection doesn't save
//      — so a misconfigured token never gets persisted just because
//      the user tabbed out.

import { useEffect, useState } from 'react';
import type { AppSettings } from '../../../shared/types';
import { useHomeAssistant } from '../../store/homeassistant';

export default function HomeAssistantSettings() {
  const [s, setS] = useState<AppSettings | null>(null);

  // Form-local state for the editable fields. Kept separate from the
  // persisted settings so the user can abandon unsaved edits by navigating
  // away without accidentally committing a half-typed token.
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [tokenTouched, setTokenTouched] = useState(false);
  const [showToken, setShowToken] = useState(false);

  // Test-connection feedback. null = not tested yet (or form changed since);
  // object = last result.
  const [testResult, setTestResult] = useState<null | { ok: boolean; message: string }>(null);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);

  const refreshHaStore = useHomeAssistant((x) => x.refreshEntities);

  useEffect(() => {
    window.mp.settings.get().then((res: any) => {
      setS(res);
      const ha = res.homeAssistant ?? { enabled: false, baseUrl: '', token: '' };
      setEnabled(!!ha.enabled);
      setBaseUrl(ha.baseUrl || '');
      setToken(ha.token || '');
    });
  }, []);

  if (!s) return null;

  const hasSavedToken = (s.homeAssistant?.token ?? '').length > 0;
  const tokenLast4 = hasSavedToken ? (s.homeAssistant!.token).slice(-4) : '';

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const r: any = await (window.mp as any).ha.test(baseUrl.trim(), token);
      if (r.ok) {
        setTestResult({ ok: true, message: `Connected to Home Assistant ${r.version}.` });
      } else {
        setTestResult({ ok: false, message: r.error || 'Connection failed.' });
      }
    } catch (err: any) {
      setTestResult({ ok: false, message: err?.message ?? String(err) });
    }
    setTesting(false);
  }

  async function save() {
    // Trim trailing slashes; HA's REST endpoints don't care but it
    // keeps the logged URL tidy and prevents accidental `//api/...`.
    const cleanBase = baseUrl.trim().replace(/\/+$/, '');
    const patch: Partial<AppSettings['homeAssistant']> = {
      enabled,
      baseUrl: cleanBase,
    };
    // Only write the token when the user actually typed a new one.
    // This lets a user toggle enabled / edit baseUrl without having
    // to re-enter their token every time.
    if (tokenTouched) patch.token = token;
    const next = await window.mp.settings.set({ homeAssistant: patch } as any) as AppSettings;
    setS(next);
    setTokenTouched(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    // Refresh the store so the picker reflects the new config right away.
    void refreshHaStore();
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">Home Assistant</h2>

      <div className="bg-bg-elev-2 rounded p-4 space-y-4 text-sm">
        <p className="text-text-secondary">
          Play to any <code className="text-text-primary">media_player.*</code> entity your
          Home Assistant install exposes — HA Preview, Sonos, AirPlay speakers,
          Squeezebox, MusicAssistant, Snapcast, smart AVRs, and so on. Requires
          a long-lived access token generated on your HA profile page
          (Profile → Security → Long-Lived Access Tokens).
        </p>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Enable Home Assistant output</span>
        </label>

        <div className="flex items-center gap-3">
          <label className="w-32 text-text-muted">Base URL</label>
          <input
            type="url"
            placeholder="https://homeassistant.local:8123"
            value={baseUrl}
            onChange={(e) => { setBaseUrl(e.target.value); setTestResult(null); }}
            className="bg-bg-base px-2 py-1 rounded flex-1 font-mono text-xs"
          />
        </div>

        <div className="flex items-center gap-3">
          <label className="w-32 text-text-muted">Access token</label>
          <input
            type={showToken ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            placeholder={hasSavedToken && !tokenTouched ? `•••••••••••••• (ends in ${tokenLast4})` : 'paste long-lived token'}
            value={tokenTouched ? token : ''}
            onChange={(e) => { setToken(e.target.value); setTokenTouched(true); setTestResult(null); }}
            className="bg-bg-base px-2 py-1 rounded flex-1 font-mono text-xs"
          />
          <button
            type="button"
            onClick={() => setShowToken((v) => !v)}
            className="px-2 py-1 text-xs text-text-muted hover:text-white"
            title={showToken ? 'Hide token' : 'Show token'}
          >
            {showToken ? 'hide' : 'show'}
          </button>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={test}
            disabled={testing || !baseUrl.trim() || (!tokenTouched && !hasSavedToken)}
            className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-40 text-xs inline-flex items-center gap-2"
          >
            {testing && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            Test connection
          </button>
          <button
            onClick={save}
            className="px-3 py-1.5 rounded bg-accent text-black hover:bg-accent-hover text-xs font-semibold"
          >Save</button>
          {saved && <span className="text-xs text-emerald-400">Saved.</span>}
        </div>

        {testResult && (
          <div className={`text-xs rounded px-3 py-2 ${testResult.ok ? 'bg-emerald-400/10 text-emerald-300' : 'bg-red-500/10 text-red-300'}`}>
            {testResult.message}
          </div>
        )}

        <p className="text-xs text-text-muted pt-2 border-t border-white/5">
          The token is stored in <code>settings.json</code> under your app's
          user-data directory and sent only to the Home Assistant URL you
          specify. It is never logged or transmitted elsewhere.
        </p>
      </div>
    </div>
  );
}
