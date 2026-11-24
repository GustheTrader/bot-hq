import type { IncomingMessage, Server } from 'node:http';
import { Hono } from 'hono';
import { WebSocket, WebSocketServer } from 'ws';
import { userFromCookieHeader, userFromToken } from './lib/auth.js';
import { getCookie } from 'hono/cookie';

/**
 * Production relay for the A2UI durable agent (agents/a2ui-durable, docs/a2ui/CONTRACT.md).
 * In dev, Vite proxies /a2ui/ straight to the agent; in production the browser only talks to
 * this server, so /a2ui/ws and /a2ui/health are forwarded here, behind Bot HQ sign-in.
 * Frames are relayed verbatim: one A2UI v1.0 message per text frame, in both directions.
 */
const AGENT = (process.env.BOTHQ_A2UI_AGENT_URL ?? 'http://127.0.0.1:8790').replace(/\/$/, '');

export const a2uiApi = new Hono();
a2uiApi.get('/health', async (c) => {
  if (!userFromToken(getCookie(c, 'grokbot_session'))) return c.json({ error: 'sign in' }, 401);
  try {
    const r = await fetch(`${AGENT}/a2ui/health`, { signal: AbortSignal.timeout(3000) });
    return c.json(await r.json(), r.status as 200);
  } catch {
    return c.json({ error: 'a2ui agent offline' }, 502);
  }
});

export function attachA2uiRelay(server: Server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/a2ui/ws') return; // not ours
    if (!userFromCookieHeader(req.headers.cookie)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(`${AGENT.replace(/^http/, 'ws')}/a2ui/ws`);
      const pending: string[] = [];
      upstream.on('open', () => { for (const m of pending.splice(0)) upstream.send(m); });
      upstream.on('message', (data, isBinary) => { if (!isBinary && client.readyState === WebSocket.OPEN) client.send(data.toString()); });
      client.on('message', (data, isBinary) => {
        if (isBinary) return;
        const m = data.toString();
        if (upstream.readyState === WebSocket.OPEN) upstream.send(m); else pending.push(m);
      });
      // Either side closing ends both; the renderer reconnects with backoff and gets a fresh snapshot.
      const close = () => { client.close(); upstream.close(); };
      upstream.on('close', close); upstream.on('error', close);
      client.on('close', close); client.on('error', close);
    });
  });
}
