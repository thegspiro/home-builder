import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const page = (name: string) => resolve(import.meta.dirname, `${name}.html`);

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Pages are served by the API under a strict Content-Security-Policy:
    // no inline scripts or styles, so never inline assets as data: URLs.
    assetsInlineLimit: 0,
    // Three.js makes the 3D house page's bundle about 580 kB (145 kB gzipped). Only that
    // page loads it, and hashed assets are cached for a year, so it is expected.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: {
        index: page('index'),
        list: page('list'),
        inbox: page('inbox'),
        house: page('house'),
        model: page('model'),
        admin: page('admin'),
      },
    },
  },
});
