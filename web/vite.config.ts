import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const API = process.env.GROKBOT_API ?? 'http://localhost:8787';

export default defineConfig(({ mode }) => {
  // The durable A2UI agent (agents/a2ui-durable, docs/a2ui/CONTRACT.md): WebSocket at /a2ui/ws, health at /a2ui/health.
  // Same variables the Node relay reads (server/src/a2ui-relay.ts), from the shell or the repo-root .env. Only the
  // BOTHQ_A2UI_* prefix is loaded, and only into this config (never into the client bundle).
  // BOTHQ_A2UI_URL is the old dev-only name, still honoured.
  const e = { ...loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), 'BOTHQ_A2UI_'), ...process.env };
  const A2UI = e.BOTHQ_A2UI_AGENT_URL || e.BOTHQ_A2UI_URL || 'http://127.0.0.1:8790';
  // When the agent runs with BOTHQ_A2UI_TOKEN it requires this header on /a2ui/ws and /a2ui/health; the browser
  // never sees the token, the proxy adds it (http-proxy applies `headers` to WebSocket upgrades too).
  const a2uiHeaders: Record<string, string> = e.BOTHQ_A2UI_TOKEN ? { 'x-bothq-a2ui-token': e.BOTHQ_A2UI_TOKEN } : {};
  return {
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
        '/a2ui/': { target: A2UI, changeOrigin: false, ws: true, headers: a2uiHeaders },
      },
    },
    // noVNC uses top-level await, so target ES2022+.
    build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  };
});
