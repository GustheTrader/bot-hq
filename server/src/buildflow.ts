import fs from 'node:fs';
import type { Context } from 'hono';
import { userFromCookieHeader } from './lib/auth.js';

/**
 * Build-flow: the internal construction app (GustheTrader/Build-flow) running on this computer (BUILDFLOW_URL,
 * e.g. http://127.0.0.1:3320). Bot HQ serves it under /buildflow/ behind its own sign-in, and gives the bots tools
 * for it. Calls carry the service key (BUILDFLOW_API_KEY_FILE) and an x-actor naming who acted.
 *
 * The client portal (/buildflow/portal/<link>, its API and the page assets) is public on purpose: homeowners open
 * their private link without a Bot HQ account. Every other path needs a Bot HQ session.
 */

export const buildflowUrl = () => (process.env.BUILDFLOW_URL ?? '').replace(/\/+$/, '');
export const buildflowEnabled = () => !!buildflowUrl();

let keyCache: { file: string; mtime: number; key: string } | null = null;
function serviceKey(): string {
  const file = process.env.BUILDFLOW_API_KEY_FILE;
  if (!file) return process.env.BUILDFLOW_API_KEY ?? '';
  try {
    const st = fs.statSync(file);
    if (!keyCache || keyCache.file !== file || keyCache.mtime !== st.mtimeMs) keyCache = { file, mtime: st.mtimeMs, key: fs.readFileSync(file, 'utf8').trim() };
    return keyCache.key;
  } catch { return ''; }
}

export class BuildflowError extends Error {}

/** One Build-flow API call as `actor`. Paths are under /api/v1. */
export async function bf(method: string, path: string, actor: string, body?: unknown): Promise<any> {
  if (!buildflowEnabled()) throw new BuildflowError('Build-flow is not connected on this server.');
  const r = await fetch(`${buildflowUrl()}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': serviceKey(), 'x-actor': actor.slice(0, 120) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => { throw new BuildflowError('Build-flow is not answering on this computer.'); });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!r.ok) throw new BuildflowError(data?.error ?? `Build-flow answered ${r.status}.`);
  return data;
}

// ---------- /buildflow/* pass-through ----------

const SIGN_IN_FIRST = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Build-flow</title><body style="font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#111"><p>Sign in to Bot HQ first, then open Build-flow from its sidebar. <a href="/" target="_top">Go to Bot HQ</a></p></body>';
const PUBLIC = /^\/(assets\/|portal\/|api\/v1\/portal\/|favicon|use\.txt$)/;
const DROP_REQ = new Set(['host', 'cookie', 'authorization', 'x-api-key', 'x-actor', 'connection', 'content-length', 'accept-encoding']);
const DROP_RES = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie']);

export async function proxyBuildflow(c: Context): Promise<Response> {
  if (!buildflowEnabled()) return c.json({ error: 'Build-flow is not connected.' }, 404);
  const url = new URL(c.req.url);
  const path = url.pathname.replace(/^\/buildflow/, '') || '/';
  const headers = new Headers();
  c.req.raw.headers.forEach((v, k) => { if (!DROP_REQ.has(k.toLowerCase())) headers.set(k, v); });
  if (!PUBLIC.test(path)) {
    const user = userFromCookieHeader(c.req.header('cookie'));
    // No redirect: behind Vercel's rewrite a relative Location comes back as Zo's address. A page with a link
    // back to Bot HQ (relative, so it stays on whichever address the person used) works everywhere.
    if (!user) return path.startsWith('/api/') ? c.json({ error: 'unauthenticated' }, 401) : c.html(SIGN_IN_FIRST, 401);
    headers.set('x-api-key', serviceKey());
    headers.set('x-actor', `${user.name} <${user.email}>`.slice(0, 120));
  }
  const method = c.req.method;
  let r: Response;
  try {
    r = await fetch(`${buildflowUrl()}${path}${url.search}`, {
      method, headers, redirect: 'manual',
      body: method === 'GET' || method === 'HEAD' ? undefined : await c.req.arrayBuffer(),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return c.json({ error: 'Build-flow is not answering on this computer.' }, 502);
  }
  const out = new Headers();
  r.headers.forEach((v, k) => { if (!DROP_RES.has(k.toLowerCase())) out.set(k, v); });
  const loc = out.get('location');
  if (loc?.startsWith('/')) out.set('location', `/buildflow${loc}`);
  return new Response(r.body, { status: r.status, headers: out });
}
