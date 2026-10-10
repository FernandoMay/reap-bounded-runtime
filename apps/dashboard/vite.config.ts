import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dev server proxies the API so the browser talks to one origin.
 *
 * The token is supplied per request by the dashboard and forwarded, rather than
 * being baked into the bundle. A token embedded in a built asset would be
 * readable by anyone who opened the page, which defeats requiring one at all.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.RUNTIME_URL ?? 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
