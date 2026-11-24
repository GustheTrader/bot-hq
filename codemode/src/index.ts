/**
 * Code Mode executor for Bot HQ.
 *
 * Bot HQ hands it a bot's script; the script runs in a fresh V8 isolate (Worker Loader) with no
 * network at all (`globalOutbound: null`). The only way out is the `codemode.*` functions, and each
 * of those is one HTTPS call back to Bot HQ (`POST {HQ_URL}/mcp/<botId>/inner`) carrying a
 * short-lived run token Bot HQ minted for this run. Policies, approvals and the activity rows stay
 * in Bot HQ; this Worker only runs code.
 *
 *   POST /types  {tools:[{name,description,inputSchema}]}         -> {types}
 *   POST /run    {code, botId, runToken, tools:[name]}             -> {result, error?, logs?, calls}
 *
 * Both need `Authorization: Bearer <CODEMODE_SECRET>`.
 */
import { DynamicWorkerExecutor, generateTypesFromJsonSchema } from '@cloudflare/codemode';

interface Env {
  LOADER: any;
  /** Shared secret Bot HQ sends on every request. */
  CODEMODE_SECRET: string;
  /** Where Bot HQ answers inner tool calls, e.g. http://127.0.0.1:8797. Fixed here, never taken from a request. */
  HQ_URL: string;
}

const MAX_CALLS = 50;
const TIMEOUT_MS = 30_000;
const MAX_RESULT_CHARS = 20_000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Tool outputs come back as text; hand the script real JSON when the text is JSON. */
function parseOutput(text: string): unknown {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.parse(t); } catch { /* plain text */ } }
  return text;
}

function capResult(result: unknown): unknown {
  if (result === undefined) return null;
  let s: string;
  try { s = typeof result === 'string' ? result : JSON.stringify(result); } catch { s = String(result); }
  if (s.length <= MAX_RESULT_CHARS) return result;
  return `${s.slice(0, MAX_RESULT_CHARS)}\n…[truncated ${s.length - MAX_RESULT_CHARS} characters: return less, or summarise inside the script]`;
}

async function run(env: Env, body: any) {
  const { code, botId, runToken, tools } = body ?? {};
  if (typeof code !== 'string' || !code.trim()) return json({ error: 'code is required' }, 400);
  if (typeof botId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(botId)) return json({ error: 'bad botId' }, 400);
  if (typeof runToken !== 'string' || !runToken) return json({ error: 'runToken is required' }, 400);
  const names: string[] = Array.isArray(tools) ? tools.filter((n: unknown): n is string => typeof n === 'string') : [];

  let calls = 0;
  const hq = env.HQ_URL.replace(/\/+$/, '');
  const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const name of names) {
    fns[name] = async (args: unknown) => {
      if (++calls > MAX_CALLS) throw new Error(`Too many tool calls in one script (limit ${MAX_CALLS}).`);
      const r = await fetch(`${hq}/mcp/${botId}/inner`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${runToken}` },
        body: JSON.stringify({ name, args: args && typeof args === 'object' ? args : {} }),
      });
      const data: any = await r.json().catch(() => ({ error: `Bot HQ answered ${r.status}` }));
      if (!r.ok || data.error) throw new Error(String(data.error ?? `Bot HQ answered ${r.status}`));
      if (data.isError) throw new Error(String(data.output));
      return parseOutput(String(data.output ?? ''));
    };
  }

  const executor = new DynamicWorkerExecutor({ loader: env.LOADER, timeout: TIMEOUT_MS, globalOutbound: null });
  const out = await executor.execute(code, [{ name: 'codemode', fns }]);
  return json({ result: capResult(out.result), error: out.error, logs: (out.logs ?? []).slice(-50), calls });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') return json({ ok: true });
    if (req.method !== 'POST') return json({ error: 'not found' }, 404);
    const given = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!sameSecret(given, env.CODEMODE_SECRET ?? '')) return json({ error: 'unauthorized' }, 401);
    let body: any;
    try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
    if (url.pathname === '/types') {
      const list: any[] = Array.isArray(body?.tools) ? body.tools : [];
      const descriptors: Record<string, { description?: string; inputSchema: any }> = {};
      for (const t of list) if (t && typeof t.name === 'string') descriptors[t.name] = { description: String(t.description ?? ''), inputSchema: t.inputSchema ?? { type: 'object', properties: {} } };
      return json({ types: generateTypesFromJsonSchema(descriptors as any) });
    }
    if (url.pathname === '/run') return run(env, body);
    return json({ error: 'not found' }, 404);
  },
};
