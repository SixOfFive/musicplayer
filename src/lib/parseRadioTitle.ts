// ICY `StreamTitle` strings come back in a handful of shapes. The dominant
// convention (Shoutcast / Icecast defaults) is:
//
//     StreamTitle='Artist - Title';
//
// Occasionally stations flip the order ("Title - Artist") or use different
// separators (" by ", ": ", " – " with an en-dash). We only need a good-
// enough split to feed a library search with one token being the likely
// artist and one the likely title — if the guess is wrong, the cascading
// fallback ("just the title alone") still lands on matches.

export interface ParsedRadioTitle {
  artist: string | null;
  title: string | null;
}

/**
 * Best-effort parse of a `StreamTitle` value into artist + track title.
 * Returns null-safe fields so callers can forward them into URL params.
 *
 * Heuristic, in order:
 *   1. Split on " - " or " – " (hyphen with spaces / en-dash with spaces).
 *      Left side is artist, right side is title. This covers ~90% of
 *      Icecast/Shoutcast feeds.
 *   2. If no hyphen separator, try " by " (as in "Song Name by Artist").
 *      Swap the order — left is title, right is artist.
 *   3. Otherwise the entire string is treated as the title with unknown
 *      artist.
 */
export function parseRadioTitle(raw: string | null | undefined): ParsedRadioTitle {
  if (!raw) return { artist: null, title: null };
  const s = raw.trim();
  if (!s) return { artist: null, title: null };

  // Hyphen / en-dash forms — most common.
  const hyphen = /\s+[-–]\s+/;
  if (hyphen.test(s)) {
    const [a, ...rest] = s.split(hyphen);
    const t = rest.join(' - ').trim();
    return {
      artist: a.trim() || null,
      title: t || null,
    };
  }

  // "Title by Artist" form — less common but seen on some community radio.
  const byMatch = /^(.+?)\s+by\s+(.+)$/i.exec(s);
  if (byMatch) {
    return {
      artist: byMatch[2].trim() || null,
      title: byMatch[1].trim() || null,
    };
  }

  // Giving up — call the whole thing the title.
  return { artist: null, title: s };
}
