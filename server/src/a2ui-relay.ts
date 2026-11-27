import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { Hono } from 'hono';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { requireUser, userFromCookieHeader, type AuthVars } from './lib/auth.js';
import { db } from './db.js';
import { env } from './env.js';
import type { User } from './types.js';

/**
 * Production relay for the A2UI durable agent (agents/a2ui-durable, docs/a2ui/CONTRACT.md).
 * In dev, Vite proxies /a2ui/ straight to the agent; in production the browser only talks to
 * this server, so /a2ui/ws and /a2ui/health are forwarded here, behind Bot HQ sign-in.
 * Frames are relayed verbatim: one A2UI v1.0 message per text frame, in both directions.
 *
 * MVP limitation (PRD defers multi-client isolation): the agent holds ONE global session. So the relay
 * admits a single workspace, BOTHQ_A2UI_OWNER (a Bot HQ user id or email; workspace members' sessions
 * carry the owner's id, so they are admitted too). Unset, any signed-in user is admitted (warned at startup).
 */

export const TOKEN_HEADER = 'x-bothq-a2ui-token';
/** Frames the browser may send before the upstream socket opens; beyond this the client is closed. */
export const MAX_PENDING_FRAMES = 64;
export const MAX_PENDING_BYTES = 1 << 20;

interface RelayConfig {
  agentUrl: string;
  token: string | undefined;
  owner: string | undefined;
}

/** Read at call time (not import time) so tests and restarts see the current environment. */
function config(): RelayConfig {
  return {
    agentUrl: (process.env.BOTHQ_A2UI_AGENT_URL || 'http://127.0.0.1:8790').replace(/\/$/, ''),
    token: process.env.BOTHQ_A2UI_TOKEN || undefined,
    // '' is NOT unset: a blank owner fails closed (nobody admitted) rather than opening to everyone.
    owner: process.env.BOTHQ_A2UI_OWNER === undefined ? undefined : process.env.BOTHQ_A2UI_OWNER.trim(),
  };
}

const tokenHeaders = (token: string | undefined): Record<string, string> => (token ? { [TOKEN_HEADER]: token } : {});

/** The workspace id BOTHQ_A2UI_OWNER names: an id as-is, an email resolved to its user's workspace. */
function ownerWorkspaceId(owner: string): string | null {
  if (!owner) return null;
  const r = (owner.includes('@')
    ? db.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').get(owner)
    : db.prepare('SELECT id FROM users WHERE id=?').get(owner)) as { id: string } | undefined;
  if (!r) return owner.includes('@') ? null : owner;
  // The named person may themselves be a member of someone else's workspace.
  const m = db.prepare('SELECT workspace_id FROM workspace_members WHERE user_id=?').get(r.id) as { workspace_id: string } | undefined;
  return m?.workspace_id ?? r.id;
}

/** Whether this signed-in user's workspace may use the (single, global) agent. */
export function a2uiAllowed(user: User, owner = config().owner): boolean {
  if (owner === undefined) return true;
  const ws = ownerWorkspaceId(owner);
  return ws !== null && user.id === ws;
}

/** Cookie parse failures (e.g. `grokbot_session=%`) mean signed out, never a thrown error. */
function safeUser(cookieHeader: string | undefined): User | null {
  try {
    return userFromCookieHeader(cookieHeader);
  } catch {
    return null;
  }
}

/**
 * Cross-site WebSocket hijacking guard. Browsers always send Origin on a WebSocket handshake, so a
 * request without one is a non-browser client, which cannot ride a victim's cookie; it is allowed and
 * still needs a valid session. A browser Origin must be the app's own origin (APP_URL) or match Host.
 */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  try {
    if (o.origin === new URL(env.appUrl).origin) return true;
  } catch {
    /* bad APP_URL: fall through to the Host comparison */
  }
  return !!req.headers.host && o.host === req.headers.host;
}

export const a2uiApi = new Hono<AuthVars>();
a2uiApi.get('/health', requireUser, async (c) => {
  if (!a2uiAllowed(c.get('user'))) return c.json({ error: 'not this workspace' }, 403);
  const { agentUrl, token } = config();
  try {
    const r = await fetch(`${agentUrl}/a2ui/health`, { headers: tokenHeaders(token), signal: AbortSignal.timeout(3000) });
    return c.json(await r.json(), r.status as 200);
  } catch {
    return c.json({ error: 'a2ui agent offline' }, 502);
  }
});

function reject(socket: Duplex, status: string) {
  try {
    if (socket.writable) socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    /* socket already gone */
  }
  socket.destroy();
}

export interface A2uiRelayOptions {
  /** How often an open relay re-checks the session (default 60 s). */
  revalidateMs?: number;
}

export function attachA2uiRelay(server: Server, opts: A2uiRelayOptions = {}) {
  const revalidateMs = opts.revalidateMs ?? 60_000;
  if (config().owner === undefined) {
    console.warn('[a2ui] BOTHQ_A2UI_OWNER is unset: every signed-in Bot HQ user shares the one A2UI agent session (MVP limitation, docs/a2ui/CONTRACT.md).');
  }
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Nothing in here may throw: an exception in an 'upgrade' listener takes the whole server down.
    try {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', 'http://x').pathname;
      } catch {
        return; // not ours to judge
      }
      if (pathname !== '/a2ui/ws') return; // not ours
      socket.on('error', () => socket.destroy());

      if (!originAllowed(req)) return reject(socket, '403 Forbidden');
      const user = safeUser(req.headers.cookie);
      if (!user) return reject(socket, '401 Unauthorized');
      if (!a2uiAllowed(user)) return reject(socket, '403 Forbidden');

      const cookie = req.headers.cookie;
      wss.handleUpgrade(req, socket, head, (client) => {
        try {
          relay(client, cookie, revalidateMs);
        } catch (e) {
          console.error('[a2ui] relay setup failed', e);
          try { client.close(1011, 'relay error'); } catch { /* ignore */ }
        }
      });
    } catch (e) {
      console.error('[a2ui] upgrade failed', e);
      reject(socket, '500 Internal Server Error');
    }
  });
}

function relay(client: WebSocket, cookie: string | undefined, revalidateMs: number) {
  const { agentUrl, token } = config();
  const upstream = new WebSocket(`${agentUrl.replace(/^http/, 'ws')}/a2ui/ws`, { headers: tokenHeaders(token), handshakeTimeout: 5000 });
  const pending: string[] = [];
  let pendingBytes = 0;
  let closed = false;

  // Either side closing ends both; the renderer reconnects with backoff and gets a fresh snapshot.
  const close = (code = 1000, reason = '') => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    try { client.close(code, reason); } catch { /* ignore */ }
    try { upstream.close(); } catch { /* ignore */ }
  };

  // Auth is checked at handshake; re-check so a signed-out / expired / removed session loses the socket.
  const timer = setInterval(() => {
    try {
      const u = safeUser(cookie);
      if (!u || !a2uiAllowed(u)) close(4401, 'session ended');
    } catch {
      close(1011, 'relay error');
    }
  }, revalidateMs);
  timer.unref?.();

  upstream.on('open', () => {
    for (const m of pending.splice(0)) upstream.send(m);
    pendingBytes = 0;
  });
  upstream.on('message', (data: RawData, isBinary: boolean) => {
    if (!isBinary && client.readyState === WebSocket.OPEN) client.send(data.toString());
  });
  client.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const m = data.toString();
    if (upstream.readyState === WebSocket.OPEN) return upstream.send(m);
    pendingBytes += Buffer.byteLength(m);
    if (pending.length >= MAX_PENDING_FRAMES || pendingBytes > MAX_PENDING_BYTES) return close(1013, 'agent not ready');
    pending.push(m);
  });
  upstream.on('close', () => close(1011, 'agent closed'));
  upstream.on('error', () => close(1011, 'agent unreachable'));
  client.on('close', () => close());
  client.on('error', () => close());
}
