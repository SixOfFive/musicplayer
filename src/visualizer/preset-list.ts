import type { VisualizerPlugin } from '../../shared/types';

/**
 * Enumerate every Milkdrop preset bundled with the `butterchurn-presets`
 * package at runtime. The main process can't do this (the package is a
 * browser-targeted ESM bundle), so we do it here on first call and cache
 * the result.
 */
let cache: VisualizerPlugin[] | null = null;

export async function listBundledMilkdrop(): Promise<VisualizerPlugin[]> {
  if (cache) return cache;
  try {
    const mod: any = await import(/* @vite-ignore */ 'butterchurn-presets' as any);
    const presets = mod.getPresets?.() ?? mod.default?.getPresets?.() ?? mod;
    const keys = Object.keys(presets ?? {});
    cache = keys.map((key) => ({
      id: `milkdrop:${key}`,
      name: key,
      kind: 'milkdrop' as const,
      source: key,
      builtin: true,
      enabled: true,
    }));
    return cache;
  } catch (err) {
    console.error('[preset-list] failed to load butterchurn-presets', err);
    cache = [];
    return cache;
  }
}
