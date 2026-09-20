import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { apiOrigin } from '../../scripts/api-origin.ts';
import { ensureClientToken } from '../../scripts/client-token.ts';
export default defineConfig({
  root: resolve('apps/extension'),
  base: './',
  define: {
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify(apiOrigin()),
    'import.meta.env.VITE_CLIENT_TOKEN': JSON.stringify(ensureClientToken()),
  },
  plugins: [react(), tailwind()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: resolve('apps/extension/sidepanel.html'),
        overlay: resolve('apps/extension/overlay.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/fixtures': { target: 'http://127.0.0.1:4318' },
      '/robots.txt': { target: 'http://127.0.0.1:4318' },
      '/sitemap.xml': { target: 'http://127.0.0.1:4318' },
    },
  },
});
