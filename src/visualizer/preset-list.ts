import type { VisualizerPlugin } from '../../shared/types';

/**
 * Enumerate every Milkdrop preset bundled with the `butterchurn-presets`
 * package. butterchurn-presets ships SIX preset bundles in its lib/
 * folder, but only the default `butterchurnPresets.min.js` is wired
 * to the package's main export — the others are sitting there unused.
 * Loading all five non-default bundles merges ~425 extra presets at
 * zero download cost (they're already on disk / in the asar).
 *
 * Implementation note — each import must be a LITERAL string. Vite
 * statically analyses `import(...)` calls at build time to decide
 * what to pre-bundle and how to rewrite the import for runtime
 * resolution; a variable / templated path produces
 * `Failed to resolve module specifier` errors in the browser at
 * runtime because the browser can't resolve bare package specifiers
 * without Vite's help. So we hand-write one try/catch block per
 * bundle instead of looping over a path array.
 *
 * De-dupe by preset name (first-seen wins) so a preset that appears
 * in both the default and Extra bundles only shows up once.
 */
let cache: VisualizerPlugin[] | null = null;

/** Pull preset entries out of a UMD bundle module in whichever shape
 *  it exposes them — newer bundles have `getPresets()`, older ones
 *  put the map on the default export directly. */
function extractPresets(mod: any): Record<string, unknown> | null {
  if (!mod) return null;
  const maybeGetter = mod.getPresets ?? mod.default?.getPresets;
  if (typeof maybeGetter === 'function') return maybeGetter();
  if (mod.default && typeof mod.default === 'object' && !Array.isArray(mod.default)) return mod.default;
  if (typeof mod === 'object' && !Array.isArray(mod)) return mod;
  return null;
}

function absorbInto(out: VisualizerPlugin[], seen: Set<string>, label: string, presets: Record<string, unknown> | null): void {
  if (!presets) {
    console.warn(`[preset-list] ${label} produced no preset map`);
    return;
  }
  let added = 0;
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
    added++;
  }
  console.log(`[preset-list] ${label}: +${added} presets (total ${out.length})`);
}

export async function listBundledMilkdrop(): Promise<VisualizerPlugin[]> {
  if (cache) return cache;
  const seen = new Set<string>();
  const out: VisualizerPlugin[] = [];

  // Default bundle — always present (it's the package's main entry).
  try {
    const mod: any = await import('butterchurn-presets');
    absorbInto(out, seen, 'default', extractPresets(mod));
  } catch (err) {
    console.error('[preset-list] default bundle failed to load', err);
  }

  // Extra bundles — each a separate literal import so Vite can see
  // them at build time and pre-bundle. Wrapped in try/catch so a
  // missing file (older butterchurn-presets versions) doesn't block
  // the rest from loading.
  try {
    const mod: any = await import('butterchurn-presets/lib/butterchurnPresetsExtra.min.js');
    absorbInto(out, seen, 'extra', extractPresets(mod));
  } catch (err) { console.warn('[preset-list] extra bundle skipped', err); }

  try {
    const mod: any = await import('butterchurn-presets/lib/butterchurnPresetsExtra2.min.js');
    absorbInto(out, seen, 'extra2', extractPresets(mod));
  } catch (err) { console.warn('[preset-list] extra2 bundle skipped', err); }

  try {
    const mod: any = await import('butterchurn-presets/lib/butterchurnPresetsMD1.min.js');
    absorbInto(out, seen, 'md1', extractPresets(mod));
  } catch (err) { console.warn('[preset-list] md1 bundle skipped', err); }

  try {
    const mod: any = await import('butterchurn-presets/lib/butterchurnPresetsNonMinimal.min.js');
    absorbInto(out, seen, 'non-minimal', extractPresets(mod));
  } catch (err) { console.warn('[preset-list] non-minimal bundle skipped', err); }

  cache = out;
  console.log(`[preset-list] merged ${out.length} unique milkdrop presets`);
  return cache;
}
