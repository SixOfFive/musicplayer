// Build the hover tooltip shown on a playlist card / sidebar entry.
// Same visual shape as the album-card tooltip (see AlbumCard.tsx): the
// name on line one, an optional description on line two, then a stats
// line — track count · runtime · on-disk size. Any missing field is
// quietly skipped so we don't show empty separators or "0 MB".
//
// Rendered in a plain `title` attribute; Chromium / Electron paint
// embedded `\n` as real line breaks, which is what we want. Extracted
// from the component so the sidebar and the Playlists grid render
// identical text.

import type { Playlist } from '../../shared/types';
import { formatDuration } from '../components/AlbumCard';
import { formatBytes } from '../hooks/useScanProgress';

export function buildPlaylistTooltip(p: Playlist): string {
  const lines: string[] = [p.name];
  if (p.description) lines.push(p.description);
  const stats: string[] = [];
  stats.push(`${p.trackCount.toLocaleString()} track${p.trackCount === 1 ? '' : 's'}`);
  const dur = formatDuration(p.durationSec);
  if (dur) stats.push(dur);
  if (typeof p.bytes === 'number' && p.bytes > 0) stats.push(formatBytes(p.bytes));
  lines.push(stats.join(' · '));
  return lines.join('\n');
}
