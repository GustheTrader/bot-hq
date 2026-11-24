import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const API = process.env.GROKBOT_API ?? 'http://localhost:8787';
// The durable A2UI agent (agents/a2ui-durable, docs/a2ui/CONTRACT.md): WebSocket at /a2ui/ws, health at /a2ui/health.
const A2UI = process.env.BOTHQ_A2UI_URL ?? 'http://127.0.0.1:8790';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../server/src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: false, ws: true },
      // Trailing slash on purpose: only /a2ui/ws and /a2ui/health, not any app path that merely starts with /a2ui.
      '/a2ui/': { target: A2UI, changeOrigin: false, ws: true },
    },
  },
  // noVNC uses top-level await, so target ES2022+.
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
});
