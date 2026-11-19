/**
 * RevOps dashboard numbers, computed from the RevOpt queue (revopt_tasks) and the bots' own task lists (tasks).
 * Pure functions over plain rows, so they are easy to test; the route only selects the rows.
 */

export type Status = 'todo' | 'running' | 'review' | 'done' | 'blocked';
export interface QueueRow { team_id: string; kind: string; status: Status; priority: string; created_at: number; updated_at: number; due_at: number | null; done_at: number | null }
export interface BotTaskRow { bot_id: string; state: string; created_at: number; updated_at: number }

const DAY = 86_400_000;
const OPEN: Status[] = ['todo', 'running', 'review', 'blocked'];

/** Midnight UTC of the day `t` falls in, as a YYYY-MM-DD key. */
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

export interface RevOpsMetrics {
  days: number;
  kpis: { open: number; doneInPeriod: number; createdInPeriod: number; overdue: number; blocked: number; avgCycleHours: number | null; completionRate: number | null; botTasksOpen: number; botTasksDone: number };
  throughput: { day: string; created: number; done: number }[];
  byStatus: Record<Status, number>;
  byPriority: Record<string, number>;
  byKind: Record<string, number>;
  byTeam: { id: string; name: string; open: number; done: number; overdue: number }[];
  byBot: { id: string; name: string; working: number; waiting: number; done: number }[];
}

export function computeMetrics(
  queue: QueueRow[],
  botTasks: BotTaskRow[],
  names: { teams: Map<string, string>; bots: Map<string, string> },
  now: number,
  days = 30,
): RevOpsMetrics {
  const since = now - days * DAY;
  const byStatus: Record<Status, number> = { todo: 0, running: 0, review: 0, done: 0, blocked: 0 };
  const byPriority: Record<string, number> = { urgent: 0, high: 0, normal: 0, low: 0 };
  const byKind: Record<string, number> = {};
  const teams = new Map<string, { open: number; done: number; overdue: number }>();
  const series = new Map<string, { created: number; done: number }>();
  for (let t = since; t <= now; t += DAY) series.set(dayKey(t), { created: 0, done: 0 });
  series.set(dayKey(now), series.get(dayKey(now)) ?? { created: 0, done: 0 });

  let overdue = 0;
  let doneInPeriod = 0;
  let createdInPeriod = 0;
  let cycleSum = 0;
  let cycleN = 0;
  for (const r of queue) {
    if (r.status in byStatus) byStatus[r.status] += 1;
    const open = OPEN.includes(r.status);
    if (open) byPriority[r.priority] = (byPriority[r.priority] ?? 0) + 1;
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    const late = open && r.due_at !== null && r.due_at < now;
    if (late) overdue += 1;
    const team = teams.get(r.team_id) ?? { open: 0, done: 0, overdue: 0 };
    if (open) team.open += 1;
    if (late) team.overdue += 1;
    if (r.created_at >= since) {
      createdInPeriod += 1;
      const s = series.get(dayKey(r.created_at));
      if (s) s.created += 1;
    }
    const doneAt = r.status === 'done' ? (r.done_at ?? r.updated_at) : null;
    if (doneAt !== null && doneAt >= since) {
      doneInPeriod += 1;
      team.done += 1;
      const s = series.get(dayKey(doneAt));
      if (s) s.done += 1;
      cycleSum += Math.max(0, doneAt - r.created_at);
      cycleN += 1;
    }
    teams.set(r.team_id, team);
  }

  const bots = new Map<string, { working: number; waiting: number; done: number }>();
  let botTasksOpen = 0;
  let botTasksDone = 0;
  for (const t of botTasks) {
    const b = bots.get(t.bot_id) ?? { working: 0, waiting: 0, done: 0 };
    if (t.state === 'done') { if (t.updated_at >= since) { b.done += 1; botTasksDone += 1; } }
    else if (t.state === 'needs_input') { b.waiting += 1; botTasksOpen += 1; }
    else { b.working += 1; botTasksOpen += 1; }
    bots.set(t.bot_id, b);
  }

  const open = OPEN.reduce((s, k) => s + byStatus[k], 0);
  return {
    days,
    kpis: {
      open,
      doneInPeriod,
      createdInPeriod,
      overdue,
      blocked: byStatus.blocked,
      avgCycleHours: cycleN ? Math.round((cycleSum / cycleN / 3_600_000) * 10) / 10 : null,
      completionRate: createdInPeriod ? Math.round((doneInPeriod / createdInPeriod) * 100) : null,
      botTasksOpen,
      botTasksDone,
    },
    throughput: [...series.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, ...v })),
    byStatus,
    byPriority,
    byKind,
    byTeam: [...teams.entries()].map(([id, v]) => ({ id, name: names.teams.get(id) ?? id, ...v })).sort((a, b) => b.open - a.open || b.done - a.done),
    byBot: [...bots.entries()].map(([id, v]) => ({ id, name: names.bots.get(id) ?? id, ...v })).filter((b) => b.working + b.waiting + b.done > 0).sort((a, b) => (b.working + b.waiting) - (a.working + a.waiting) || b.done - a.done),
  };
}
