// butterchurn-presets ships UMD bundles with no typings. Each lib/*.min.js
// file exposes `getPresets()` returning a { [name: string]: Preset } map.
// These shim declarations let TypeScript accept the deep-path imports
// in preset-list.ts without switching to `// @ts-expect-error` hacks.

declare module 'butterchurn-presets' {
  export function getPresets(): Record<string, unknown>;
  const defaultExport: { getPresets?: () => Record<string, unknown> };
  export default defaultExport;
}
declare module 'butterchurn-presets/lib/butterchurnPresetsExtra.min.js' {
  export function getPresets(): Record<string, unknown>;
  const defaultExport: { getPresets?: () => Record<string, unknown> };
  export default defaultExport;
}
declare module 'butterchurn-presets/lib/butterchurnPresetsExtra2.min.js' {
  export function getPresets(): Record<string, unknown>;
  const defaultExport: { getPresets?: () => Record<string, unknown> };
  export default defaultExport;
}
declare module 'butterchurn-presets/lib/butterchurnPresetsMD1.min.js' {
  export function getPresets(): Record<string, unknown>;
  const defaultExport: { getPresets?: () => Record<string, unknown> };
  export default defaultExport;
}
declare module 'butterchurn-presets/lib/butterchurnPresetsNonMinimal.min.js' {
  export function getPresets(): Record<string, unknown>;
  const defaultExport: { getPresets?: () => Record<string, unknown> };
  export default defaultExport;
}
