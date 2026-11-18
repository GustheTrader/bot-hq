import './grok-guard.js';
import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { isLoopbackAddress } from './grok-guard.js';
import { db, now } from './db.js';
import { OPEN_STATUSES, grokIndexOk } from './grok-db.js';
import { appendRow, getBotRow, getLive, getRow } from './store.js';
import { dispatchJob, jobForQuestion, resumeBridgeJob } from './grok-jobs.js';

/**
 * Grok Bot bridge API. Served ONLY by its own listener (startGrokBridge: GROK_BRIDGE_PORT on loopback by
 * default); the main HQ app answers 404 for /api/integrations/*, so whatever edge forwards the main port can
 * never reach it. Guarded by one scoped key (SHA-256 at rest), separate from HQ sessions and the owner key.
 *
 * Order of checks: peer address -> failed-auth throttle per peer -> key -> DB-backed rate limit -> route.
 * Every authenticated request leaves a grok_audit row (key_id is a hash prefix, never the key).
 */

type Vars = { Variables: { ip: string; keyId: string | null } };
export const grokApi = new Hono<Vars>();

const MAX_BODY = 65_536;
const num = (name: string, d: number) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : d; };
const limits = () => ({
  postPerMin: num('GROK_RATE_POST_PER_MIN', 30),
  getPerMin: num('GROK_RATE_GET_PER_MIN', 120),
  openPerBot: num('GROK_MAX_OPEN_PER_BOT', 3),
  perDay: num('GROK_MAX_JOBS_PER_DAY', 50),
  authFails: num('GROK_AUTH_FAIL_LIMIT', 10),
  authWindowMs: 15 * 60_000,
});
/** Explicit allowlist; empty means no bot can be targeted (fail closed). */
const allowedBots = () => new Set((process.env.GROK_INTEGRATION_BOT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

function peer(c: Context): string {
  try { return getConnInfo(c).remote.address ?? 'unknown'; } catch { return 'in-process'; } // app.request() in tests has no socket
}

// The key hash can live in a root-only file that is re-read when it changes: emptying or deleting the file
// revokes the key without a restart. GROK_INTEGRATION_KEY_SHA256 (env) still works but needs a restart.
let keyCache: { file: string; mtime: number; size: number; hash: string } | null = null;
function expectedHash(): string {
  const file = process.env.GROK_INTEGRATION_KEY_SHA256_FILE;
  if (file) {
    try {
      const st = fs.statSync(file);
      if (!keyCache || keyCache.file !== file || keyCache.mtime !== st.mtimeMs || keyCache.size !== st.size) {
        keyCache = { file, mtime: st.mtimeMs, size: st.size, hash: fs.readFileSync(file, 'utf8').trim().toLowerCase() };
      }
      return keyCache.hash;
    } catch { keyCache = null; return ''; }
  }
  return (process.env.GROK_INTEGRATION_KEY_SHA256 ?? '').trim().toLowerCase();
}

function failuresInWindow(ip: string, t: number, windowMs: number): number {
  const r = db.prepare('SELECT window_start,count FROM grok_auth_fail WHERE ip=?').get(ip) as any;
  return r && r.window_start > t - windowMs ? r.count : 0;
}
function recordAuthFailure(ip: string, t: number, windowMs: number) {
  db.prepare(`INSERT INTO grok_auth_fail(ip,window_start,count,total,last_at) VALUES (?,?,1,1,?)
    ON CONFLICT(ip) DO UPDATE SET
      count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END,
      total = total + 1, last_at = excluded.last_at`).run(ip, t, t, t - windowMs, t - windowMs);
}

type AuditFields = { botId?: string | null; sourceRef?: string | null; jobId?: string | null; reason?: string | null };
function audit(c: Context<Vars>, status: number, f: AuditFields = {}) {
  db.prepare('INSERT INTO grok_audit(at,ip,key_id,method,route,bot_id,source_ref,job_id,status,reason) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    now(), c.get('ip'), c.get('keyId'), c.req.method, c.req.path.slice(0, 200),
    typeof f.botId === 'string' ? f.botId.slice(0, 200) : null, typeof f.sourceRef === 'string' ? f.sourceRef.slice(0, 500) : null, f.jobId ?? null, status, f.reason ?? null,
  );
}
function respond(c: Context<Vars>, status: number, body: unknown, f: AuditFields = {}) {
  audit(c, status, f);
  return c.json(body as any, status as any);
}

grokApi.use('*', async (c, next) => {
  const ip = peer(c);
  c.set('ip', ip);
  c.set('keyId', null);
  if (ip !== 'in-process' && !isLoopbackAddress(ip) && process.env.GROK_BRIDGE_ALLOW_NONLOOPBACK !== '1') return c.json({ error: 'forbidden' }, 403);
  const t = now();
  const L = limits();
  // Throttle before looking at the key, so a throttled peer cannot keep guessing.
  if (failuresInWindow(ip, t, L.authWindowMs) >= L.authFails) {
    recordAuthFailure(ip, t, L.authWindowMs);
    return c.json({ error: 'too many failed attempts' }, 429);
  }
  const hash = expectedHash();
  const given = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(c.req.header('authorization') ?? '')?.[1];
  const ok = !!given && /^[0-9a-f]{64}$/.test(hash) && !!process.env.GROK_INTEGRATION_USER_ID &&
    crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), Buffer.from(hash, 'hex'));
  if (!ok) {
    recordAuthFailure(ip, t, L.authWindowMs);
    return c.json({ error: 'unauthorized' }, 401);
  }
  c.set('keyId', hash.slice(0, 12));
  const perMin = c.req.method === 'GET' ? L.getPerMin : L.postPerMin;
  const used = (db.prepare('SELECT COUNT(*) n FROM grok_audit WHERE method=? AND at>?').get(c.req.method, t - 60_000) as any).n;
  if (used >= perMin) return respond(c, 429, { error: 'rate limited' }, { reason: 'rate limited' });
  await next();
});

async function readBody(request: Request): Promise<any> {
  const len = Number(request.headers.get('content-length') ?? 0);
  if (len > MAX_BODY) throw new Error('large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('json');
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) { await reader.cancel(); throw new Error('large'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('json'); }
}

/** Free text from Grok Bot cannot open a line with a bracketed tag or close the brief fence (see loop.ts). */
export const neutralise = (s: string) => s.replace(/^(\s*)\[/gm, '$1\\[').replace(/GROK_BRIEF/g, 'GROK-BRIEF');

const thread = (j: { bot_id: string; generation: number }) => `hq-${j.bot_id}-g${j.generation}`;

grokApi.post('/jobs', async (c) => {
  if (!grokIndexOk) return respond(c, 503, { error: 'bridge disabled until duplicate sourceRefs are reconciled' }, { reason: 'index missing' });
  let b: any;
  try { b = await readBody(c.req.raw); } catch (e) {
    const large = (e as Error).message === 'large';
    return respond(c, large ? 413 : 400, { error: 'invalid body' }, { reason: large ? 'body too large' : 'invalid json' });
  }
  const { botId, title, brief, sourceRef } = b ?? {};
  if (![botId, title, brief, sourceRef].every((v) => typeof v === 'string' && v.trim().length > 0) || title.length > 200 || brief.length > 20_000 || sourceRef.length > 500 || botId.length > 200) {
    return respond(c, 400, { error: 'invalid job' }, { botId: typeof botId === 'string' ? botId : null, reason: 'invalid job' });
  }
  const n = { botId, title: title.trim(), brief: brief.trim(), sourceRef: sourceRef.trim() };
  const f = { botId, sourceRef: n.sourceRef };
  const hash = crypto.createHash('sha256').update(JSON.stringify(n)).digest('hex');
  const userId = process.env.GROK_INTEGRATION_USER_ID!;
  const existing = db.prepare('SELECT * FROM grok_jobs WHERE user_id=? AND source_ref=?').get(userId, n.sourceRef) as any;
  if (existing) {
    if (existing.payload_hash !== hash) return respond(c, 409, { error: 'sourceRef conflict' }, { ...f, jobId: existing.id, reason: 'sourceRef conflict' });
    return respond(c, 200, { jobId: existing.id, threadId: thread(existing), status: existing.status, replayed: true }, { ...f, jobId: existing.id, reason: 'replay' });
  }
  if (!allowedBots().has(botId)) return respond(c, 403, { error: 'bot not allowed' }, { ...f, reason: 'bot not on allowlist' });
  const bot = getBotRow(botId);
  if (!bot || bot.user_id !== userId || bot.kind === 'team' || bot.hidden) return respond(c, 404, { error: 'bot not found' }, { ...f, reason: 'bot not found' });
  const L = limits();
  const id = crypto.randomUUID();
  const text = `${neutralise(n.title)}\n\n${neutralise(n.brief)}\n\nSource: ${neutralise(n.sourceRef)}`;
  // Caps are checked and the job written in one synchronous transaction, so concurrent requests cannot overshoot.
  const verdict = db.transaction(() => {
    const open = (db.prepare(`SELECT COUNT(*) n FROM grok_jobs WHERE bot_id=? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`).get(botId, ...OPEN_STATUSES) as any).n;
    if (open >= L.openPerBot) return 'bot queue full';
    const today = (db.prepare('SELECT COUNT(*) n FROM grok_audit WHERE status=202 AND at>?').get(now() - 86_400_000) as any).n;
    if (today >= L.perDay) return 'daily cap reached';
    db.prepare('INSERT INTO grok_jobs(id,user_id,bot_id,generation,title,source_ref,status,created_at,pending_text,payload_hash) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, userId, botId, bot.generation, n.title, n.sourceRef, 'queued', now(), text, hash);
    appendRow(botId, 'message', { type: 'message', role: 'user', text, from: { kind: 'bot', id: 'grok-bot', name: 'Grok Bot' } });
    audit(c, 202, { ...f, jobId: id, reason: 'accepted' });
    return null;
  })();
  if (verdict) return respond(c, 429, { error: verdict }, { ...f, reason: verdict });
  dispatchJob({ id, bot_id: botId, pending_text: text });
  return c.json({ jobId: id, threadId: thread({ bot_id: botId, generation: bot.generation }) }, 202);
});

grokApi.get('/jobs/:id', (c) => {
  const j = db.prepare('SELECT * FROM grok_jobs WHERE id=? AND user_id=?').get(c.req.param('id'), process.env.GROK_INTEGRATION_USER_ID) as any;
  if (!j) return respond(c, 404, { error: 'not found' }, { reason: 'not found' });
  const live = getLive(j.bot_id);
  const mine = live.grokJobId === j.id;
  return respond(c, 200, {
    jobId: j.id, threadId: thread(j), botId: j.bot_id, title: j.title, sourceRef: j.source_ref, status: j.status,
    elapsedMs: j.started_at ? (j.finished_at ?? now()) - j.started_at : 0, stepCount: mine ? (live.steps ?? 0) : j.steps,
    lastStep: j.last_step, finalReply: j.final_reply, endReason: j.end_reason ?? null, question: mine ? live.question ?? null : null,
  }, { botId: j.bot_id, jobId: j.id });
});

grokApi.post('/jobs/:id/reply', async (c) => {
  let b: any;
  try { b = await readBody(c.req.raw); } catch (e) {
    const large = (e as Error).message === 'large';
    return respond(c, large ? 413 : 400, { error: 'invalid body' }, { reason: large ? 'body too large' : 'invalid json' });
  }
  const j = db.prepare('SELECT * FROM grok_jobs WHERE id=? AND user_id=?').get(c.req.param('id'), process.env.GROK_INTEGRATION_USER_ID) as any;
  if (!j) return respond(c, 404, { error: 'not found' }, { reason: 'not found' });
  const f = { botId: j.bot_id, sourceRef: j.source_ref, jobId: j.id };
  if (typeof b?.answer !== 'string' || !b.answer.trim() || b.answer.length > 4000) return respond(c, 400, { error: 'invalid answer' }, { ...f, reason: 'invalid answer' });
  const today = (db.prepare('SELECT COUNT(*) n FROM grok_audit WHERE status=202 AND at>?').get(now() - 86_400_000) as any).n;
  if (today >= limits().perDay) return respond(c, 429, { error: 'daily cap reached' }, { ...f, reason: 'daily cap reached' });
  const row = j.question_seq ? getRow(j.bot_id, j.question_seq) : null;
  if (!jobForQuestion(j.bot_id, j.question_seq) || row?.body.type !== 'card' || row.body.card !== 'question' || row.body.status !== 'pending') {
    return respond(c, 409, { error: 'no pending question' }, { ...f, reason: 'no pending question' });
  }
  const answer = neutralise(b.answer.trim());
  appendRow(j.bot_id, 'message', { type: 'message', role: 'user', text: answer, from: { kind: 'bot', id: 'grok-bot', name: 'Grok Bot' } });
  if (!resumeBridgeJob(j.bot_id, j.question_seq, answer)) return respond(c, 409, { error: 'no pending question' }, { ...f, reason: 'lost race' });
  return respond(c, 202, { jobId: j.id, status: 'queued' }, { ...f, reason: 'reply accepted' });
});

/** The bridge's own listener. Off unless GROK_BRIDGE_PORT is set; host defaults to 127.0.0.1 (see grok-guard.ts). */
export function startGrokBridge() {
  const port = Number(process.env.GROK_BRIDGE_PORT);
  if (!port) { console.log('[grok bridge] listener off (GROK_BRIDGE_PORT unset)'); return null; }
  const host = process.env.GROK_BRIDGE_HOST || '127.0.0.1';
  const root = new Hono();
  root.route('/api/integrations/grok', grokApi);
  root.all('*', (c) => c.json({ error: 'not found' }, 404));
  return serve({ fetch: root.fetch, port, hostname: host }, (info) => console.log(`[grok bridge] listening on ${host}:${info.port}`));
}
