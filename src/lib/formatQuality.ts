// Compact audio-quality label for track rows.
//
// We want something terse enough to fit in a subtitle alongside the
// artist name: "FLAC 96 kHz", "MP3 320k", "AAC 256k". The field is
// informational — not a requirement to parse — so being missing (any
// of codec / bitrate / sampleRate null) is fine. The helper returns
// `null` when there's literally nothing to show, and callers skip
// the label rather than rendering a stub.
//
// Two conventions:
//   - LOSSLESS codecs (FLAC, ALAC, WAV, APE, WavPack, TAK) show sample
//     rate in kHz. Bitrate varies wildly across lossless tracks (24/96
//     FLAC runs 3+ Mbps) and isn't interesting there; the kHz tells
//     the story — 44.1 = CD, 48 = DVD, 96 = hi-res, 192 = studio.
//   - LOSSY codecs (MP3, AAC, Vorbis, Opus, WMA) show bitrate in kbps.
//     Sample rate is usually 44.1 and the kbps is what the user
//     actually cares about.

const LOSSLESS_CODECS = new Set(['flac', 'alac', 'wav', 'ape', 'wavpack', 'tak']);

/** Normalise the codec string we get from music-metadata into a
 *  short display token. music-metadata returns things like "MPEG 1
 *  Layer 3" or "PCM" that aren't user-friendly; map the common
 *  variants to canonical short forms. */
function shortCodec(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes('mpeg') && s.includes('layer 3')) return 'MP3';
  if (s.includes('mp3')) return 'MP3';
  if (s.includes('flac')) return 'FLAC';
  if (s.includes('alac')) return 'ALAC';
  if (s.includes('pcm') || s.includes('wav'))  return 'WAV';
  if (s.includes('aac')) return 'AAC';
  if (s.includes('opus')) return 'Opus';
  if (s.includes('vorbis') || s.includes('ogg')) return 'OGG';
  if (s.includes('wma') || s.includes('ms wma')) return 'WMA';
  if (s.includes('ape')) return 'APE';
  // Anything unrecognised: uppercase the first token. Rare path.
  const first = s.split(/[\s/]+/)[0] ?? s;
  return first.toUpperCase();
}

function isLossless(codec: string): boolean {
  return LOSSLESS_CODECS.has(codec.toLowerCase());
}

/** kHz formatter that strips trailing `.0` (44.1 stays "44.1", 96 shows
 *  as just "96"). */
function formatKhz(hz: number): string {
  const khz = hz / 1000;
  if (khz % 1 === 0) return `${khz} kHz`;
  return `${khz.toFixed(1)} kHz`;
}

/**
 * Build a compact audio-quality label. Returns `null` when no codec
 * is known — callers should then render no quality chip at all.
 *
 * Examples:
 *   formatQuality('flac',   null,     96000)  → "FLAC 96 kHz"
 *   formatQuality('MPEG',   320000,   44100)  → "MP3 320k"
 *   formatQuality('MPEG 1 Layer 3', 256000, 48000) → "MP3 256k"
 *   formatQuality('aac',    128000,   44100)  → "AAC 128k"
 *   formatQuality('flac',   null,     null)   → "FLAC"
 *   formatQuality(null,     anything, anything) → null
 */
export function formatQuality(
  codec: string | null | undefined,
  bitrate: number | null | undefined,
  sampleRate: number | null | undefined,
): string | null {
  if (!codec) return null;
  const short = shortCodec(codec);
  if (!short) return null;

  if (isLossless(codec)) {
    if (sampleRate && sampleRate > 0) return `${short} ${formatKhz(sampleRate)}`;
    return short;
  }
  if (bitrate && bitrate > 0) {
    const kbps = Math.round(bitrate / 1000);
    return `${short} ${kbps}k`;
  }
  return short;
}
