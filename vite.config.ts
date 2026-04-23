import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  // butterchurn-presets ships multiple UMD preset bundles in its lib/
  // folder, but only the default one is declared in the package's main
  // field. Explicitly telling Vite to pre-bundle the deep sub-paths
  // lets `import('butterchurn-presets/lib/butterchurnPresetsExtra.min.js')`
  // actually resolve at runtime. Without these entries, the browser
  // throws "Failed to resolve module specifier" the moment the app
  // tries to load the extras.
  optimizeDeps: {
    include: [
      'butterchurn-presets',
      'butterchurn-presets/lib/butterchurnPresetsExtra.min.js',
      'butterchurn-presets/lib/butterchurnPresetsExtra2.min.js',
      'butterchurn-presets/lib/butterchurnPresetsMD1.min.js',
      'butterchurn-presets/lib/butterchurnPresetsNonMinimal.min.js',
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
