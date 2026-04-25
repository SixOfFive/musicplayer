import { useEffect, useState } from 'react';
import type { AppSettings } from '../../../shared/types';

/**
 * Settings tab for time-synced lyrics (LRCLib + local .lrc).
 *
 * The actual fetch logic lives in `electron/services/lyrics.ts` — this
 * tab just exposes the four user-tunable knobs:
 *
 *   - enabled              master on/off (hides the NowPlayingBar button)
 *   - autoShow             open the panel on every track change
 *   - showTimedHighlight   active-line follow-along
 *   - autoScroll           scroll the active line into view
 *
 * No API key field — LRCLib is free, anonymous, no rate limit. If we
 * ever add Musixmatch / Genius (paid + auth flow) those go here too.
 */
export default function LyricsSettings() {
  const [s, setS] = useState<AppSettings | null>(null);
  useEffect(() => { window.mp.settings.get().then(setS); }, []);
  if (!s) return null;

  async function patch(p: Partial<AppSettings['lyrics']>) {
    setS((await window.mp.settings.set({ lyrics: p })) as AppSettings);
  }

  const ly = s.lyrics ?? {
    enabled: true, autoShow: false, showTimedHighlight: true, autoScroll: true,
    writeLrcAlongsideAudio: true,
  };

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">Lyrics</h2>
      <p className="text-sm text-text-muted">
        Time-synced lyrics are fetched from{' '}
        <a
          href="https://lrclib.net"
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >LRCLib</a>{' '}
        — a free, community-maintained service that requires no API key.
        Local <code>.lrc</code> files next to your audio files are checked
        first, so anything you've already collected travels with the music.
      </p>

      <div className="bg-bg-elev-2 rounded p-4 space-y-3 text-sm">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={ly.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <span>Enable lyrics panel</span>
          <span className="text-xs text-text-muted ml-2">
            Hides the lyrics button in the player bar when off.
          </span>
        </label>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={ly.autoShow}
            disabled={!ly.enabled}
            onChange={(e) => patch({ autoShow: e.target.checked })}
          />
          <span>Auto-open lyrics on track change</span>
          <span className="text-xs text-text-muted ml-2">
            Off by default — most users prefer the panel on demand.
          </span>
        </label>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={ly.showTimedHighlight}
            disabled={!ly.enabled}
            onChange={(e) => patch({ showTimedHighlight: e.target.checked })}
          />
          <span>Highlight active line as the song plays</span>
        </label>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={ly.autoScroll}
            disabled={!ly.enabled || !ly.showTimedHighlight}
            onChange={(e) => patch({ autoScroll: e.target.checked })}
          />
          <span>Auto-scroll the active line into view</span>
        </label>

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={ly.writeLrcAlongsideAudio !== false}
            disabled={!ly.enabled}
            onChange={(e) => patch({ writeLrcAlongsideAudio: e.target.checked })}
            className="mt-1"
          />
          <span>
            Save lyrics alongside audio files (<code>.lrc</code>)
            <div className="text-xs text-text-muted mt-0.5">
              Writes <code>SongName.lrc</code> next to <code>SongName.flac</code> so
              the lyrics travel with the music. Other apps (foobar2000,
              MusicBee, Plex, Jellyfin) auto-pick them up. Never overwrites
              an existing .lrc — your hand-curated files are safe.
            </div>
          </span>
        </label>
      </div>

      <div className="bg-bg-elev-2 rounded p-4 text-xs text-text-muted space-y-2">
        <div className="font-semibold text-text-secondary">Cache + privacy</div>
        <p>
          Fetched lyrics are cached in your local SQLite library so subsequent
          plays don't re-hit LRCLib. The cache is keyed by track id — retag a
          file and re-fetch from the lyrics panel to refresh.
        </p>
        <p>
          LRCLib queries send the artist + title + album + duration of the
          track over HTTPS. No account, no cookies, no IP logging on their
          side per their published policy.
        </p>
      </div>
    </div>
  );
}
