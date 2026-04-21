// Year-tag audit + fix panel. Slotted into Settings → Library.
//
// Flow:
//   1. User clicks "Scan for bad years" → fires tags.auditYears IPC,
//      backend walks the tracks table and returns a categorised list
//      of proposed fixes (two-digit years, year=0 with album consensus,
//      future years, album-outliers).
//   2. UI renders per-category collapsible sections with checkboxes;
//      everything defaults selected so a one-click "Fix selected" is
//      the common path.
//   3. "Fix selected" calls tags.fixYears with the checked entries.
//      Backend rewrites each file's date/year tag via ffmpeg's
//      -c copy mode (no re-encode), updates the DB row, and streams
//      progress events back.
//   4. Progress bar renders during the fix. On completion shows
//      a success count and any errors.
//
// The "album-outlier" category is shown with a caveat label — it's
// the one category where the heuristic can genuinely be wrong (e.g.
// a re-release mixing original-year tracks with reissue-year ones).
// Defaults unchecked; user must opt in per-row.

import { useEffect, useState } from 'react';
import type { YearAuditResult, YearTagFix, YearTagIssue, YearFixProgress } from '../../../shared/types';

const CATEGORY_LABELS: Record<YearTagIssue, { title: string; blurb: string; confidence: 'high' | 'medium' }> = {
  'two-digit': {
    title: 'Two-digit years',
    blurb: 'Tags like "96" expanded to 1996 via Y2K pivot (≤30 → 20xx, else 19xx). High confidence.',
    confidence: 'high',
  },
  'zero': {
    title: 'Zero year with album consensus',
    blurb: 'Tracks with year=0 where the album has a strong majority year (≥60% of tracks agree).',
    confidence: 'high',
  },
  'future': {
    title: 'Future years',
    blurb: 'Years past next year, corrected to album consensus when available.',
    confidence: 'high',
  },
  'album-outlier': {
    title: 'Album outliers',
    blurb: 'Track year disagrees with the album\'s strong majority. Sometimes intentional (re-release with original-year tracks); review before fixing.',
    confidence: 'medium',
  },
};

export default function YearTagAudit() {
  const [audit, setAudit] = useState<YearAuditResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState<YearFixProgress | null>(null);
  const [fixing, setFixing] = useState(false);

  // Subscribe to progress events for the whole mount — cheap, fires
  // only when a fix is in flight. Handler seeds the `progress` state
  // which drives the progress bar.
  useEffect(() => {
    const off = (window.mp as any).tags?.onFixProgress?.((p: YearFixProgress) => {
      setProgress(p);
      if (p.finished) setFixing(false);
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  async function scan() {
    setScanning(true);
    setAudit(null);
    setProgress(null);
    try {
      const r: YearAuditResult = await (window.mp as any).tags.auditYears();
      setAudit(r);
      // Default-select everything in high-confidence categories; leave
      // medium-confidence (album-outlier) for the user to opt in per-row.
      const pre = new Set<number>();
      for (const f of r.fixes) {
        if (CATEGORY_LABELS[f.issue].confidence === 'high') pre.add(f.trackId);
      }
      setSelected(pre);
    } catch (err: any) {
      console.error('[tag-audit] scan failed', err);
    }
    setScanning(false);
  }

  function toggle(trackId: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  }

  function toggleAll(fixes: YearTagFix[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const f of fixes) {
        if (on) next.add(f.trackId);
        else    next.delete(f.trackId);
      }
      return next;
    });
  }

  async function applyFixes() {
    if (!audit || selected.size === 0) return;
    const payload = audit.fixes
      .filter((f) => selected.has(f.trackId) && f.suggestedYear !== null)
      .map((f) => ({ trackId: f.trackId, path: f.path, year: f.suggestedYear as number }));
    if (payload.length === 0) return;
    setFixing(true);
    setProgress({ done: 0, total: payload.length, currentPath: null, errors: [], finished: false });
    try {
      await (window.mp as any).tags.fixYears(payload);
      // Re-audit so the fixed rows fall out of the display.
      await scan();
    } catch (err: any) {
      console.error('[tag-audit] fix failed', err);
      setFixing(false);
    }
  }

  // Group fixes by issue for rendering. Preserve audit's original order
  // within each group (it's already sensible — tracks walk DB order).
  const groups: Array<[YearTagIssue, YearTagFix[]]> = audit ? (
    (['two-digit', 'zero', 'future', 'album-outlier'] as YearTagIssue[])
      .map((k) => [k, audit.fixes.filter((f) => f.issue === k)] as [YearTagIssue, YearTagFix[]])
      .filter(([, fs]) => fs.length > 0)
  ) : [];

  return (
    <div className="bg-bg-elev-2 rounded p-4 space-y-4 text-sm">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h3 className="font-semibold">Year-tag audit</h3>
          <p className="text-text-muted text-xs mt-1">
            Finds tracks with suspect release years — two-digit tags like "96", zero/future placeholders,
            or single tracks disagreeing with their album's majority year — and rewrites the file tag
            via ffmpeg (no audio re-encoding, tags only). The DB is updated to match.
          </p>
        </div>
        <button
          onClick={scan}
          disabled={scanning || fixing}
          className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-40 text-xs inline-flex items-center gap-2 flex-shrink-0"
        >
          {scanning && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
          Scan for bad years
        </button>
      </div>

      {audit && (
        <>
          {audit.summary.total === 0 ? (
            <div className="text-emerald-400 text-xs">No year-tag issues found. Clean library.</div>
          ) : (
            <div className="text-xs text-text-muted">
              Found <span className="text-text-primary font-semibold">{audit.summary.total}</span> potential fixes:
              {audit.summary.twoDigit > 0 && <> · {audit.summary.twoDigit} two-digit</>}
              {audit.summary.zero > 0 && <> · {audit.summary.zero} zero-year</>}
              {audit.summary.future > 0 && <> · {audit.summary.future} future-year</>}
              {audit.summary.albumOutlier > 0 && <> · {audit.summary.albumOutlier} album-outlier</>}
            </div>
          )}

          {groups.map(([issue, fixes]) => {
            const meta = CATEGORY_LABELS[issue];
            const groupSelected = fixes.filter((f) => selected.has(f.trackId)).length;
            return (
              <details key={issue} open className="bg-bg-base rounded p-3 space-y-2">
                <summary className="cursor-pointer flex items-center gap-2">
                  <span className="font-medium">{meta.title}</span>
                  <span className="text-text-muted text-xs">({fixes.length})</span>
                  {meta.confidence === 'medium' && (
                    <span className="text-[10px] text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">review</span>
                  )}
                  <span className="ml-auto text-xs text-text-muted">{groupSelected} selected</span>
                </summary>

                <p className="text-xs text-text-muted">{meta.blurb}</p>

                <div className="flex gap-2">
                  <button
                    onClick={() => toggleAll(fixes, true)}
                    className="text-[10px] text-text-muted hover:text-white"
                  >Select all</button>
                  <span className="text-text-muted/50">·</span>
                  <button
                    onClick={() => toggleAll(fixes, false)}
                    className="text-[10px] text-text-muted hover:text-white"
                  >Select none</button>
                </div>

                {/* Capped visible list — long categories (e.g. 50+ two-digit
                    fixes) get the rest behind a "show all" disclosure so the
                    settings panel doesn't balloon. */}
                <FixList fixes={fixes} selected={selected} onToggle={toggle} />
              </details>
            );
          })}

          {audit.summary.total > 0 && (
            <div className="flex items-center gap-3 pt-2 border-t border-white/5">
              <button
                onClick={applyFixes}
                disabled={fixing || selected.size === 0}
                className="px-4 py-1.5 rounded bg-accent text-black disabled:opacity-40 text-xs font-semibold inline-flex items-center gap-2"
              >
                {fixing && <span className="w-3 h-3 border-2 border-black/50 border-t-transparent rounded-full animate-spin" />}
                Fix {selected.size} selected
              </button>
              <div className="text-xs text-text-muted">
                Writes new date/year tags to each file; no audio re-encoding.
              </div>
            </div>
          )}
        </>
      )}

      {progress && (
        <div className="bg-bg-base rounded p-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className={progress.finished ? 'text-emerald-400' : 'text-text-primary'}>
              {progress.finished
                ? `Done — ${progress.done - progress.errors.length} fixed${progress.errors.length > 0 ? `, ${progress.errors.length} failed` : ''}`
                : `Fixing ${progress.done} / ${progress.total}…`}
            </span>
            <span className="text-text-muted tabular-nums">
              {Math.round((progress.done / Math.max(1, progress.total)) * 100)}%
            </span>
          </div>
          <div className="h-1 bg-white/5 rounded overflow-hidden">
            <div
              className={`h-full transition-[width] duration-200 ${progress.finished ? 'bg-emerald-500' : 'bg-accent'}`}
              style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
            />
          </div>
          {progress.currentPath && !progress.finished && (
            <div className="text-[10px] text-text-muted truncate">{progress.currentPath}</div>
          )}
          {progress.errors.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-red-400">
                {progress.errors.length} error{progress.errors.length === 1 ? '' : 's'}
              </summary>
              <ul className="mt-1 ml-4 list-disc text-red-400/80 space-y-0.5 max-h-40 overflow-y-auto">
                {progress.errors.map((e, i) => (
                  <li key={i} className="text-[11px]">
                    <span className="font-mono">{e.path.split(/[/\\]/).pop()}</span>: {e.error}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/** Collapsible long-list renderer. Shows the first 50 rows, then a
 *  "show N more" toggle. Keeps the settings panel fast even on the
 *  biggest bad-year categories (thousands of rows is rare, but a
 *  few hundred two-digit years is totally plausible on a large
 *  library that's been rescanned from old ID3v1-style tags). */
function FixList({
  fixes, selected, onToggle,
}: {
  fixes: YearTagFix[];
  selected: Set<number>;
  onToggle: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const CAP = 50;
  const visible = expanded ? fixes : fixes.slice(0, CAP);
  return (
    <div className="space-y-1">
      {visible.map((f) => (
        <label
          key={f.trackId}
          className="flex items-center gap-2 px-2 py-1 rounded hover:bg-white/5 cursor-pointer"
        >
          <input
            type="checkbox"
            checked={selected.has(f.trackId)}
            onChange={() => onToggle(f.trackId)}
            className="flex-shrink-0"
          />
          <div className="min-w-0 flex-1">
            <div className="text-xs text-text-primary truncate">
              {f.title}
              {f.artist && <span className="text-text-muted"> · {f.artist}</span>}
              {f.album && <span className="text-text-muted"> · {f.album}</span>}
            </div>
            <div className="text-[10px] text-text-muted truncate">{f.reason}</div>
          </div>
          <div className="text-[10px] tabular-nums text-text-muted flex-shrink-0">
            <span className="text-red-400/80">{f.currentYear ?? '—'}</span>
            <span className="mx-1">→</span>
            <span className="text-emerald-400">{f.suggestedYear ?? '—'}</span>
          </div>
        </label>
      ))}
      {fixes.length > CAP && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="text-xs text-text-muted hover:text-white px-2 py-1"
        >
          Show {fixes.length - CAP} more…
        </button>
      )}
    </div>
  );
}
