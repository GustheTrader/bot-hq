import fs from 'node:fs';
import { env } from './env.js';

/**
 * 9Router (github.com/decolua/9router) on the bots' computer: one OpenAI-compatible endpoint that
 * routes the bots' `hq-*` model names across free and cheap providers with automatic fallback.
 * Hermes reaches it as the provider `9router`; this module is the Settings side: which provider
 * keys are connected, adding or removing one, and its few feature switches.
 *
 * It talks to 9Router's own dashboard API on localhost, signed in with the dashboard password from
 * a root-only file. Keys pass through on the way in and are never read back: 9Router's list
 * endpoint does not return them, and nothing here logs a request body.
 *
 * House rule (the owner's): no frontier labs in 9Router. Only open-weight model hosts and Google.
 * Anthropic, OpenAI, xAI and the subscription sign-ins stay on their direct harness sign-ins.
 */

export interface RouterProviderDef {
  id: string;
  name: string;
  group: 'google' | 'free' | 'paid';
  note: string;
  /** Where to get a key. */
  keyUrl: string;
  /** Extra field the provider needs besides the key. */
  extra?: { field: 'accountId'; label: string };
}

/** Providers this app lets you connect, in the order Settings shows them. */
export const ROUTER_PROVIDERS: RouterProviderDef[] = [
  { id: 'gemini', name: 'Google Gemini (AI Studio)', group: 'google', note: 'Gemini 4, 3.x Flash and Gemma 4. Free tier with rate limits.', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'nvidia', name: 'NVIDIA NIM', group: 'free', note: 'DeepSeek V4, GLM 5.2, Kimi K2.6, MiniMax M3, Nemotron. Free developer credits.', keyUrl: 'https://build.nvidia.com/' },
  { id: 'cerebras', name: 'Cerebras', group: 'free', note: 'Qwen 3 235B / 32B, GLM 4.7. Free tier, very fast.', keyUrl: 'https://cloud.cerebras.ai/' },
  { id: 'groq', name: 'Groq', group: 'free', note: 'Qwen3 32B and Llama. Free tier, very fast.', keyUrl: 'https://console.groq.com/keys' },
  { id: 'cloudflare-ai', name: 'Cloudflare Workers AI', group: 'free', note: 'Kimi K2.6, GLM 4.7 Flash, Qwen. Free daily allowance.', keyUrl: 'https://dash.cloudflare.com/profile/api-tokens', extra: { field: 'accountId', label: 'Account ID' } },
  { id: 'openrouter', name: 'OpenRouter', group: 'free', note: 'Its free open models. The bots only ever ask for open models through it.', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'deepseek', name: 'DeepSeek', group: 'paid', note: 'DeepSeek V4 on its own API. Cheap.', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'glm', name: 'GLM (Z.ai)', group: 'paid', note: 'GLM 5.x coding models. About $0.6 per million tokens.', keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
  { id: 'kimi', name: 'Kimi (Moonshot)', group: 'paid', note: 'Kimi K2/K3. Cheap.', keyUrl: 'https://platform.moonshot.ai/console/api-keys' },
  { id: 'minimax', name: 'MiniMax', group: 'paid', note: 'MiniMax M3. About $0.2 per million tokens.', keyUrl: 'https://platform.minimax.io/' },
  { id: 'mistral', name: 'Mistral', group: 'paid', note: 'Mistral open-weight models.', keyUrl: 'https://console.mistral.ai/api-keys' },
];

/** What 9Router offers that this app keeps out, and why (shown so nobody wonders where they went). */
export const ROUTER_EXCLUDED: { name: string; why: string }[] = [
  { name: 'Claude Code, OpenAI Codex, GitHub Copilot, Cursor, Kilo Code, Cline', why: 'Subscription sign-ins: frontier labs, and sharing a personal plan across bots breaks their terms. Bots use these through their own harness sign-ins.' },
  { name: 'OpenAI, Anthropic, xAI Grok, Azure OpenAI', why: 'Frontier labs are kept out of 9Router.' },
  { name: 'Kiro AI', why: 'Serves Claude models.' },
  { name: 'OpenCode Free', why: 'Its models are unnamed, so they can’t be checked as open.' },
  { name: 'iFlow, Qwen Code', why: 'Their free tiers ended in 2026.' },
];

/** Feature switches Settings may change. Cloud sync, the public tunnel and Headroom stay off. */
export const ROUTER_FEATURES = {
  rtkEnabled: { name: 'Token saver (RTK)', note: 'Shrinks long tool output (diffs, file lists, logs) before the model reads it. Keeps the original if a filter fails.' },
  cavemanEnabled: { name: 'Caveman mode', note: 'Asks models to answer tersely. Saves output tokens; not for customer-facing writing.' },
  ponytailEnabled: { name: 'Ponytail', note: 'A “lazy senior dev” system prompt for coding work. Off unless you want it.' },
} as const;
export type RouterFeature = keyof typeof ROUTER_FEATURES;
export const isRouterFeature = (k: unknown): k is RouterFeature => typeof k === 'string' && Object.prototype.hasOwnProperty.call(ROUTER_FEATURES, k);

/** The model groups the bots use (9Router combos). */
export const ROUTER_MODELS = ['hq-free', 'hq-smart', 'hq-google'] as const;

const readFile = (file: string) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };

export const routerConfigured = () => !!(env.ninerouterUrl && env.ninerouterPasswordFile);

// ---------- dashboard session ----------

let cookie = '';

async function login(): Promise<void> {
  const password = readFile(env.ninerouterPasswordFile);
  if (!password) throw new Error('9Router’s dashboard password file is missing on the computer');
  const r = await fetch(`${env.ninerouterUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }), signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`9Router refused the dashboard sign-in (${r.status})`);
  const set = r.headers.getSetCookie?.() ?? [];
  const token = set.map((s) => s.split(';')[0]).find((s) => s.startsWith('auth_token='));
  if (!token) throw new Error('9Router did not return a session');
  cookie = token;
}

/** A dashboard API call, signing in once more if the session expired. */
async function dash(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}, retried = false): Promise<any> {
  if (!routerConfigured()) throw new Error('9Router is not set up on this server');
  if (!cookie) await login();
  const r = await fetch(`${env.ninerouterUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: { cookie, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
  });
  if ((r.status === 401 || r.status === 403) && !retried) { cookie = ''; return dash(path, init, true); }
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(String(data?.error ?? `9Router answered ${r.status}`));
  return data;
}

// ---------- what Settings reads ----------

export interface RouterConnection { id: string; provider: string; name: string; active: boolean; status: string | null; lastError: string | null }
export interface RouterStatus {
  configured: boolean;
  up: boolean;
  error: string | null;
  connections: RouterConnection[];
  combos: { name: string; models: number }[];
  features: Record<RouterFeature, boolean>;
  /** Safety settings this app keeps off; true would mean someone changed them in 9Router's own dashboard. */
  exposed: { cloudSync: boolean; tunnel: boolean; requireApiKey: boolean };
}

const short = (s: unknown) => (typeof s === 'string' && s ? s.slice(0, 200) : null);

export async function routerStatus(): Promise<RouterStatus> {
  const empty: RouterStatus = { configured: routerConfigured(), up: false, error: null, connections: [], combos: [], features: { rtkEnabled: false, cavemanEnabled: false, ponytailEnabled: false }, exposed: { cloudSync: false, tunnel: false, requireApiKey: true } };
  if (!routerConfigured()) return empty;
  try {
    const [p, c, s] = await Promise.all([dash('/api/providers'), dash('/api/combos'), dash('/api/settings')]);
    // Only these fields leave this module: never a key, token or anything else 9Router stores.
    const connections: RouterConnection[] = (Array.isArray(p?.connections) ? p.connections : []).map((x: any) => ({
      id: String(x.id), provider: String(x.provider), name: String(x.name ?? x.provider),
      active: x.isActive !== false, status: short(x.testStatus), lastError: short(x.lastError),
    }));
    const combos = (Array.isArray(c?.combos) ? c.combos : []).map((x: any) => ({ name: String(x.name), models: Array.isArray(x.models) ? x.models.length : 0 }));
    return {
      configured: true, up: true, error: null, connections, combos,
      features: { rtkEnabled: !!s?.rtkEnabled, cavemanEnabled: !!s?.cavemanEnabled, ponytailEnabled: !!s?.ponytailEnabled },
      exposed: { cloudSync: !!s?.cloudEnabled, tunnel: !!s?.tunnelEnabled, requireApiKey: s?.requireApiKey !== false },
    };
  } catch (e: any) {
    return { ...empty, error: String(e?.message ?? e) };
  }
}

// ---------- changes ----------

export class RouterUserError extends Error {}

/** Check a key with the provider, save it in 9Router, then prove it with one real call. */
export async function addRouterKey(provider: string, apiKey: string, extra?: { accountId?: string }): Promise<{ connection: RouterConnection | null; test: { ok: boolean; detail: string } }> {
  const def = ROUTER_PROVIDERS.find((p) => p.id === provider);
  if (!def) throw new RouterUserError('That provider isn’t one the bots may use.');
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (key.length < 8 || key.length > 4000 || /\s/.test(key)) throw new RouterUserError('That doesn’t look like an API key.');
  const providerSpecificData: Record<string, string> = {};
  if (def.extra) {
    const v = String(extra?.[def.extra.field] ?? '').trim();
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(v)) throw new RouterUserError(`${def.extra.label} is required for ${def.name}.`);
    providerSpecificData[def.extra.field] = v;
  }
  const body = { provider, apiKey: key, ...(def.extra ? { providerSpecificData } : {}) };
  const check = await dash('/api/providers/validate', { method: 'POST', body, timeoutMs: 30_000 });
  if (check?.valid !== true) throw new RouterUserError(`${def.name} rejected the key${check?.error ? `: ${String(check.error).slice(0, 160)}` : '.'}`);
  const saved = await dash('/api/providers', { method: 'POST', body: { ...body, name: def.name, testStatus: 'active' }, timeoutMs: 15_000 });
  const x = saved?.connection ?? saved;
  const connection: RouterConnection | null = x?.id ? { id: String(x.id), provider, name: String(x.name ?? def.name), active: x.isActive !== false, status: short(x.testStatus), lastError: null } : null;
  // Some providers' validate only checks the format; a real call says whether the key works.
  return { connection, test: await testProvider(provider) };
}

export async function removeRouterKey(id: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new RouterUserError('Unknown connection.');
  await dash(`/api/providers/${id}`, { method: 'DELETE' });
}

export async function setRouterFeature(feature: RouterFeature, on: boolean): Promise<void> {
  await dash('/api/settings', { method: 'PATCH', body: { [feature]: !!on } });
}

/** One provider's cheapest model, used to prove a fresh key with a real call. */
const TEST_MODEL: Record<string, string> = {
  gemini: 'gemini/gemini-3.5-flash-lite', nvidia: 'nvidia/deepseek-ai/deepseek-v4-flash', cerebras: 'cerebras/qwen-3-32b',
  groq: 'groq/qwen/qwen3-32b', 'cloudflare-ai': 'cloudflare-ai/@cf/zai-org/glm-4.7-flash', openrouter: 'openrouter/typesafe/jev-1.13',
  deepseek: 'deepseek/deepseek-v4-flash', glm: 'glm/glm-5.3-flash', kimi: 'kimi/kimi-k2.6', minimax: 'minimax/MiniMax-M3', mistral: 'mistral/codestral-latest',
};

/** A one-line chat through 9Router's client endpoint, as the bots would call it. */
export async function testModel(model: string): Promise<{ ok: boolean; detail: string }> {
  const key = readFile(env.ninerouterKeyFile);
  if (!key) return { ok: false, detail: 'No 9Router client key on the computer.' };
  try {
    const r = await fetch(`${env.ninerouterUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 16 }),
      signal: AbortSignal.timeout(60_000),
    });
    const d: any = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray(d?.choices)) return { ok: true, detail: `Answered${d.model ? ` (${String(d.model).slice(0, 80)})` : ''}.` };
    return { ok: false, detail: String(d?.error?.message ?? d?.error ?? `9Router answered ${r.status}`).slice(0, 200) };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 200) };
  }
}

export const testProvider = (provider: string) => testModel(TEST_MODEL[provider] ?? 'hq-free');
