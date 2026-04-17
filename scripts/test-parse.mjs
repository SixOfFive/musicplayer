import { parseFile } from 'music-metadata';

try {
  const md = await parseFile('M:\\music\\AC+DC\\Back In Black\\06 Back In Black.m4a', { duration: true, skipCovers: false });
  console.log('OK');
  console.log('title:', md.common.title);
  console.log('artist:', md.common.artist);
  console.log('album:', md.common.album);
  console.log('duration:', md.format.duration);
  console.log('has picture:', !!md.common.picture?.[0]);
} catch (e) {
  console.error('FAIL:', e.code, e.message);
  console.error(e.stack);
}
process.exit(0);
