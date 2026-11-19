import fs from 'node:fs';

/**
 * Apache Superset, self-hosted on this computer, embedded in RevOpt Admin's BI tab.
 *
 * Bot HQ signs in to Superset as a service account (SUPERSET_USER, password in SUPERSET_PASSWORD_FILE, never sent
 * to the browser), lists dashboards, turns on embedding for one when asked, and mints short-lived **guest tokens**
 * that let the page show exactly one embedded dashboard, view-only, as the signed-in person. The browser only ever
 * gets the public Superset address, the dashboard's embed id and a guest token.
 *
 *   SUPERSET_URL         where this server reaches Superset (default http://127.0.0.1:8088)
 *   SUPERSET_PUBLIC_URL  the address browsers load the embedded dashboard from (https)
 *   SUPERSET_USER / SUPERSET_PASSWORD_FILE   the service account
 */

export class SupersetError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502 = 502) { super(message); }
}

type Res = { ok: boolean; status: number; json(): Promise<any>; headers: { get(n: string): string | null } };
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Res>;

export interface SupersetConfig { url: string; publicUrl: string; user: string; password: string }

export function supersetConfig(env: NodeJS.ProcessEnv = process.env): SupersetConfig | null {
  const publicUrl = (env.SUPERSET_PUBLIC_URL ?? '').replace(/\/+$/, '');
  const user = env.SUPERSET_USER ?? '';
  let password = env.SUPERSET_PASSWORD ?? '';
  if (!password && env.SUPERSET_PASSWORD_FILE) { try { password = fs.readFileSync(env.SUPERSET_PASSWORD_FILE, 'utf8').trim(); } catch { password = ''; } }
  if (!publicUrl || !user || !password) return null;
  return { url: (env.SUPERSET_URL ?? 'http://127.0.0.1:8088').replace(/\/+$/, ''), publicUrl, user, password };
}

/** A signed-in session with Superset: an access token plus the CSRF token and cookie its POSTs need. */
async function session(cfg: SupersetConfig, f: Fetch) {
  const call = async (path: string, init: Parameters<Fetch>[1] = {}) => {
    try { return await f(`${cfg.url}${path}`, { ...init, signal: AbortSignal.timeout(15_000) }); }
    catch { throw new SupersetError('Superset is not answering on this computer.'); }
  };
  const login = await call('/api/v1/security/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.user, password: cfg.password, provider: 'db', refresh: false }),
  });
  if (!login.ok) throw new SupersetError(login.status === 401 ? 'Bot HQ could not sign in to Superset (check its service account).' : `Superset sign-in failed (${login.status}).`);
  const token = (await login.json())?.access_token as string | undefined;
  if (!token) throw new SupersetError('Superset did not return a sign-in token.');
  const auth = { Authorization: `Bearer ${token}` };
  const csrfRes = await call('/api/v1/security/csrf_token/', { headers: auth });
  const csrf = csrfRes.ok ? ((await csrfRes.json())?.result as string | undefined) : undefined;
  const cookie = csrfRes.headers.get('set-cookie')?.split(';')[0] ?? '';
  const write = { ...auth, 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRFToken': csrf, Referer: cfg.url } : {}), ...(cookie ? { Cookie: cookie } : {}) };
  return { call, auth, write };
}

export interface Dashboard { id: number; title: string; embedId: string | null; url: string; changedAt: string | null }

/** Dashboards, with their embed id when embedding is turned on. */
export async function listDashboards(cfg: SupersetConfig, f: Fetch = fetch as unknown as Fetch): Promise<Dashboard[]> {
  const s = await session(cfg, f);
  const r = await s.call('/api/v1/dashboard/?q=(page_size:100,order_column:changed_on_delta_humanized,order_direction:desc)', { headers: s.auth });
  if (!r.ok) throw new SupersetError(`Superset would not list dashboards (${r.status}).`);
  const rows = ((await r.json())?.result ?? []) as any[];
  const out: Dashboard[] = [];
  for (const d of rows.slice(0, 100)) {
    const e = await s.call(`/api/v1/dashboard/${Number(d.id)}/embedded`, { headers: s.auth });
    const embedId = e.ok ? ((await e.json())?.result?.uuid ?? null) : null;
    out.push({ id: Number(d.id), title: String(d.dashboard_title ?? `Dashboard ${d.id}`), embedId, url: `${cfg.publicUrl}${d.url ?? `/superset/dashboard/${d.id}/`}`, changedAt: d.changed_on_utc ?? null });
  }
  return out;
}

/** Turns on embedding for a dashboard, allowed only from the Bot HQ web app's own origin(s). */
export async function enableEmbedding(cfg: SupersetConfig, dashboardId: unknown, allowedOrigins: string[], f: Fetch = fetch as unknown as Fetch): Promise<string> {
  const id = Number(dashboardId);
  if (!Number.isInteger(id) || id <= 0) throw new SupersetError('Unknown dashboard.', 400);
  const s = await session(cfg, f);
  const r = await s.call(`/api/v1/dashboard/${id}/embedded`, { method: 'POST', headers: s.write, body: JSON.stringify({ allowed_domains: allowedOrigins }) });
  if (r.status === 404) throw new SupersetError('That dashboard is not in Superset.', 404);
  if (!r.ok) throw new SupersetError(`Superset would not turn on embedding (${r.status}).`);
  const uuid = (await r.json())?.result?.uuid as string | undefined;
  if (!uuid) throw new SupersetError('Superset did not return an embed id.');
  return uuid;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A short-lived guest token for one embedded dashboard, named after the person viewing it. */
export async function guestToken(cfg: SupersetConfig, embedId: unknown, viewer: { id: string; name: string }, f: Fetch = fetch as unknown as Fetch): Promise<string> {
  if (typeof embedId !== 'string' || !UUID_RE.test(embedId)) throw new SupersetError('Unknown embedded dashboard.', 400);
  const s = await session(cfg, f);
  const [first, ...rest] = (viewer.name || 'Bot HQ').split(/\s+/);
  const r = await s.call('/api/v1/security/guest_token/', {
    method: 'POST', headers: s.write,
    body: JSON.stringify({ user: { username: `bothq_${viewer.id}`.slice(0, 60), first_name: first ?? 'Bot', last_name: rest.join(' ') || 'HQ' }, resources: [{ type: 'dashboard', id: embedId }], rls: [] }),
  });
  if (!r.ok) throw new SupersetError(`Superset would not issue a guest token (${r.status}).`);
  const token = (await r.json())?.token as string | undefined;
  if (!token) throw new SupersetError('Superset did not return a guest token.');
  return token;
}
