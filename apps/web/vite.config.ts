import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { VitePWA } from 'vite-plugin-pwa';

const api = process.env.API_URL ?? 'http://localhost:8080';
// The version this build is, so the app can tell when the server has been updated under it.
const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export default defineConfig({
  define: { __SHAP_VERSION__: JSON.stringify(version) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Registered in main.tsx, which also checks for a new version when you come back to the tab.
      injectRegister: false,
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Shap',
        short_name: 'Shap',
        description: 'Jobs, labour, quotes, invoices and the books',
        theme_color: '#1f2b33',
        background_color: '#f5f2ed',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
        shortcuts: [
          { name: 'Log a day', url: '/log?tab=labour' },
          { name: 'Add a cost', url: '/log?tab=cost' },
        ],
      },
      workbox: {
        // Cache the app shell only; the company's figures are always fetched fresh.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
});
