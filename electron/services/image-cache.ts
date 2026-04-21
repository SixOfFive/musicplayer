// In-memory LRU cache for the mp-media protocol's image responses.
//
// Why: cover art lives under album folders on the shared filesystem. Every
// render of the Albums grid, the Home view's "Newest albums", the mini
// cards on search results, the album-detail header, etc. all fire HTTP
// requests at mp-media, which goes out to SMB/CIFS/NFS and reads the same
// `cover.jpg` over and over. On a slow share this produces visible lag
// every time the user scrolls back to a viewport they've already seen.
//
// Scope deliberately narrow:
//   - Images only (jpg/jpeg/png/webp/gif). Audio files are big and use
//     Range requests; caching those in memory would blow the heap and
//     bypass the seek semantics.
//   - Bounded capacity with LRU eviction. Defaults to 256 MB which holds
//     a few hundred covers at typical 200–800 KB each.
//   - No TTL. The cache lives for the process lifetime; if the user
//     replaces a cover.jpg on disk during a session, a restart is
//     required to see the change. Explicit invalidation via `invalidate(path)`
//     is available for specific hotspots (e.g. the cover-art migration).
//   - Entries are raw Buffer + content-type + mtime-at-cache. Cheap to
//     serve — just wrap the buffer in a new Response with the right
//     headers.

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

export function isCacheableImage(extLower: string): boolean {
  return IMAGE_EXTS.has(extLower);
}

export interface CachedImage {
  bytes: Buffer;
  contentType: string;
  size: number;
  mtimeMs: number;
  /** epoch ms of the most recent `get` — for debugging only. */
  lastAccess: number;
}

class ImageMemCache {
  private readonly entries = new Map<string, CachedImage>();
  private bytesUsed = 0;
  private hits = 0;
  private misses = 0;
  // Becomes true any time the set of entries changes relative to what's
  // currently on disk. Flipped to false after a successful persistSave.
  // Persistence layer reads this to skip the write entirely when the
  // cache hasn't moved since last save — no point rewriting a 100 MB
  // cache file on every app quit if nothing changed.
  private dirty = false;
  constructor(public readonly maxBytes = 256 * 1024 * 1024) {}

  get(key: string): CachedImage | null {
    const e = this.entries.get(key);
    if (!e) { this.misses++; return null; }
    // Move-to-end for LRU recency. Map's iteration order is insertion
    // order, so deleting + re-setting puts this entry at the tail and
    // the least-recently-used entry stays at the head for eviction.
    this.entries.delete(key);
    this.entries.set(key, e);
    e.lastAccess = Date.now();
    this.hits++;
    return e;
  }

  set(key: string, entry: CachedImage): void {
    // Overwrite is allowed (stat/mtime might have changed). Adjust the
    // byte accounting accordingly before inserting the new value.
    const prev = this.entries.get(key);
    if (prev) {
      this.bytesUsed -= prev.size;
      this.entries.delete(key);
    }
    this.entries.set(key, entry);
    this.bytesUsed += entry.size;
    this.dirty = true;
    this.evictUntilUnderCap();
  }

  invalidate(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.bytesUsed -= e.size;
    this.entries.delete(key);
    this.dirty = true;
  }

  /** Drop every entry. Used by debug / settings. */
  clear(): void {
    this.entries.clear();
    this.bytesUsed = 0;
    this.dirty = true;
  }

  isDirty(): boolean { return this.dirty; }
  markClean(): void { this.dirty = false; }

  /** Iterate all current entries in LRU order (oldest first). */
  *allEntries(): IterableIterator<[string, CachedImage]> {
    for (const [k, v] of this.entries) yield [k, v];
  }

  stats() {
    return {
      entries: this.entries.size,
      bytesUsed: this.bytesUsed,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : 0,
    };
  }

  private evictUntilUnderCap(): void {
    while (this.bytesUsed > this.maxBytes && this.entries.size > 0) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.entries.get(oldestKey);
      if (!oldest) break;
      this.entries.delete(oldestKey);
      this.bytesUsed -= oldest.size;
    }
  }
}

// Single shared instance for the main process. Exported as-is rather
// than behind a factory because there's exactly one mp-media protocol
// handler registered for the whole app, and it's the only consumer.
export const imageMemCache = new ImageMemCache();

// -------- On-disk persistence ---------------------------------------------
//
// The cache survives app restarts: on quit (via persistSaveIfDirty) we
// write the current entries to userData/image-cache/, and on startup
// (via persistLoad) we slurp them back. This is particularly valuable
// for the user's shared-filesystem workflow where first-render from a
// cold start would otherwise re-pull hundreds of covers over SMB.
//
// Format (one-file-per-blob + sidecar JSON index):
//   userData/image-cache/
//     index.json       ← { version, entries: [{ key, hash, type, mtimeMs, size, lastAccess }] }
//     <sha1>.bin       ← the image bytes for each entry
//
// The per-blob file means a failed write to a single entry doesn't
// corrupt the rest, and we can cheaply delete an entry by unlinking
// just its blob without rewriting a monolithic file. `sha1` is used
// for the blob filename only — collision-resistant enough for this
// non-security-sensitive use, and sidesteps filename-legal-char
// sanitisation entirely.
//
// On a cache miss during startup (blob file gone, corrupt, too small),
// we simply skip that entry and let the mp-media handler rebuild it
// on demand from the source file. If THAT source is also missing, the
// normal ENOENT path runs (renderer shows a broken image, or the
// reclaim/online-fetch pipelines restore it on next scan).

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

interface PersistedIndexEntry {
  key: string;
  hash: string;
  type: string;
  mtimeMs: number;
  size: number;
  lastAccess: number;
}
interface PersistedIndex {
  version: 1;
  entries: PersistedIndexEntry[];
}

function hashKey(key: string): string {
  return crypto.createHash('sha1').update(key).digest('hex');
}

/**
 * Recursively delete the cache directory. Used when the on-disk index is
 * corrupt — safer to start fresh than to limp along with half-trusted
 * data. The directory will be recreated by the first `persistSaveIfDirty`
 * call after the app warms up its in-memory cache again.
 */
async function nukeCacheDir(cacheDir: string): Promise<void> {
  try { await fs.rm(cacheDir, { recursive: true, force: true }); }
  catch (err: any) { process.stdout.write(`[image-cache] couldn't wipe cache dir: ${err?.message ?? err}\n`); }
}

/**
 * Load a previously-persisted cache from disk into memory. Safe to call
 * exactly once at app startup.
 *
 * Failure handling is three-tiered:
 *   - Missing index.json   → not an error. First run (or cache wiped).
 *                            Returns loaded=0, nothing to do.
 *   - Corrupt index.json   → JSON parse failure OR schema mismatch. The
 *                            cache is in an unknown state. Wipe the
 *                            whole dir so a subsequent save rebuilds it
 *                            from scratch. Returns wiped=true so callers
 *                            can log.
 *   - Per-entry corruption → individual blob missing, truncated, or
 *                            read fails. Skip JUST that entry; the rest
 *                            load normally. The missing covers get
 *                            refetched on their next mp-media request.
 *
 * Last category is expected (evicted entries, shared-FS blips) and
 * doesn't warrant nuking everything. Only a busted INDEX counts as
 * "cache is unusable, start over".
 */
export async function persistLoad(cacheDir: string): Promise<{ loaded: number; skipped: number; wiped?: boolean }> {
  const indexPath = path.join(cacheDir, 'index.json');

  // Tier 1: missing index → first run / cache was wiped. Not an error.
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { loaded: 0, skipped: 0 };
    // Any other I/O error (EACCES, EIO, etc.) — treat as corrupt cache
    // and wipe. Better a one-time re-warm than loading half-trusted data.
    process.stdout.write(`[image-cache] index unreadable (${err?.code ?? err?.message}) — wiping cache dir\n`);
    await nukeCacheDir(cacheDir);
    return { loaded: 0, skipped: 0, wiped: true };
  }

  // Tier 2: parse / schema check → corrupt → wipe and start over.
  let indexJson: PersistedIndex;
  try {
    indexJson = JSON.parse(raw);
  } catch (err: any) {
    process.stdout.write(`[image-cache] index.json parse failed (${err?.message ?? err}) — wiping cache dir\n`);
    await nukeCacheDir(cacheDir);
    return { loaded: 0, skipped: 0, wiped: true };
  }
  if (!indexJson || indexJson.version !== 1 || !Array.isArray(indexJson.entries)) {
    process.stdout.write(`[image-cache] index.json has unexpected shape (version=${indexJson?.version}) — wiping cache dir\n`);
    await nukeCacheDir(cacheDir);
    return { loaded: 0, skipped: 0, wiped: true };
  }

  // Tier 3: per-entry errors are non-fatal.
  let loaded = 0;
  let skipped = 0;
  for (const meta of indexJson.entries) {
    const blobPath = path.join(cacheDir, `${meta.hash}.bin`);
    try {
      const bytes = await fs.readFile(blobPath);
      if (bytes.length !== meta.size) {
        skipped++;
        continue;
      }
      imageMemCache.set(meta.key, {
        bytes,
        contentType: meta.type,
        size: meta.size,
        mtimeMs: meta.mtimeMs,
        lastAccess: meta.lastAccess,
      });
      loaded++;
    } catch {
      skipped++;
    }
  }
  // set() marks dirty; but loading FROM disk shouldn't count as a
  // change. Reset the flag so the next quit won't rewrite everything.
  imageMemCache.markClean();
  return { loaded, skipped };
}

/**
 * Write the current in-memory cache to disk. No-op when the cache hasn't
 * changed since the last save (persistLoad + any subsequent set/
 * invalidate flips the dirty flag). Safe to call on app quit; designed
 * to finish in well under a second for a typical-size library cache.
 *
 * Orphan blob files (referenced by a previous index but not the current
 * set of entries) are unlinked so the on-disk footprint stays bounded.
 */
export async function persistSaveIfDirty(cacheDir: string): Promise<{ saved: number; wrote: boolean }> {
  if (!imageMemCache.isDirty()) return { saved: 0, wrote: false };

  await fs.mkdir(cacheDir, { recursive: true });

  // Snapshot the current entries. Store in insertion (LRU) order so a
  // later persistLoad preserves the ordering.
  const entries = [...imageMemCache.allEntries()];
  const keepHashes = new Set<string>();
  const index: PersistedIndex = { version: 1, entries: [] };

  for (const [key, v] of entries) {
    const hash = hashKey(key);
    keepHashes.add(hash);
    const blobPath = path.join(cacheDir, `${hash}.bin`);
    try {
      await fs.writeFile(blobPath, new Uint8Array(v.bytes.buffer, v.bytes.byteOffset, v.bytes.byteLength));
      index.entries.push({
        key, hash, type: v.contentType, mtimeMs: v.mtimeMs, size: v.size, lastAccess: v.lastAccess,
      });
    } catch (err: any) {
      process.stdout.write(`[image-cache] failed to persist ${key}: ${err?.message ?? err}\n`);
    }
  }

  // Index last — if the app crashes mid-persist, a partial blob set with
  // no matching index just gets treated as missing on next load.
  await fs.writeFile(path.join(cacheDir, 'index.json'), JSON.stringify(index));

  // Prune orphan blobs (from entries that were evicted or invalidated
  // since the last save).
  try {
    const files = await fs.readdir(cacheDir);
    for (const f of files) {
      if (!f.endsWith('.bin')) continue;
      const h = f.slice(0, -4);
      if (!keepHashes.has(h)) {
        try { await fs.unlink(path.join(cacheDir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore — doesn't affect correctness, only disk footprint */ }

  imageMemCache.markClean();
  return { saved: index.entries.length, wrote: true };
}
