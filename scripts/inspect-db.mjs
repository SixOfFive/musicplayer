// Run with: node scripts/inspect-db.mjs   (requires Electron's ABI — see package.json postinstall)
// Since plain node is a different ABI, better to run via electron: npx electron scripts/inspect-db.mjs
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';

const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'musicplayer', 'library.db');
const db = new Database(dbPath, { readonly: true });

console.log('=== DB:', dbPath);
console.log('directories:', db.prepare('SELECT * FROM directories').all());
console.log('artists:', (db.prepare('SELECT COUNT(*) c FROM artists').get()).c);
console.log('albums:',  (db.prepare('SELECT COUNT(*) c FROM albums').get()).c);
console.log('tracks:',  (db.prepare('SELECT COUNT(*) c FROM tracks').get()).c);
console.log('first 3 tracks:', db.prepare('SELECT path, title FROM tracks LIMIT 3').all());
process.exit(0);
