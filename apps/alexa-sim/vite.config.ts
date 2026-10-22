import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** The single Stand-In Node process (apps/mcp-server) serves /mcp, /sim, /health and discovery. */
const BACKEND = process.env.STANDIN_BACKEND_URL ?? 'http://127.0.0.1:8787';
const proxied = ['/mcp', '/sim', '/health', '/.well-known'];

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: BACKEND, changeOrigin: false, ws: false }])),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
});
