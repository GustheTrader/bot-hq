import { Hono } from 'hono';
import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { appendRow } from './store.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { enqueue } from './agent/loop.js';
import { teamMembers, teamBrief } from './agent/rooms.js';
import { env } from './env.js';
import type { RevOptKind, RevOptPriority, RevOptStatus, RevOptTask } from './types.js';
import { computeMetrics, type BotTaskRow, type QueueRow } from './revops-metrics.js';
import { MemoryGraphError, entityFacts, listBanks, memoryGraph } from './memory-graph.js';
import { SupersetError, enableEmbedding, guestToken, listDashboards, supersetConfig } from './superset.js';
import { bf, buildflowEnabled, jobBrief, jobByNumber, looksLikeJobNumber, type JobRef } from './buildflow.js';

/**
 * RevOpt Admin: the revenue-operations console. A CRM-shaped task catalog over a team.
 *
 * Each task belongs to a team (a bots row with kind='team'), so the roster that would work
 * it is already defined. "Dispatch" posts the task into the team channel as the user and
 * lets the lead start on it — the same path a typed message takes, so nothing here needs a
 * second agent loop.
 */
export const revoptApi = new Hono<AuthVars>();
revoptApi.use('*', requireUser);

const KINDS: RevOptKind[] = ['email', 'crm', 'other'];
const STATUSES: RevOptStatus[] = ['todo', 'running', 'review', 'done', 'blocked'];
const PRIORITIES: RevOptPriority[] = ['low', 'normal', 'high', 'urgent'];

interface TaskRow {
  id: string;
  user_id: string;
  team_id: string;
  kind: string;
  title: string;
  detail: string;
  target: string;
  status: string;
  priority: string;
  payload: string | null;
  row_seq: number | null;
  due_at: number | null;
  created_at: number;
  updated_at: number;
}

const ownTeam = (userId: string, id: string) =>
  db.prepare("SELECT id, name FROM bots WHERE id=? AND user_id=? AND kind='team'").get(id, userId) as
    | { id: string; name: string }
    | undefined;

function toTask(r: TaskRow): RevOptTask {
  let payload: Record<string, unknown> = {};
  try { payload = r.payload ? JSON.parse(r.payload) : {}; } catch { payload = {}; }
  return {
    id: r.id,
    teamId: r.team_id,
    teamName: (db.prepare('SELECT name FROM bots WHERE id=?').get(r.team_id) as any)?.name ?? '',
    botId: null,
    botName: null,
    kind: r.kind as RevOptKind,
    status: r.status as RevOptStatus,
    priority: r.priority as RevOptPriority,
    title: r.title,
    detail: r.detail,
    target: r.target,
    payload,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    dueAt: r.due_at,
    rowSeq: r.row_seq,
  };
}

/** Validate the mutable fields shared by create and patch. Returns a patch or an error string. */
function clean(body: {
  title?: string; detail?: string; target?: string | null; kind?: string; priority?: string;
}): { error: string } | { patch: Record<string, string> } {
  const out: Record<string, string> = {};
  if (body.title !== undefined) {
    const t = String(body.title).trim();
    if (!t) return { error: 'A task needs a title.' };
    out.title = t;
  }
  if (body.detail !== undefined) out.detail = String(body.detail).trim();
  if (body.target !== undefined) out.target = body.target ? String(body.target).trim() : '';
  if (body.kind !== undefined) {
    if (!KINDS.includes(body.kind as RevOptKind)) return { error: `kind must be one of ${KINDS.join(', ')}` };
    out.kind = body.kind;
  }
  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority as RevOptPriority)) return { error: `priority must be one of ${PRIORITIES.join(', ')}` };
    out.priority = body.priority;
  }
  return { patch: out };
}

/** The console summary: the teams a task can go to, per-status counts, and the config the UI needs. */
revoptApi.get('/summary', (c) => {
  const userId = c.get('user').id;
  const teams = (db.prepare("SELECT id, name, label FROM bots WHERE user_id=? AND kind='team' ORDER BY created_at").all(userId) as any[])
    .map((t) => {
      const counts: Record<RevOptStatus, number> = { todo: 0, running: 0, review: 0, done: 0, blocked: 0 };
      for (const row of db.prepare('SELECT status, COUNT(*) n FROM revopt_tasks WHERE team_id=? GROUP BY status').all(t.id) as any[]) {
        if (row.status in counts) counts[row.status as RevOptStatus] = row.n as number;
      }
      const total = STATUSES.reduce((s, k) => s + counts[k], 0);
      return { id: t.id, name: t.name, label: t.label, members: teamMembers(t.id).length, counts, total };
    });
  const byStatus: Record<RevOptStatus, number> = { todo: 0, running: 0, review: 0, done: 0, blocked: 0 };
  const byKind: Record<RevOptKind, number> = { email: 0, crm: 0, other: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) n FROM revopt_tasks WHERE user_id=? GROUP BY status').all(userId) as any[]) {
    if (row.status in byStatus) byStatus[row.status as RevOptStatus] = row.n as number;
  }
  for (const row of db.prepare('SELECT kind, COUNT(*) n FROM revopt_tasks WHERE user_id=? GROUP BY kind').all(userId) as any[]) {
    if (row.kind in byKind) byKind[row.kind as RevOptKind] = row.n as number;
  }
  const active = (db.prepare("SELECT id FROM revopt_tasks WHERE user_id=? AND status IN ('running','review') ORDER BY updated_at DESC LIMIT 12").all(userId) as any[])
    .map((r) => toTask(db.prepare('SELECT * FROM revopt_tasks WHERE id=?').get(r.id) as TaskRow));
  return c.json({
    total: STATUSES.reduce((s, k) => s + byStatus[k], 0),
    byStatus,
    byKind,
    active,
    teams,
    kinds: KINDS,
    statuses: STATUSES,
    priorities: PRIORITIES,
    /** The Macro desktop frontend, when it is reachable. The UI prefers embedding it in-console. */
    macroUrl: env.macroTeamUrl || null,
  });
});

/** List tasks, filtered by team / status / kind. Urgent and running float to the top. */
revoptApi.get('/tasks', (c) => {
  const userId = c.get('user').id;
  const where: string[] = ['user_id=?'];
  const args: unknown[] = [userId];
  for (const key of ['team', 'status', 'kind'] as const) {
    const v = c.req.query(key);
    if (!v) continue;
    where.push(key === 'team' ? 'team_id=?' : `${key}=?`);
    args.push(v);
  }
  const rows = db
    .prepare(`SELECT * FROM revopt_tasks WHERE ${where.join(' AND ')} ORDER BY
      CASE status WHEN 'running' THEN 0 WHEN 'review' THEN 1 WHEN 'todo' THEN 2 WHEN 'blocked' THEN 3 ELSE 4 END,
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      COALESCE(due_at, 9e15) ASC, created_at DESC`)
    .all(...args) as TaskRow[];
  return c.json({ tasks: rows.map(toTask) });
});

/**
 * Link a task to a Build-flow job when a job number is given: `payload.buildflowJobNumber` (the form's field),
 * or a target that is just a job number ("JOB-1001", "1001"). The job is looked up and kept as
 * `payload.buildflowJob` {number, id, name, client}. An unknown number is an error the person can fix; a target
 * that only looks like a number but matches no job is left alone. Returns the new payload, or an error.
 */
async function linkBuildflowJob(payload: Record<string, unknown>, target: string | undefined, actor: string): Promise<{ payload: Record<string, unknown> } | { error: string; status: 400 | 502 }> {
  const typed = typeof payload.buildflowJobNumber === 'string' ? payload.buildflowJobNumber.trim() : '';
  const { buildflowJobNumber: _drop, ...rest } = payload;
  if (typed === '' && 'buildflowJobNumber' in payload) return { payload: { ...rest, buildflowJob: undefined } }; // cleared
  const raw = typed || (target && looksLikeJobNumber(target) ? target : '');
  if (!raw) return { payload: rest };
  if (!buildflowEnabled()) return typed ? { error: 'Build-flow is not connected, so job numbers can’t be looked up.', status: 400 } : { payload: rest };
  try {
    const s = await jobByNumber(raw, actor);
    if (!s) return typed ? { error: `No job ${raw} in Build-flow.`, status: 400 } : { payload: rest };
    return { payload: { ...rest, buildflowJob: { number: s.job.number, id: s.job.id, name: s.job.name, client: s.job.client || undefined } } };
  } catch (e) {
    return typed ? { error: e instanceof Error ? e.message : 'Build-flow is not answering.', status: 502 } : { payload: rest };
  }
}

/** A Build-flow job at a glance, by number (the task form's preview). */
revoptApi.get('/buildflow/jobs/:number', async (c) => {
  if (!buildflowEnabled()) return c.json({ error: 'Build-flow is not connected.' }, 404);
  const u = c.get('user');
  try {
    const s = await jobByNumber(c.req.param('number'), `${u.name} <${u.email}>`);
    return s ? c.json(s) : c.json({ error: `No job ${c.req.param('number')} in Build-flow.` }, 404);
  } catch (e) { return c.json({ error: e instanceof Error ? e.message : 'Build-flow is not answering.' }, 502); }
});

/** Create a task. */
revoptApi.post('/tasks', async (c) => {
  const userId = c.get('user').id;
  const body = await c.req.json<{
    teamId?: string; kind?: string; title?: string; detail?: string; target?: string;
    priority?: string; status?: string; payload?: Record<string, unknown>; dueAt?: number | null;
  }>();
  if (!body.teamId || !ownTeam(userId, body.teamId)) return c.json({ error: 'Pick a team for this task.' }, 400);
  const cleaned = clean(body);
  if ('error' in cleaned) return c.json({ error: cleaned.error }, 400);
  if (body.status !== undefined && !STATUSES.includes(body.status as RevOptStatus)) {
    return c.json({ error: `status must be one of ${STATUSES.join(', ')}` }, 400);
  }
  const u = c.get('user');
  const linked = await linkBuildflowJob(body.payload ?? {}, cleaned.patch.target, `${u.name} <${u.email}>`);
  if ('error' in linked) return c.json({ error: linked.error }, linked.status);
  body.payload = linked.payload;
  const title = cleaned.patch.title ?? '';
  const id = newId('rev');
  const t = now();
  db.prepare(
    `INSERT INTO revopt_tasks(id,user_id,team_id,kind,title,detail,target,status,priority,payload,created_at,updated_at,due_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, userId, body.teamId,
    cleaned.patch.kind ?? 'email', title, cleaned.patch.detail ?? '', cleaned.patch.target ?? '',
    (body.status as string) ?? 'todo', cleaned.patch.priority ?? 'normal',
    JSON.stringify(body.payload ?? {}), t, t, body.dueAt ?? null,
  );
  return c.json({ id });
});

/** Update a task (status, priority, title, detail, target, payload, dueAt). */
revoptApi.patch('/tasks/:id', async (c) => {
  const userId = c.get('user').id;
  const id = c.req.param('id');
  const row = db.prepare('SELECT * FROM revopt_tasks WHERE id=? AND user_id=?').get(id, userId) as TaskRow | undefined;
  if (!row) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{
    status?: string; payload?: Record<string, unknown>; dueAt?: number | null;
    title?: string; detail?: string; target?: string | null; kind?: string; priority?: string;
  }>();
  const sets: string[] = [];
  const args: unknown[] = [];
  const cleaned = clean(body);
  if ('error' in cleaned) return c.json({ error: cleaned.error }, 400);
  for (const [k, v] of Object.entries(cleaned.patch)) { sets.push(`${k}=?`); args.push(v); }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status as RevOptStatus)) return c.json({ error: `status must be one of ${STATUSES.join(', ')}` }, 400);
    sets.push('status=?'); args.push(body.status);
  }
  // A new job number or a new target that is a job number re-links the task (keeping its other fields).
  const targetChanged = cleaned.patch.target !== undefined && cleaned.patch.target !== row.target;
  if (body.payload !== undefined || targetChanged) {
    // A payload sent without the job link keeps the task's existing link.
    const old = toTask(row).payload as Record<string, unknown>;
    const base = body.payload !== undefined ? { ...(old.buildflowJob ? { buildflowJob: old.buildflowJob } : {}), ...body.payload } : old;
    const u = c.get('user');
    const linked = await linkBuildflowJob(base, targetChanged ? (cleaned.patch.target as string) : undefined, `${u.name} <${u.email}>`);
    if ('error' in linked) return c.json({ error: linked.error }, linked.status);
    sets.push('payload=?'); args.push(JSON.stringify(linked.payload)); // JSON drops a cleared (undefined) link
  }
  if (body.dueAt !== undefined) { sets.push('due_at=?'); args.push(body.dueAt); }
  if (!sets.length) return c.json({ ok: true, task: toTask(row) });
  sets.push('updated_at=?'); args.push(now());
  args.push(id, userId);
  db.prepare(`UPDATE revopt_tasks SET ${sets.join(', ')} WHERE id=? AND user_id=?`).run(...args);
  const fresh = db.prepare('SELECT * FROM revopt_tasks WHERE id=?').get(id) as TaskRow;
  return c.json({ ok: true, task: toTask(fresh) });
});

/** Delete a task. */
revoptApi.delete('/tasks/:id', (c) => {
  const userId = c.get('user').id;
  const info = db.prepare('DELETE FROM revopt_tasks WHERE id=? AND user_id=?').run(c.req.param('id'), userId);
  if (!info.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

/**
 * Dispatch a task to its team: post it into the team channel as the user and let the lead
 * pick it up. Marks the task running and remembers the channel row so the console can jump to it.
 */
revoptApi.post('/tasks/:id/dispatch', async (c) => {
  const userId = c.get('user').id;
  const id = c.req.param('id');
  const row = db.prepare('SELECT * FROM revopt_tasks WHERE id=? AND user_id=?').get(id, userId) as TaskRow | undefined;
  if (!row) return c.json({ error: 'not found' }, 404);
  const team = ownTeam(userId, row.team_id);
  if (!team) return c.json({ error: 'That team is gone.' }, 400);
  const bots = teamMembers(team.id).filter((m) => m.kind === 'bot');
  if (!bots.length) return c.json({ error: 'This team has no Bots to work the task.' }, 400);

  // A task linked to a Build-flow job carries that job's current state into the brief.
  const task = toTask(row);
  const job = (task.payload as any).buildflowJob as JobRef | undefined;
  let jobText = '';
  if (job?.id && buildflowEnabled()) {
    try { jobText = jobBrief(await bf('GET', `/jobs/${encodeURIComponent(job.id)}/summary`, `${team.name} (team)`)); }
    catch { jobText = `Build-flow job ${job.number} "${job.name}" (job_id ${job.id}). Use the buildflow_job tool for its details.`; }
  }
  const prompt = taskPrompt(task, jobText);
  const posted = appendRow(team.id, 'message', { type: 'message', role: 'user', text: prompt });
  db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(team.id);
  const lead = bots.find((b) => b.role === 'lead') ?? bots[0];
  enqueue(lead.id, { type: 'system', text: prompt });

  db.prepare("UPDATE revopt_tasks SET status='running', row_seq=?, updated_at=? WHERE id=?").run(posted.seq, now(), id);
  return c.json({ ok: true, prompt, teamId: team.id, botId: lead.id, rowSeq: posted.seq });
});

/** The instruction posted to the team for a task. */
function taskPrompt(t: RevOptTask, jobText = ''): string {
  const brief = teamBrief(t.teamId).text;
  const { buildflowJob: _job, ...fields } = t.payload as Record<string, unknown>;
  const bits = [
    `[RevOpt task · ${t.kind} · ${t.priority}] ${t.title}`,
    t.target ? `Target: ${t.target}` : '',
    t.detail ? `Details: ${t.detail}` : '',
    jobText,
    Object.keys(fields).length ? `Fields: ${JSON.stringify(fields)}` : '',
    t.dueAt ? `Due: ${new Date(t.dueAt).toISOString()}` : '',
  ].filter(Boolean);
  return (
    `${bits.join('\n')}\n\n` +
    (brief ? `Team brief: ${brief}\n\n` : '') +
    `Work this from the ${t.teamName} team. Report back on the team channel and, when it is done, say so plainly.`
  );
}

// ---------- dashboard and memory graph ----------

/** Dashboard numbers for the last `days` (7–365): KPIs, daily throughput, and breakdowns by status, team and bot. */
revoptApi.get('/metrics', (c) => {
  const userId = c.get('user').id;
  const days = Math.min(365, Math.max(7, Number(c.req.query('days')) || 30));
  const queue = db.prepare('SELECT team_id, kind, status, priority, created_at, updated_at, due_at, NULL AS done_at FROM revopt_tasks WHERE user_id=?').all(userId) as QueueRow[];
  const botTasks = db.prepare('SELECT t.bot_id, t.state, t.created_at, t.updated_at FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE b.user_id=?').all(userId) as BotTaskRow[];
  const named = db.prepare('SELECT id, name, kind FROM bots WHERE user_id=?').all(userId) as { id: string; name: string; kind: string }[];
  const names = { teams: new Map(named.filter((b) => b.kind === 'team').map((b) => [b.id, b.name])), bots: new Map(named.map((b) => [b.id, b.name])) };
  return c.json(computeMetrics(queue, botTasks, names, now(), days));
});

const graphGuard = async (c: any, fn: () => Promise<Response>) => {
  try { return await fn(); } catch (e) {
    if (e instanceof MemoryGraphError) return c.json({ error: e.message }, e.status);
    throw e;
  }
};

/** The bots' shared memory (Hindsight) as an entity graph. */
revoptApi.get('/memory/banks', (c) => graphGuard(c, async () => c.json({ banks: await listBanks() })));
revoptApi.get('/memory/graph', (c) => graphGuard(c, async () => c.json(await memoryGraph(c.req.query('bank'), c.req.query('limit')))));
revoptApi.get('/memory/entities/:id', (c) => graphGuard(c, async () => c.json(await entityFacts(c.req.query('bank'), c.req.param('id')))));

// ---------- BI (Apache Superset, embedded) ----------

const biGuard = async (c: any, fn: () => Promise<Response>) => {
  try { return await fn(); } catch (e) {
    if (e instanceof SupersetError) return c.json({ error: e.message }, e.status);
    throw e;
  }
};
/** Origins allowed to frame an embedded dashboard: the web app and this server's own address. */
const embedOrigins = () => [...new Set([env.appUrl, env.serverUrl].map((u) => { try { return new URL(u).origin; } catch { return ''; } }).filter((o) => o.startsWith('https://')))];

/** Is Superset set up, its public address, and its dashboards (with embed ids). */
revoptApi.get('/bi', (c) => biGuard(c, async () => {
  const cfg = supersetConfig();
  if (!cfg) return c.json({ configured: false, publicUrl: null, dashboards: [] });
  return c.json({ configured: true, publicUrl: cfg.publicUrl, dashboards: await listDashboards(cfg) });
}));

/** Turns on embedding for one dashboard (framing allowed only from Bot HQ's own origins). */
revoptApi.post('/bi/dashboards/:id/embed', (c) => biGuard(c, async () => {
  const cfg = supersetConfig();
  if (!cfg) throw new SupersetError('Superset is not set up on this computer.', 409);
  return c.json({ embedId: await enableEmbedding(cfg, c.req.param('id'), embedOrigins()) });
}));

/** A short-lived, view-only guest token for one embedded dashboard. */
revoptApi.post('/bi/guest-token', (c) => biGuard(c, async () => {
  const cfg = supersetConfig();
  if (!cfg) throw new SupersetError('Superset is not set up on this computer.', 409);
  const { embedId } = ((await c.req.json().catch(() => ({}))) ?? {}) as { embedId?: string };
  const user = c.get('user');
  return c.json({ token: await guestToken(cfg, embedId, { id: user.id, name: user.name }) });
}));
