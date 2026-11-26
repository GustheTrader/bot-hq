import { db } from './db.js';

/**
 * Three layers of memory in Hindsight (HINDSIGHT_URL, default http://127.0.0.1:8888), one bank each:
 *
 * - a bot's own bank, named after the bot's id (`bot_…`): what that one agent learned;
 * - a team's bank, named after the team's id (`team_…`): decisions and outcomes the team shares;
 * - `shared`: what every bot on the computer knows (Hermes' own memory provider writes here too).
 *
 * Who may use which bank is worked out from the roster, not stored a second time: a bot uses its
 * own bank, the banks of the teams it is on (read only when it is an observer there) and `shared`.
 * Hindsight's id rules match ours: bot and team ids are a prefix plus base64url, so they are valid
 * bank ids as they are.
 */

export const SHARED = 'shared';
const BANK_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const base = () => (process.env.HINDSIGHT_URL ?? 'http://127.0.0.1:8888').replace(/\/+$/, '');

export type Layer = 'me' | 'team' | 'everyone';
export interface Bank { id: string; layer: Layer; label: string; writable: boolean; ownerId: string }

export class MemoryBankError extends Error {}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

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
  out.push({ id: SHARED, layer: 'everyone', label: 'Everyone (shared)', writable: true, ownerId: SHARED });
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

/**
 * The banks one call works on. `layer` narrows to one layer; `team` picks a team by name when the
 * bot is on several. Saving needs exactly one writable bank; recall takes every match.
 */
export function pickBanks(userId: string, botId: string, opts: { layer?: string; team?: string; write?: boolean }): Bank[] {
  const all = banksForBot(userId, botId);
  if (!all.length) throw new MemoryBankError('This bot has no memory banks.');
  const layer = opts.layer && opts.layer !== 'all' ? opts.layer : undefined;
  if (layer && !['me', 'team', 'everyone'].includes(layer)) throw new MemoryBankError('scope must be me, team, everyone or all.');
  let hits = layer ? all.filter((b) => b.layer === layer) : all;
  const team = opts.team?.trim().toLowerCase();
  if (team) {
    hits = hits.filter((b) => b.layer === 'team' && b.label.slice(5).toLowerCase() === team);
    if (!hits.length) throw new MemoryBankError(`You are not on a team named "${opts.team}". Your teams: ${all.filter((b) => b.layer === 'team').map((b) => b.label.slice(5)).join(', ') || 'none'}.`);
  }
  if (!opts.write) {
    if (!hits.length) throw new MemoryBankError(layer === 'team' ? 'You are not on any team.' : 'No memory bank matches.');
    return hits;
  }
  if (!layer && !team) hits = hits.filter((b) => b.layer === 'me'); // saving defaults to the bot's own bank
  if (hits.length > 1) throw new MemoryBankError(`You are on several teams; say which one: ${hits.map((b) => b.label.slice(5)).join(', ')}.`);
  if (!hits.length) throw new MemoryBankError(layer === 'team' ? 'You are not on any team.' : 'No memory bank matches.');
  if (!hits[0].writable) throw new MemoryBankError(`You are an observer on ${hits[0].label}, so you can recall its memory but not add to it.`);
  return hits;
}

// ---------- talking to Hindsight ----------

async function call(path: string, method: string, body: unknown, fetchFn: Fetch, timeoutMs = 20_000): Promise<any> {
  let r;
  try {
    r = await fetchFn(`${base()}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new MemoryBankError('The memory store (Hindsight) is not answering on this computer.');
  }
  if (!r.ok) throw new MemoryBankError(`The memory store answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
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

/** Saves one memory. Fact extraction runs in Hindsight's background, so this returns at once. */
export interface RetainMeta {
  by: string;
  context?: string;
  tags?: string[];
  /** Same id again replaces the earlier version (an edited Obsidian note), instead of adding a second copy. */
  documentId?: string;
  /** Names the text is about, with their Hindsight type, so extraction files facts under the right entity. */
  entities?: { text: string; type?: string }[];
  maxChars?: number;
}

export async function retain(bank: Bank, text: string, meta: RetainMeta, fetchFn: Fetch = fetch as unknown as Fetch) {
  const content = text.trim().slice(0, meta.maxChars ?? 8000);
  if (!content) throw new MemoryBankError('Nothing to remember.');
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
    if (!(e instanceof MemoryBankError && / 404/.test(e.message))) throw e; // already gone
  }
}

/** A bank by id, as the app labels it (for writes the app makes, not on a bot's behalf). */
export function bankById(bankId: string): Bank | null {
  if (bankId === SHARED) return { id: SHARED, layer: 'everyone', label: 'Everyone (shared)', writable: true, ownerId: SHARED };
  const r = db.prepare("SELECT id, name, COALESCE(kind,'agent') kind FROM bots WHERE id=?").get(bankId) as any;
  if (!r || !BANK_RE.test(r.id)) return null;
  return r.kind === 'team'
    ? { id: r.id, layer: 'team', label: `Team ${r.name}`, writable: true, ownerId: r.id }
    : { id: r.id, layer: 'me', label: `${r.name} (own)`, writable: true, ownerId: r.id };
}

export interface Recalled { bank: string; label: string; text: string; when: string | null }

/** Searches several banks at once. A bank that does not exist yet is simply empty. */
export async function recall(banks: Bank[], query: string, fetchFn: Fetch = fetch as unknown as Fetch, perBank = 8): Promise<Recalled[]> {
  const q = query.trim().slice(0, 1000);
  if (!q) throw new MemoryBankError('Say what to recall.');
  const lists = await Promise.all(banks.map(async (b) => {
    try {
      const r = await call(`/v1/default/banks/${b.id}/memories/recall`, 'POST', { query: q, budget: 'mid', max_tokens: 2048 }, fetchFn);
      return ((r?.results ?? []) as any[]).slice(0, perBank).map((x) => ({
        bank: b.id, label: b.label, text: String(x?.text ?? '').slice(0, 1500), when: x?.occurred_start ?? x?.mentioned_at ?? null,
      })).filter((x) => x.text);
    } catch (e) {
      // A bank nobody has written to yet answers 404; treat it as empty rather than failing the search.
      if (e instanceof MemoryBankError && / 404/.test(e.message)) return [];
      throw e;
    }
  }));
  return lists.flat();
}

/** Recall results as text for the agent: grouped by bank, newest note of when each fact is from. */
export function formatRecall(hits: Recalled[], searched: Bank[]): string {
  if (!hits.length) return `Nothing found in ${searched.map((b) => b.label).join(', ')}.`;
  const out: string[] = [];
  for (const b of searched) {
    const mine = hits.filter((h) => h.bank === b.id);
    if (!mine.length) continue;
    out.push(`## ${b.label}`, ...mine.map((h) => `- ${h.text}${h.when ? ` (${String(h.when).slice(0, 10)})` : ''}`));
  }
  return out.join('\n');
}
