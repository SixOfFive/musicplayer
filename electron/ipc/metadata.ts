import type { IpcMain } from 'electron';
import { IPC, type MetadataProvider, type MetadataProviderId } from '../../shared/types';
import { testProvider as runTestProvider } from '../services/metadata-providers';

const PROVIDERS: MetadataProvider[] = [
  {
    id: 'musicbrainz',
    label: 'MusicBrainz',
    freeTier: true,
    requiresKey: false,
    description:
      'Open, community-maintained music encyclopedia. Used for canonical artist/album/track tags and release info. No API key required, but rate-limited to 1 req/sec.',
  },
  {
    id: 'coverartarchive',
    label: 'Cover Art Archive',
    freeTier: true,
    requiresKey: false,
    description:
      'Sibling of MusicBrainz — front/back cover art keyed by MBID. Best paired with MusicBrainz matching first.',
  },
  {
    id: 'lastfm',
    label: 'Last.fm',
    freeTier: true,
    requiresKey: true,
    description:
      'Good for artist bios, similar artists, scrobble counts and secondary cover art. Requires a free API key from last.fm/api.',
  },
  {
    id: 'discogs',
    label: 'Discogs',
    freeTier: true,
    requiresKey: true,
    description:
      'Large database of releases with good physical-media metadata and cover art. Requires a free personal access token.',
  },
  {
    id: 'deezer',
    label: 'Deezer',
    freeTier: true,
    requiresKey: false,
    description:
      'Public search API with fast 1000x1000 album art URLs. No key required, but ToS disallows caching for commercial use.',
  },
  {
    id: 'acoustid',
    label: 'AcoustID / Chromaprint',
    freeTier: true,
    requiresKey: true,
    description:
      'Audio fingerprinting — identifies tracks even with missing tags or re-encoded files. Links results to MusicBrainz IDs. Requires a free application API key from acoustid.org and the fpcalc binary.',
  },
  {
    id: 'accuraterip',
    label: 'AccurateRip',
    freeTier: true,
    requiresKey: false,
    description:
      'Per-track CRC32 of decoded audio samples for verified CD rips. Matches your files against millions of contributed rips (as used by EAC, dBpoweramp, XLD). Lossless only (flac/wav/aiff).',
  },
  {
    id: 'cuetoolsdb',
    label: 'CUETools DB (CTDB)',
    freeTier: true,
    requiresKey: false,
    description:
      'Complementary CRC database to AccurateRip with broader coverage and better offset handling. Verifies the integrity of lossless rips.',
  },
];

export function registerMetadataIpc(ipcMain: IpcMain) {
  ipcMain.handle(IPC.META_PROVIDERS, () => PROVIDERS);

  ipcMain.handle(IPC.META_TEST_PROVIDER, (_e, id: MetadataProviderId) => runTestProvider(id));
}
