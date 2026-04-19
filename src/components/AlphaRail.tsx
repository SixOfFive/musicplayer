import { useMemo } from 'react';

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

  function jump(letter: string) {
    // `querySelector` walks the document, returning the FIRST match — which
    // in a sorted list is exactly the start of the letter's section.
    const el = document.querySelector(`[data-alpha-letter="${letter}"]`);
    if (el) (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
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
