import { db, now } from './db.js';

/**
 * Three layers of memory in Hindsight (HINDSIGHT_URL, default http://127.0.0.1:8888), one bank each:
 *
 * - a bot's own bank, named after the bot's id (`bot_…`): what that one agent learned;
 * - a team's bank, named after the team's id (`team_…`): decisions and outcomes the team shares;
 * - `shared`: what every bot on the computer knows (Hermes' own memory provider writes here too).
 *
 * Who may use which bank is worked out from the roster, not stored a second time: a bot uses its
 * own bank, the banks of the teams it is on (read only when it is an observer there) and `shared`.
 * Every lookup is scoped to one account: another account's bots and teams are never in reach.
 * Hindsight's id rules match ours: bot and team ids are a prefix plus base64url, so they are valid
 * bank ids as they are.
 */

export const SHARED = 'shared';
const BANK_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const base = () => (process.env.HINDSIGHT_URL ?? 'http://127.0.0.1:8888').replace(/\/+$/, '');
/** The longest single memory a bot may save. Longer text is refused, not cut, so nothing is lost silently. */
export const MAX_MEMORY = 8000;

export type Layer = 'me' | 'team' | 'everyone';
export interface Bank { id: string; layer: Layer; label: string; writable: boolean; ownerId: string }

export class MemoryBankError extends Error {
  /** The HTTP status Hindsight answered with, when it answered at all. */
  constructor(message: string, readonly status?: number) { super(message); }
}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

const sharedBank = (): Bank => ({ id: SHARED, layer: 'everyone', label: 'Everyone (shared)', writable: true, ownerId: SHARED });

// ---------- who may use which bank ----------

/** The teams a bot is on (in its owner's account), with its role there. */
function teamsOf(userId: string, botId: string): { id: string; name: string; role: string }[] {
  return db.prepare(
    `SELECT t.id, t.name, tm.role FROM team_members tm JOIN bots t ON t.id = tm.team_id
     WHERE tm.member_kind = 'bot' AND tm.member_id = ? AND t.user_id = ? AND t.kind = 'team' ORDER BY t.created_at`,
  ).all(botId, userId) as { id: string; name: string; role: string }[];
}

/** Every bank this bot may read, in the order recall searches them (its own first). */
export function banksForBot(userId: string, botId: string): Bank[] {
  const bot = db.prepare("SELECT id, name FROM bots WHERE id=? AND user_id=? AND COALESCE(kind,'agent')<>'team'").get(botId, userId) as { id: string; name: string } | undefined;
  if (!bot) return [];
  const out: Bank[] = [];
  if (BANK_RE.test(bot.id)) out.push({ id: bot.id, layer: 'me', label: `${bot.name} (own)`, writable: true, ownerId: bot.id });
  for (const t of teamsOf(userId, botId)) {
    if (BANK_RE.test(t.id)) out.push({ id: t.id, layer: 'team', label: `Team ${t.name}`, writable: t.role !== 'observer', ownerId: t.id });
  }
  out.push(sharedBank());
  return out;
}

/** The banks a person may look at in the app: their bots', their teams' and `shared`. */
export function banksForUser(userId: string): { id: string; layer: Layer; label: string }[] {
  const rows = db.prepare("SELECT id, name, COALESCE(kind,'agent') kind FROM bots WHERE user_id=? AND COALESCE(hidden,0)=0 ORDER BY created_at").all(userId) as any[];
  const out: { id: string; layer: Layer; label: string }[] = [{ id: SHARED, layer: 'everyone', label: 'Everyone (shared)' }];
  for (const r of rows) {
    if (!BANK_RE.test(r.id)) continue;
    out.push(r.kind === 'team' ? { id: r.id, layer: 'team', label: `Team ${r.name}` } : { id: r.id, layer: 'me', label: r.name });
  }
  return out;
}

/** A team's own bank, for writes the app makes on the team's behalf (a finished RevOpt task). */
export function teamBank(userId: string, teamId: string): Bank | null {
  const t = db.prepare("SELECT id, name FROM bots WHERE id=? AND user_id=? AND kind='team'").get(teamId, userId) as { id: string; name: string } | undefined;
  return t && BANK_RE.test(t.id) ? { id: t.id, layer: 'team', label: `Team ${t.name}`, writable: true, ownerId: t.id } : null;
}

/** Whether a person may open this bank in the app. */
export function userMayView(userId: string, bankId: string): boolean {
  return banksForUser(userId).some((b) => b.id === bankId);
}

/** A bank in one account by id, as the app labels it (for writes the app makes, not on a bot's behalf). */
export function bankById(userId: string, bankId: string): Bank | null {
  if (bankId === SHARED) return sharedBank();
  const r = db.prepare("SELECT id, name, COALESCE(kind,'agent') kind FROM bots WHERE id=? AND user_id=?").get(bankId, userId) as any;
  if (!r || !BANK_RE.test(r.id)) return null;
  return r.kind === 'team'
    ? { id: r.id, layer: 'team', label: `Team ${r.name}`, writable: true, ownerId: r.id }
    : { id: r.id, layer: 'me', label: `${r.name} (own)`, writable: true, ownerId: r.id };
}

const teamName = (b: Bank) => b.label.slice(5);

/**
 * The banks one call works on. `layer` narrows to one layer; `team` picks a team by name (or by id,
 * when two teams share a name). Saving needs exactly one writable bank; recall takes every match.
 */
export function pickBanks(userId: string, botId: string, opts: { layer?: string; team?: string; write?: boolean }): Bank[] {
  const all = banksForBot(userId, botId);
  if (!all.length) throw new MemoryBankError('This bot has no memory banks.');
  const layer = opts.layer && opts.layer !== 'all' ? opts.layer : undefined;
  if (layer && !['me', 'team', 'everyone'].includes(layer)) throw new MemoryBankError('scope must be me, team, everyone or all.');
  let hits = layer ? all.filter((b) => b.layer === layer) : all;
  const team = opts.team?.trim();
  const teams = all.filter((b) => b.layer === 'team');
  const listTeams = (list: Bank[]) => list.map((b) => `${teamName(b)} (${b.id})`).join(', ') || 'none';
  if (team) {
    // A team only makes sense with scope team (or no scope): "everyone" plus a team is a contradiction, not a choice.
    if (layer && layer !== 'team') throw new MemoryBankError(`team goes with scope "team"; you asked for scope "${layer}". Drop one of them.`);
    hits = teams.filter((b) => b.id === team || teamName(b).toLowerCase() === team.toLowerCase());
    if (!hits.length) throw new MemoryBankError(`You are not on a team named "${team}". Your teams: ${listTeams(teams)}.`);
  }
  if (!opts.write) {
    if (!hits.length) throw new MemoryBankError(layer === 'team' ? 'You are not on any team.' : 'No memory bank matches.');
    return hits;
  }
  if (!layer && !team) hits = hits.filter((b) => b.layer === 'me'); // saving defaults to the bot's own bank
  if (hits.length > 1) {
    throw new MemoryBankError(team
      ? `More than one of your teams is named "${team}"; pass its id as team instead: ${listTeams(hits)}.`
      : `You are on several teams; say which one (by name, or by id if two share a name): ${listTeams(hits)}.`);
  }
  if (!hits.length) throw new MemoryBankError(layer === 'team' ? 'You are not on any team.' : 'No memory bank matches.');
  if (!hits[0].writable) throw new MemoryBankError(`You are an observer on ${hits[0].label}, so you can recall its memory but not add to it.`);
  return hits;
}

// ---------- talking to Hindsight ----------

async function call(path: string, method: string, body: unknown, fetchFn: Fetch, timeoutMs = 20_000): Promise<any> {
  let r;
  try {
    r = await fetchFn(`${base()}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new MemoryBankError('The memory store (Hindsight) is not answering on this computer.');
  }
  if (!r.ok) throw new MemoryBankError(`The memory store answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`, r.status);
  return r.json().catch(() => ({}));
}

/** Banks created (or confirmed) since this process started. `shared` is never touched: it is set up outside the app. */
const ready = new Set<string>([SHARED]);

function missionFor(bank: Bank): string {
  return bank.layer === 'team'
    ? `Shared memory of ${bank.label}: decisions, outcomes and facts the team's agents learned while working.`
    : `Memory of ${bank.label.replace(/ \(own\)$/, '')}, one AI agent on the team: what it learned while working.`;
}

export async function ensureBank(bank: Bank, fetchFn: Fetch = fetch as unknown as Fetch): Promise<void> {
  if (ready.has(bank.id)) return;
  // PUT creates the bank or updates its name and mission; both are cheap and idempotent.
  await call(`/v1/default/banks/${bank.id}`, 'PUT', { name: bank.label, mission: missionFor(bank) }, fetchFn);
  ready.add(bank.id);
}

export interface RetainMeta {
  by: string;
  context?: string;
  tags?: string[];
  /** Same id again replaces the earlier version (an edited Obsidian note, a re-finished task), instead of adding a second copy. */
  documentId?: string;
  /** Names the text is about, with their Hindsight type, so extraction files facts under the right entity. */
  entities?: { text: string; type?: string }[];
  /** The longest text accepted (default MAX_MEMORY). Longer text is refused. */
  maxChars?: number;
}

/** Saves one memory. Fact extraction runs in Hindsight's background, so this returns at once. */
export async function retain(bank: Bank, text: string, meta: RetainMeta, fetchFn: Fetch = fetch as unknown as Fetch) {
  const content = text.trim();
  const max = meta.maxChars ?? MAX_MEMORY;
  if (!content) throw new MemoryBankError('Nothing to remember.');
  if (content.length > max) throw new MemoryBankError(`That is ${content.length} characters; one memory holds at most ${max}. Split it into separate facts.`);
  await ensureBank(bank, fetchFn);
  const r = await call(`/v1/default/banks/${bank.id}/memories`, 'POST', {
    async: true,
    items: [{
      content,
      timestamp: new Date().toISOString(),
      context: meta.context ?? `Saved by ${meta.by}`,
      metadata: { by: meta.by, layer: bank.layer },
      tags: meta.tags?.length ? meta.tags : undefined,
      ...(meta.documentId ? { document_id: meta.documentId, update_mode: 'replace' } : {}),
      ...(meta.entities?.length ? { entities: meta.entities.slice(0, 30) } : {}),
    }],
  }, fetchFn);
  return { bank: bank.id, operationId: (r?.operation_id ?? r?.operation_ids?.[0] ?? null) as string | null };
}

/** Removes one document (and the facts drawn from it). Used only for documents the app itself wrote. */
export async function forgetDocument(bankId: string, documentId: string, fetchFn: Fetch = fetch as unknown as Fetch) {
  try {
    await call(`/v1/default/banks/${bankId}/documents/${encodeURIComponent(documentId)}`, 'DELETE', undefined, fetchFn);
  } catch (e) {
    if (!(e instanceof MemoryBankError && e.status === 404)) throw e; // already gone
  }
}

// ---------- saves the app makes on its own (they must not be lost to a brief outage) ----------

function initPending() {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_pending (
    document_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, bank TEXT NOT NULL, text TEXT NOT NULL, meta TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL
  )`);
}

/**
 * Saves a memory the app writes for itself (a finished task), keeping it until Hindsight takes it.
 * It needs a document id, so a retry or a later version replaces the earlier copy instead of adding one.
 */
export async function retainDurably(userId: string, bank: Bank, text: string, meta: RetainMeta & { documentId: string }, fetchFn?: Fetch) {
  initPending();
  db.prepare(`INSERT INTO memory_pending(document_id,user_id,bank,text,meta,attempts,last_error,updated_at) VALUES (?,?,?,?,?,0,NULL,?)
    ON CONFLICT(document_id) DO UPDATE SET user_id=excluded.user_id, bank=excluded.bank, text=excluded.text, meta=excluded.meta, attempts=0, last_error=NULL, updated_at=excluded.updated_at`)
    .run(meta.documentId, userId, bank.id, text, JSON.stringify(meta), now());
  await deliver(meta.documentId, fetchFn);
}

async function deliver(documentId: string, fetchFn?: Fetch): Promise<boolean> {
  const row = db.prepare('SELECT * FROM memory_pending WHERE document_id=?').get(documentId) as any;
  if (!row) return true;
  const bank = bankById(row.user_id, row.bank);
  if (!bank) { db.prepare('DELETE FROM memory_pending WHERE document_id=?').run(documentId); return false; } // the team is gone
  try {
    await retain(bank, row.text, JSON.parse(row.meta), fetchFn);
    db.prepare('DELETE FROM memory_pending WHERE document_id=? AND updated_at=?').run(documentId, row.updated_at);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Refused for good (too long, empty): keep retrying would never help.
    if (e instanceof MemoryBankError && e.status === undefined && !/not answering/.test(msg)) {
      db.prepare('DELETE FROM memory_pending WHERE document_id=?').run(documentId);
      console.warn(`[memory] dropped ${documentId}: ${msg}`);
      return false;
    }
    db.prepare('UPDATE memory_pending SET attempts=attempts+1, last_error=?, updated_at=? WHERE document_id=?').run(msg.slice(0, 300), now(), documentId);
    return false;
  }
}

/** Tries every waiting save again. Run on a timer by the server. */
export async function retryPending(fetchFn?: Fetch): Promise<{ delivered: number; waiting: number }> {
  initPending();
  let delivered = 0;
  for (const r of db.prepare('SELECT document_id FROM memory_pending ORDER BY updated_at').all() as any[]) if (await deliver(r.document_id, fetchFn)) delivered++;
  return { delivered, waiting: (db.prepare('SELECT COUNT(*) n FROM memory_pending').get() as any).n };
}

export function startMemoryRetry() {
  const t = setInterval(() => { retryPending().catch(() => {}); }, 10 * 60_000);
  t.unref();
}

// ---------- recall ----------

export interface Recalled { bank: string; label: string; text: string; when: string | null }

/**
 * Searches several banks at once. A bank that does not exist yet is simply empty; a bank that fails
 * is reported in `failed` while the others still answer. Throws only when every bank failed.
 */
export async function recall(banks: Bank[], query: string, fetchFn: Fetch = fetch as unknown as Fetch, perBank = 8): Promise<{ hits: Recalled[]; failed: Bank[] }> {
  const q = query.trim().slice(0, 1000);
  if (!q) throw new MemoryBankError('Say what to recall.');
  const settled = await Promise.allSettled(banks.map(async (b) => {
    try {
      const r = await call(`/v1/default/banks/${b.id}/memories/recall`, 'POST', { query: q, budget: 'mid', max_tokens: 2048 }, fetchFn);
      return ((r?.results ?? []) as any[]).slice(0, perBank).map((x) => ({
        bank: b.id, label: b.label, text: String(x?.text ?? '').slice(0, 1500), when: x?.occurred_start ?? x?.mentioned_at ?? null,
      })).filter((x) => x.text);
    } catch (e) {
      if (e instanceof MemoryBankError && e.status === 404) return [] as Recalled[]; // nobody has written to it yet
      throw e;
    }
  }));
  const failed = banks.filter((_b, i) => settled[i].status === 'rejected');
  if (failed.length === banks.length) throw (settled[0] as PromiseRejectedResult).reason;
  return { hits: settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : [])), failed };
}

/** Recall results as text for the agent: grouped by bank, with when each fact is from. */
export function formatRecall(res: { hits: Recalled[]; failed: Bank[] }, searched: Bank[]): string {
  const note = res.failed.length ? `\n(Could not search ${res.failed.map((b) => b.label).join(', ')} just now.)` : '';
  if (!res.hits.length) return `Nothing found in ${searched.filter((b) => !res.failed.includes(b)).map((b) => b.label).join(', ')}.${note}`;
  const out: string[] = [];
  for (const b of searched) {
    const mine = res.hits.filter((h) => h.bank === b.id);
    if (!mine.length) continue;
    out.push(`## ${b.label}`, ...mine.map((h) => `- ${h.text}${h.when ? ` (${String(h.when).slice(0, 10)})` : ''}`));
  }
  return out.join('\n') + note;
}
