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
    rollupOptions: {
      input: {
        index: page('index'),
        list: page('list'),
        inbox: page('inbox'),
        house: page('house'),
        admin: page('admin'),
      },
    },
  },
});
