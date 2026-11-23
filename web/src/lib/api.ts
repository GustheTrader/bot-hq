import type { RevOpsMetrics } from '@shared/revops-metrics';
import type { Bot, ComputerState, LiveState, RevOptKind, RevOptPriority, RevOptStatus, RevOptTask, Routine, Row, TeamBrief, TeamMember, TeamRole, Toolkit, User } from '@shared/types';export type { RevOptKind, RevOptPriority, RevOptStatus, RevOptTask } from '@shared/types';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface AppsResponse { apps: Toolkit[]; connected: string[]; categories: string[]; total: number }


export interface Human { id: string; name: string; email: string | null; createdAt: number }
export interface TeamsResponse { teams: { id: string; name: string; label: string; description: string; members: TeamMember[]; brief: TeamBrief }[]; humans: Human[] }

export interface RevOptTeam { id: string; name: string; label: string; members: number; counts: Record<RevOptStatus, number>; total: number }
export interface RevOptConfig { teams: RevOptTeam[]; kinds: RevOptKind[]; statuses: RevOptStatus[]; priorities: RevOptPriority[]; macroUrl: string | null }
export const api = {
  me: () => req<{ user: User | null; devLogin: boolean }>('GET', '/auth/me'),
  devLogin: (email: string, name?: string) => req<{ ok: true }>('POST', '/auth/dev', { email, name }),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),

  bots: () => req<{ bots: Bot[]; live: LiveState[] }>('GET', '/bots'),
  createBot: (b: Pick<Bot, 'name' | 'avatarShape' | 'avatarColor' | 'avatarImage' | 'mode'>) => req<{ bot: Bot }>('POST', '/bots', b),
  markRead: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/read`),
  rows: (id: string) => req<{ generation: number; rows: Row[] }>('GET', `/bots/${id}/rows`),
  send: (id: string, text: string) => req<{ row: Row }>('POST', `/bots/${id}/messages`, { text }),
  interrupt: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/interrupt`),
  fresh: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/fresh`),

  approve: (approvalId: string, decision: 'allow' | 'always' | 'deny') => req<{ ok: true }>('POST', `/approvals/${approvalId}`, { decision }),
  answer: (id: string, seq: number, answer: string) => req<{ ok: true }>('POST', `/bots/${id}/cards/${seq}/answer`, { answer }),
  dismiss: (id: string, seq: number) => req<{ ok: true }>('POST', `/bots/${id}/cards/${seq}/dismiss`),

  routines: (id: string) => req<{ routines: Routine[] }>('GET', `/bots/${id}/routines`),
  setRoutine: (rid: string, enabled: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${rid}`, { enabled }),

  computer: () => req<{ computer: ComputerState }>('GET', '/computer'),
  screenUrl: (id: string) => req<{ url: string | null }>('GET', `/bots/${id}/screen-url`),
  ensureComputer: () => req<{ computer: ComputerState }>('POST', '/computer/ensure'),

  apps: (search = '', category = '') => req<AppsResponse>('GET', `/apps?search=${encodeURIComponent(search)}&category=${encodeURIComponent(category)}`),
  connect: (slug: string, botId?: string, seq?: number) => req<{ redirectUrl: string }>('POST', `/apps/${slug}/connect`, { botId, seq }),
  disconnect: (slug: string) => req<{ ok: true }>('DELETE', `/apps/${slug}`),

  teamMembers: (id: string) => req<{ members: TeamMember[] }>('GET', `/rooms/${id}/members`),
  setTeamRoster: (id: string, botIds: string[], humanIds: string[]) => req<{ ok: true; members: TeamMember[] }>('PUT', `/rooms/${id}/members`, { botIds, humanIds }),
  setTeamLead: (id: string, memberId: string | null) => req<{ ok: true; members: TeamMember[] }>('POST', `/rooms/${id}/lead`, { memberId }),
  createTeam: (name: string, botIds: string[], humanIds: string[] = [], people: { name: string; email?: string }[] = []) =>
    req<{ id: string }>('POST', '/rooms', { name, botIds, humanIds, people }),
  /** Create a team and its people in one go. People may be new (by name) or existing (by id). */
  createTeamWithPeople: (name: string, botIds: string[], people: { id?: string; name: string; email?: string }[]) =>
    req<{ id: string }>('POST', '/rooms', { name, botIds, people }),
  teams: () => req<TeamsResponse>('GET', '/rooms'),
  teamBrief: (id: string) => req<TeamBrief>('GET', `/rooms/${id}/brief`),
  setTeamBrief: (id: string, text: string) => req<TeamBrief>('PUT', `/rooms/${id}/brief`, { text }),
  setTeamRole: (id: string, kind: 'bot' | 'human' | 'user', memberId: string, role: TeamRole) =>
    req<{ ok: true; members: TeamMember[] }>('POST', `/rooms/${id}/role`, { kind, id: memberId, role }),
  addHuman: (name: string, email?: string) => req<{ id: string }>('POST', '/rooms/humans', { name, email }),
  removeHuman: (id: string) => req<{ ok: true }>('DELETE', `/rooms/humans/${id}`),
  revoptConfig: () => req<RevOptConfig>('GET', '/revopt/summary'),
  revoptTasks: (q: { team?: string; status?: string; kind?: string } = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
    const s = p.toString();
    return req<{ tasks: RevOptTask[] }>('GET', `/revopt/tasks${s ? `?${s}` : ''}`);
  },
  createRevoptTask: (t: { teamId: string; kind?: RevOptKind; title: string; detail?: string; target?: string; priority?: RevOptPriority; payload?: Record<string, unknown>; dueAt?: number | null }) =>
    req<{ id: string }>('POST', '/revopt/tasks', t),
  updateRevoptTask: (id: string, patch: { status?: RevOptStatus; priority?: RevOptPriority; title?: string; detail?: string; target?: string; payload?: Record<string, unknown> }) =>
    req<{ ok: true; task: RevOptTask }>('PATCH', `/revopt/tasks/${id}`, patch),
  deleteRevoptTask: (id: string) => req<{ ok: true }>('DELETE', `/revopt/tasks/${id}`),
  revoptBuildflowJob: (number: string) => req<BuildflowJobSummary>('GET', `/revopt/buildflow/jobs/${encodeURIComponent(number)}`),
  dispatchRevoptTask: (id: string) => req<{ ok: true; prompt: string; teamId: string }>('POST', `/revopt/tasks/${id}/dispatch`),
  /** RevOps dashboard numbers for the last `days`. */
  revoptMetrics: (days = 30) => req<RevOpsMetrics>('GET', `/revopt/metrics?days=${days}`),
  memoryBanks: () => req<{ banks: { id: string; facts: number; lastWriteAt: string | null }[] }>('GET', '/revopt/memory/banks'),
  memoryGraph: (bank: string, limit = 150) => req<MemoryGraph>('GET', `/revopt/memory/graph?bank=${encodeURIComponent(bank)}&limit=${limit}`),
  biStatus: () => req<{ configured: boolean; publicUrl: string | null; dashboards: BiDashboard[] }>('GET', '/revopt/bi'),
  biEnableEmbed: (id: number) => req<{ embedId: string }>('POST', `/revopt/bi/dashboards/${id}/embed`),
  biGuestToken: (embedId: string) => req<{ token: string }>('POST', '/revopt/bi/guest-token', { embedId }),
  memoryEntity: (bank: string, id: string) => req<MemoryEntity>('GET', `/revopt/memory/entities/${encodeURIComponent(id)}?bank=${encodeURIComponent(bank)}`),
};

/** A Superset dashboard; `embedId` is set once embedding is turned on for it. */
export interface BiDashboard { id: number; title: string; embedId: string | null; url: string; changedAt: string | null }

export interface MemoryGraph {
  bank: string;
  nodes: { id: string; label: string; mentions: number }[];
  edges: { source: string; target: string; weight: number; lastAt: string | null }[];
  totalEntities: number;
  totalEdges: number;
  stats: { facts: number; links: number; documents: number; byType: Record<string, number> } | null;
}
export interface MemoryEntity {
  entity: { id: string; name: string; mentions: number; firstSeen: string | null; lastSeen: string | null };
  facts: { id: string; text: string; type: string; date: string | null }[];
}

/** Open a Composio redirect in a centered popup. */
export function openPopup(url: string) {
  const w = 520, h = 680;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;
  return window.open(url, 'grokbot-connect', `width=${w},height=${h},left=${left},top=${top}`);
}

/** A Build-flow job at a glance (Build-flow's /jobs/:id/summary). */
export interface BuildflowJobSummary {
  job: { id: string; number: string; name: string; client?: string; status: string };
  contract: { original: number; approvedChangeOrders: number; pendingChangeOrders: number; revised: number };
  schedule: { items: number; complete: number; progress: number; late: { id: string; title: string; endDate: string }[]; next: { id: string; title: string; startDate: string; endDate: string; status: string }[] };
  waitingOnClient: { changeOrders: { id: string; number: string; title: string; total: number }[]; selections: { id: string; title: string; dueDate?: string }[] };
  lastDailyLog: { date: string; author: string; workPerformed: string } | null;
}
