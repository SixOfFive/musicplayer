import type { VisualizerPlugin } from '../../shared/types';

/**
 * Enumerate every Milkdrop preset bundled with the `butterchurn-presets`
 * package at runtime. The main process can't do this (the package is a
 * browser-targeted ESM bundle), so we do it here on first call and cache
 * the result.
 *
 * butterchurn-presets actually ships SIX preset bundles side by side in
 * its lib/ folder but only the default `butterchurnPresets.min.js` is
 * wired to the package's main export. We load all six and merge them
 * — adds ~450 extra presets at zero download cost since they're already
 * in the user's node_modules / app bundle. Duplicates (same preset
 * name across bundles) get de-duped by the first-seen entry.
 */
let cache: VisualizerPlugin[] | null = null;

// UMD filenames to try importing, in priority order. The first one is
// the package's main and always loads; the rest are lazy imports that
// may or may not be present in older versions of butterchurn-presets.
const BUNDLE_PATHS = [
  'butterchurn-presets',                                         // default 100 — the package main
  'butterchurn-presets/lib/butterchurnPresetsExtra.min.js',      // +146 extras (Krash / community curated)
  'butterchurn-presets/lib/butterchurnPresetsExtra2.min.js',     // +122 additional
  'butterchurn-presets/lib/butterchurnPresetsMD1.min.js',        // +87 classic Milkdrop 1.x style
  'butterchurn-presets/lib/butterchurnPresetsNonMinimal.min.js', // +71 heavier
  // Minimal is a subset of the default, skip to avoid double-listing.
];

export async function listBundledMilkdrop(): Promise<VisualizerPlugin[]> {
  if (cache) return cache;
  const seen = new Set<string>();
  const out: VisualizerPlugin[] = [];

  for (const p of BUNDLE_PATHS) {
    try {
      const mod: any = await import(/* @vite-ignore */ p as any);
      // UMD bundles expose either `getPresets()` (default + extras) or
      // the default export IS the presets map (older variants). Try
      // both shapes before giving up on this bundle.
      const presets =
        mod.getPresets?.() ??
        mod.default?.getPresets?.() ??
        (typeof mod.default === 'object' ? mod.default : mod);
      if (!presets || typeof presets !== 'object') continue;
      for (const key of Object.keys(presets)) {
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: `milkdrop:${key}`,
          name: key,
          kind: 'milkdrop' as const,
          source: key,
          builtin: true,
          enabled: true,
        });
      }
    } catch (err) {
      // A missing bundle (older butterchurn-presets versions) is fine —
      // log once and move on so the user still gets whatever loaded.
      console.warn(`[preset-list] couldn't load ${p}`, err);
    }
  }

  cache = out;
  console.log(`[preset-list] merged ${out.length} unique milkdrop presets across ${BUNDLE_PATHS.length} bundles`);
  return cache;
}
