import { useMemo, useRef } from 'react';

/**
 * A-Z jump rail for long sorted lists (Albums, Artists, etc.). Fixed to the
 * right edge of the viewport; click a letter to scroll to the first item
 * whose label starts with it.
 *
 * Consumer contract: items in the rendered list must carry a
 * `data-alpha-letter="X"` attribute whose value matches what `firstLetter`
 * produces below. The rail's jump logic queries for that attribute rather
 * than tracking DOM refs — which means the rail doesn't care how the list
 * is rendered (cards, table rows, virtualised chunks), only that the
 * markers are present.
 *
 * Letters that have NO matching items are rendered dim and non-clickable,
 * so the rail also doubles as a visual table-of-contents for the collection.
 */

interface Props {
  /** The items to index. Determines which letters light up. */
  items: readonly unknown[];
  /** Extract the label used to derive the first letter. Must be stable. */
  labelOf: (item: any) => string | null | undefined;
  /** Tooltip suffix when there are no items under a letter. */
  emptyLabel?: string;
}

const LETTERS: readonly string[] = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];

/**
 * Derive the "alpha bucket" for a string:
 *  - strip leading whitespace + decorative punctuation
 *    ("  .977 Country" → "977 Country")
 *  - if the first surviving char is a letter, return it uppercase
 *  - otherwise bucket as '#' (numbers, scripts we can't alphabetise)
 *
 * Exported so list renderers can use the exact same logic when stamping
 * their items with `data-alpha-letter=…`.
 */
export function firstLetter(s: string | null | undefined): string {
  if (!s) return '#';
  const cleaned = s.trim().replace(/^[^\p{L}\p{N}]+/u, '');
  if (!cleaned) return '#';
  const c = cleaned.charAt(0);
  // Covers Basic Latin A-Z + accented European letters. Non-Latin scripts
  // (Cyrillic, Greek, CJK) also fall through to the alphabetic branch via
  // Unicode property escape matching, but we bucket them as '#' because
  // there's no letter in our A-Z rail that would match them.
  if (/^[A-Za-z]$/.test(c)) return c.toUpperCase();
  return '#';
}

export default function AlphaRail({ items, labelOf, emptyLabel }: Props) {
  const present = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) set.add(firstLetter(labelOf(it)));
    return set;
  }, [items, labelOf]);

  // Cycle-through-section state. Pressing T once lands on the first
  // T-item; pressing T again advances to the second T-item, and so on.
  // When you run out, it wraps back to the first. Switching to a
  // different letter resets the index. Kept in refs so re-renders
  // triggered by the underlying list (new items arriving, filter
  // changes) don't jitter the cycle.
  const lastLetterRef = useRef<string | null>(null);
  const letterIndexRef = useRef<number>(0);

  function jump(letter: string) {
    // Grab every element under this letter in DOM order — the list is
    // sorted, so DOM order is the same as alphabetical order within
    // the letter group.
    const all = document.querySelectorAll(`[data-alpha-letter="${letter}"]`);
    if (all.length === 0) return;

    // Pick the index: reset to 0 on letter change, otherwise advance
    // and wrap. Wrapping (instead of clamping) gives a natural "keep
    // pressing to explore everything under this letter" feel rather
    // than silently dead-ending on the last item.
    let idx: number;
    if (lastLetterRef.current !== letter) {
      idx = 0;
    } else {
      idx = (letterIndexRef.current + 1) % all.length;
    }
    lastLetterRef.current = letter;
    letterIndexRef.current = idx;

    const el = all[idx] as HTMLElement;

    // Explicit scroll computation rather than `el.scrollIntoView()`.
    // scrollIntoView's smooth-animation path is inconsistent when
    // called repeatedly in quick succession (clicks mid-flight can
    // land off-target); computing scrollTop ourselves keeps the final
    // position deterministic + gives us control over the top offset.
    let scroller: HTMLElement | null = el.parentElement;
    while (scroller) {
      const style = getComputedStyle(scroller);
      const canScroll = /(auto|scroll|overlay)/.test(style.overflowY);
      if (canScroll && scroller.scrollHeight > scroller.clientHeight) break;
      scroller = scroller.parentElement;
    }
    if (!scroller) scroller = (document.scrollingElement ?? document.documentElement) as HTMLElement;

    const elRect = el.getBoundingClientRect();
    const scRect = scroller.getBoundingClientRect();
    // 8px of breathing room above the target so it isn't flush against
    // the viewport edge / any floating chrome above.
    const target = scroller.scrollTop + (elRect.top - scRect.top) - 8;
    scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }

  return (
    <nav
      aria-label="Jump to letter"
      // Fixed on the right edge so it stays pinned as the list scrolls.
      // z-30 puts it above content but below modals/dropdowns. Narrow width
      // + backdrop-blur keeps it from visually occluding the grid underneath.
      className="fixed right-1 top-1/2 -translate-y-1/2 z-30 bg-bg-elev-1/70 backdrop-blur-sm rounded-lg py-1 px-0.5 flex flex-col gap-0 text-[10px] font-semibold select-none"
    >
      {LETTERS.map((L) => {
        const has = present.has(L);
        return (
          <button
            key={L}
            onClick={() => has && jump(L)}
            disabled={!has}
            className={`w-5 h-4 leading-4 text-center rounded transition ${
              has
                ? 'text-text-primary hover:bg-accent hover:text-black cursor-pointer'
                : 'text-text-muted/30 cursor-default'
            }`}
            title={has ? `Jump to ${L}` : (emptyLabel ?? `No entries under ${L}`)}
            aria-label={has ? `Jump to ${L}` : `No entries under ${L}`}
            tabIndex={has ? 0 : -1}
          >
            {L}
          </button>
        );
      })}
    </nav>
  );
}
