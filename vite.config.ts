import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const server = process.env.ARCHWEAVE_DEV_SERVER ?? 'http://127.0.0.1:4317';

export default defineConfig({
  root: '.',
  plugins: [react()],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
  server: {
    port: 5173,
    proxy: {
      // Server-sent events pass through untouched: no rewrite, no buffering.
      '/api': { target: server, changeOrigin: false, timeout: 0, proxyTimeout: 0 },
      '/mcp': { target: server, changeOrigin: false },
    },
  },
});
