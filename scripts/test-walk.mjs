import fs from 'node:fs/promises';
import path from 'node:path';

const exts = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma']);

async function walk(dir, files) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    console.log('FAIL readdir', dir, e.code, e.message);
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, files);
    } else if (e.isFile() && exts.has(path.extname(e.name).toLowerCase())) {
      files.push(full);
    }
  }
}

const files = [];
console.time('walk');
await walk('M:\\music', files);
console.timeEnd('walk');
console.log('files found:', files.length);
console.log('first 5:', files.slice(0, 5));
process.exit(0);
