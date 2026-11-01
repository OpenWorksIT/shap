import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const pdfkit = fileURLToPath(new URL('../../node_modules/pdfkit/js/pdfkit.standalone.js', import.meta.url));

export default defineConfig({
  // Capacitor loads the app from the phone's own files: relative paths.
  base: './',
  define: { __SHAP_VERSION__: JSON.stringify(version) },
  plugins: [react()],
  resolve: {
    // pdfkit's browser build carries its own fonts and polyfills.
    alias: { pdfkit: pdfkit },
  },
  worker: { format: 'es' },
  // PGlite ships its WebAssembly and data files next to its code: don't pre-bundle it.
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  server: { port: 5173, host: true },
});
