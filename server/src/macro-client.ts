import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from './env.js';
import { MACRO_SERVER } from './macro.js';

/**
 * Bot HQ's own line to Macro's MCP server, on the same shared sign-in the bots use (MACRO_AUTH_HOME/mcp-tokens).
 * Used by the GTM view to read the Macro workspace with fixed, server-written programs (ExecuteCode); nothing a
 * browser sends is ever run as code. Token refreshes are written back atomically to the same file Hermes reads,
 * so the bots and Bot HQ keep sharing one login.
 */

export class MacroError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 502 | 503 = 502) { super(message); }
}

type Fetch = (url: string, init?: any) => Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null }; text(): Promise<string> }>;

const tokenFile = () => path.join(env.macroAuthHome, 'mcp-tokens', `${MACRO_SERVER}.json`);
const clientFile = () => path.join(env.macroAuthHome, 'mcp-tokens', `${MACRO_SERVER}.client.json`);

function readJson(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Atomic replace in the same folder (temp file + rename), the way Hermes writes it. */
export function writeTokenFile(data: any, file = tokenFile()) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const expiresAtMs = (t: any) => { const e = Number(t?.expires_at ?? 0); return e > 0 ? (e < 1e12 ? e * 1000 : e) : 0; };

/** The token endpoint is the MCP server's own origin (its OAuth metadata names /token). */
const tokenEndpoint = () => new URL('/token', env.macroMcpUrl).toString();

export async function refreshTokens(fetchFn: Fetch = fetch as any): Promise<any> {
  const t = readJson(tokenFile());
  const client = readJson(clientFile());
  if (!t?.refresh_token || !client?.client_id) throw new MacroError('Macro is not signed in. Sign in under Settings → Connected apps → Macro.', 401);
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client.client_id, resource: env.macroMcpUrl });
  if (client.client_secret) body.set('client_secret', client.client_secret);
  const r = await fetchFn(tokenEndpoint(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  if (!r.ok) {
    // Another process (a bot) may have refreshed a moment ago and rotated the refresh token; use its result.
    const again = readJson(tokenFile());
    if (again?.access_token && again.access_token !== t.access_token && expiresAtMs(again) > Date.now() + 60_000) return again;
    throw new MacroError('Macro sign-in has expired. Sign in again under Settings → Connected apps → Macro.', 401);
  }
  const n = JSON.parse(text);
  const next = { ...t, access_token: n.access_token, token_type: n.token_type ?? t.token_type, refresh_token: n.refresh_token ?? t.refresh_token, expires_in: n.expires_in, expires_at: n.expires_in ? Date.now() / 1000 + Number(n.expires_in) : t.expires_at };
  writeTokenFile(next);
  return next;
}

async function accessToken(fetchFn: Fetch): Promise<string> {
  let t = readJson(tokenFile());
  if (!t?.access_token) throw new MacroError('Macro is not signed in. Sign in under Settings → Connected apps → Macro.', 401);
  if (expiresAtMs(t) && expiresAtMs(t) < Date.now() + 60_000) t = await refreshTokens(fetchFn);
  return t.access_token;
}

/** Parses a Streamable-HTTP MCP reply: plain JSON, or SSE `data:` lines. */
export function parseMcpReply(text: string, contentType: string, id: number): any {
  if (contentType.includes('event-stream')) {
    const msgs = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);
    return msgs.find((m: any) => m.id === id) ?? msgs.at(-1) ?? null;
  }
  return text ? JSON.parse(text) : null;
}

async function mcp(token: string, method: string, params: any, id: number | undefined, session: { id: string | null }, fetchFn: Fetch) {
  const r = await fetchFn(env.macroMcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`,
      'mcp-protocol-version': '2025-06-18', ...(session.id ? { 'mcp-session-id': session.id } : {}),
    },
    body: JSON.stringify(id === undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(45_000),
  });
  session.id = r.headers.get('mcp-session-id') ?? session.id;
  const text = await r.text();
  if (r.status === 401) throw new MacroError('unauthorized', 401);
  if (!r.ok) throw new MacroError(`Macro answered ${r.status}.`);
  return id === undefined ? null : parseMcpReply(text, r.headers.get('content-type') ?? '', id);
}

async function callToolOnce(token: string, name: string, args: any, fetchFn: Fetch) {
  const session = { id: null as string | null };
  await mcp(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bot-hq', version: '1' } }, 1, session, fetchFn);
  await mcp(token, 'notifications/initialized', {}, undefined, session, fetchFn);
  const msg = await mcp(token, 'tools/call', { name, arguments: args }, 2, session, fetchFn);
  if (msg?.error) throw new MacroError(String(msg.error.message ?? 'Macro tool error').slice(0, 300));
  const text = (msg?.result?.content ?? []).map((p: any) => p?.text ?? '').join('');
  return text;
}

/** Calls one Macro MCP tool; on 401, refreshes once and retries. */
export async function callMacroTool(name: string, args: any, fetchFn: Fetch = fetch as any): Promise<string> {
  if (!env.macroMcpUrl) throw new MacroError('Macro is not set up on this server.', 503);
  try { return await callToolOnce(await accessToken(fetchFn), name, args, fetchFn); }
  catch (e) {
    if (!(e instanceof MacroError) || e.status !== 401 || e.message !== 'unauthorized') throw e;
    const t = await refreshTokens(fetchFn);
    return callToolOnce(t.access_token, name, args, fetchFn);
  }
}

/** Runs one server-written program with ExecuteCode and returns its `data`. */
export async function runMacroProgram<T = any>(source: string, fetchFn: Fetch = fetch as any): Promise<T> {
  const text = await callMacroTool('ExecuteCode', { source }, fetchFn);
  let out: any;
  try { out = JSON.parse(text); } catch { throw new MacroError('Macro sent an answer Bot HQ could not read.'); }
  if (out.status !== 'succeeded') {
    const err = String(out.error ?? 'Macro could not run the request.');
    if (/not in a team/i.test(err)) throw new MacroError('Macro’s CRM needs your Macro account to be in a team.', 400);
    throw new MacroError(err.replace(/^MacroApiError:\s*/, '').slice(0, 300));
  }
  return out.result?.data as T;
}
