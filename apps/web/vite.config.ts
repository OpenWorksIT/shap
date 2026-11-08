import react from '@vitejs/plugin-react';
import { defineConfig, type PluginOption } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VitePWA } from 'vite-plugin-pwa';

const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const pdfkit = fileURLToPath(new URL('../../node_modules/pdfkit/js/pdfkit.standalone.js', import.meta.url));
/**
 * POCKET_WEB=1 builds the installable web app (for Windows and other computers): the same app,
 * with a service worker so it opens offline and installs from Edge or Chrome. The phone builds
 * (Capacitor) leave it out: the app's files are already on the phone.
 */
const web = process.env.POCKET_WEB === '1';

const pwa: PluginOption = VitePWA({
  registerType: 'prompt',
  // Registered in lib/pwa.ts, which applies an update when the app is next in the background.
  injectRegister: false,
  includeAssets: ['icon.svg', 'apple-touch-icon.png'],
  manifest: {
    id: './',
    name: 'Shap Pocket',
    short_name: 'Shap Pocket',
    description: 'Quotes, invoices, costs and the books for a one-person business. Free, by OpenWorks IT.',
    theme_color: '#1f2b33',
    background_color: '#f5f2ed',
    display: 'standalone',
    start_url: './',
    scope: './',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  },
  workbox: {
    // Everything the app needs to open with no internet, the database engine included.
    globPatterns: ['**/*.{js,css,html,wasm,data,gz,svg,png,woff2,mp4}'],
    maximumFileSizeToCacheInBytes: 24 * 1024 * 1024,
    navigateFallback: 'index.html',
    cleanupOutdatedCaches: true,
  },
});

export default defineConfig({
  // Capacitor loads the app from the phone's own files, and the web app is served under a path:
  // relative paths for both.
  base: './',
  define: { __SHAP_VERSION__: JSON.stringify(version), __POCKET_WEB__: JSON.stringify(web) },
  plugins: [react(), ...(web ? [pwa] : [])],
  resolve: {
    // pdfkit's browser build carries its own fonts and polyfills.
    alias: {
      pdfkit: pdfkit,
      // The phone builds have no service worker: a stand-in that does nothing.
      ...(web ? {} : { 'virtual:pwa-register': fileURLToPath(new URL('./src/lib/pwa-none.ts', import.meta.url)) }),
    },
  },
  worker: { format: 'es' },
  // PGlite ships its WebAssembly and data files next to its code: don't pre-bundle it.
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  server: { port: 5173, host: true },
});
