/**
 * Seed bundled visualizer presets into the user's visualizer-presets
 * folder on startup.
 *
 * Problem: butterchurn-presets ships a minified JS bundle of ~100
 * baked-in Milkdrop presets. The enumerator (preset-list.ts) calls
 * `getPresets()` on that bundle — raw `.json` files dropped into the
 * package folder are invisible to it. So any preset we want to ship
 * with our app that wasn't in the upstream bundle has to live in a
 * user-scanned directory instead.
 *
 * Solution: bundle extra presets under `default-presets/` at the
 * repo root (included in electron-builder's `files` so they land in
 * the installed app's resources). At startup, copy anything in that
 * folder into `userData/visualizer-presets/` — the folder the main
 * IPC scanner reads to produce user-plugin entries.
 *
 * Non-destructive: a file that already exists in the user folder is
 * left alone. That way users can edit a default preset to taste, and
 * the next upgrade won't clobber their tweaks. If they want to reset
 * a default, they can delete it and relaunch.
 *
 * Runs fire-and-forget from main's startup; failures log-but-don't
 * block the app.
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * Path to the bundled defaults folder. Resolves via `app.getAppPath()`
 * which returns:
 *   - dev:      the repo root (where the folder actually lives)
 *   - packaged: the asar root (folder included via electron-builder
 *               `files` config)
 */
function bundledDefaultsDir(): string {
  return path.join(app.getAppPath(), 'default-presets');
}

function userPresetsDir(): string {
  return path.join(app.getPath('userData'), 'visualizer-presets');
}

/**
 * Copy every file in `default-presets/` into the user's
 * `visualizer-presets/` folder, skipping any that already exist.
 * Logs the count of seeded/skipped files.
 */
export async function seedDefaultVisualizerPresets(): Promise<void> {
  const src = bundledDefaultsDir();
  const dst = userPresetsDir();

  let entries: string[] = [];
  try {
    entries = await fs.readdir(src);
  } catch (err: any) {
    // In older builds there may not be a default-presets folder at
    // all. Not an error — just nothing to seed.
    if (err?.code !== 'ENOENT') {
      process.stdout.write(`[default-presets] readdir ${src} failed: ${err?.message ?? err}\n`);
    }
    return;
  }

  if (entries.length === 0) return;

  try { await fs.mkdir(dst, { recursive: true }); }
  catch (err: any) {
    process.stdout.write(`[default-presets] mkdir ${dst} failed: ${err?.message ?? err}\n`);
    return;
  }

  let seeded = 0;
  let skipped = 0;
  for (const name of entries) {
    const srcPath = path.join(src, name);
    const dstPath = path.join(dst, name);
    try {
      // access() throws if the target doesn't exist — that's our "copy
      // it" signal. Any other error (ENOTDIR etc.) is treated as
      // skip-and-move-on so one bad file can't block the rest.
      await fs.access(dstPath);
      skipped++;
    } catch {
      try {
        await fs.copyFile(srcPath, dstPath);
        seeded++;
      } catch (err: any) {
        process.stdout.write(`[default-presets] copy ${name} failed: ${err?.message ?? err}\n`);
      }
    }
  }

  if (seeded > 0 || skipped > 0) {
    process.stdout.write(`[default-presets] seeded ${seeded} preset${seeded === 1 ? '' : 's'}, kept ${skipped} existing\n`);
  }
}
