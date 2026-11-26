import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import type { Space, SpaceKind } from './types.js';

/**
 * Workspaces ("spaces" in code, so they are not confused with the account or the folders on the computer):
 * one per business or project. Bots, teams and projects belong to at most one; those in none are "General".
 *
 * A workspace keeps its memory to itself: its bots use their own bank, their teams' banks and the
 * workspace's bank (named after its id) instead of the account-wide `shared` one (see memory-banks.ts).
 * App connections, Build-flow and the computer's files are still shared by every workspace.
 *
 * The primary bot stays in General and reaches every workspace: it is the person's coordinator.
 * This module only touches the database.
 */

export const SPACE_KINDS: readonly SpaceKind[] = ['business', 'project'];
export const SPACE_LIMITS = { spaces: 50, name: 60, description: 300 } as const;
const COLORS = ['blue', 'green', 'orange', 'violet', 'cyan', 'red', 'yellow', 'brown', 'gray'];

export class SpaceError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

const line = (s: unknown, max: number) =>
  // eslint-disable-next-line no-control-regex
  (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim() : '');

const toSpace = (r: any): Space => ({
  id: r.id, name: r.name, kind: r.kind, description: r.description, color: r.color,
  botCount: r.bot_count ?? 0, projectCount: r.project_count ?? 0, createdAt: r.created_at,
});

const SELECT = `SELECT s.*,
  (SELECT COUNT(*) FROM bots b WHERE b.space_id = s.id) AS bot_count,
  (SELECT COUNT(*) FROM projects p WHERE p.space_id = s.id) AS project_count
  FROM spaces s`;

export const listSpaces = (userId: string): Space[] =>
  (db.prepare(`${SELECT} WHERE s.user_id=? ORDER BY s.created_at, s.id`).all(userId) as any[]).map(toSpace);

export function getSpace(userId: string, id: string): Space | null {
  const r = db.prepare(`${SELECT} WHERE s.id=? AND s.user_id=?`).get(id, userId) as any;
  return r ? toSpace(r) : null;
}

/** A workspace id from a request: empty means General (null); anything else must be one of this account's. */
export function spaceIdFrom(userId: string, raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !getSpace(userId, raw)) throw new SpaceError('That workspace does not exist.', 404);
  return raw;
}

export interface SpaceInput { name?: unknown; kind?: unknown; description?: unknown; color?: unknown }

/** Names are unique per account and safe as folder names, because the Obsidian vault files notes under them. */
function checkName(userId: string, raw: unknown, ownId = ''): string {
  const name = line(raw, SPACE_LIMITS.name);
  if (!name) throw new SpaceError('A workspace needs a name.');
  if (/[\\/:*?"<>|#^[\]]/.test(name) || name.startsWith('.') || name.endsWith('.')) {
    throw new SpaceError('Leave out these characters from the name: \\ / : * ? " < > | # ^ [ ] and leading or trailing dots.');
  }
  const taken = listSpaces(userId).some((s) => s.id !== ownId && s.name.toLowerCase() === name.toLowerCase());
  if (taken || ['general', 'shared'].includes(name.toLowerCase())) throw new SpaceError('A workspace with that name already exists.', 409);
  return name;
}

function checkKind(raw: unknown): SpaceKind {
  if (!SPACE_KINDS.includes(raw as SpaceKind)) throw new SpaceError('A workspace is either a business or a project.');
  return raw as SpaceKind;
}

export function createSpace(userId: string, input: SpaceInput): Space {
  const name = checkName(userId, input.name);
  const kind = checkKind(input.kind ?? 'business');
  const count = listSpaces(userId).length;
  if (count >= SPACE_LIMITS.spaces) throw new SpaceError(`You can have up to ${SPACE_LIMITS.spaces} workspaces.`, 409);
  const color = COLORS.includes(input.color as string) ? (input.color as string) : COLORS[count % COLORS.length];
  const id = newId('spc');
  const t = now();
  db.prepare('INSERT INTO spaces(id,user_id,name,kind,description,color,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, userId, name, kind, line(input.description, SPACE_LIMITS.description), color, t, t);
  return getSpace(userId, id)!;
}

export function updateSpace(userId: string, id: string, patch: SpaceInput): Space {
  const cur = getSpace(userId, id);
  if (!cur) throw new SpaceError('That workspace does not exist.', 404);
  db.prepare('UPDATE spaces SET name=?, kind=?, description=?, color=?, updated_at=? WHERE id=?').run(
    patch.name !== undefined ? checkName(userId, patch.name, id) : cur.name,
    patch.kind !== undefined ? checkKind(patch.kind) : cur.kind,
    patch.description !== undefined ? line(patch.description, SPACE_LIMITS.description) : cur.description,
    patch.color !== undefined && COLORS.includes(patch.color as string) ? patch.color : cur.color,
    now(), id,
  );
  return getSpace(userId, id)!;
}

/** Only an empty workspace can go: moving its bots to General silently would change which memory they read. */
export function deleteSpace(userId: string, id: string): void {
  const s = getSpace(userId, id);
  if (!s) throw new SpaceError('That workspace does not exist.', 404);
  if (s.botCount || s.projectCount) throw new SpaceError('Move or delete its bots, teams and projects first.', 409);
  db.prepare('DELETE FROM spaces WHERE id=?').run(id);
}

// ---------- who can reach whom ----------

interface Placed { space_id?: string | null; is_primary?: number | boolean | null }

/** Whether one bot may message another or share a chat with it. The primary bot reaches everyone. */
export const canReach = (a: Placed, b: Placed) => !!a.is_primary || !!b.is_primary || (a.space_id ?? null) === (b.space_id ?? null);

/** Whether a bot may sit on a team of the given workspace. */
export const fitsSpace = (bot: Placed, spaceId: string | null | undefined) => !!bot.is_primary || (bot.space_id ?? null) === (spaceId ?? null);

/**
 * Moves a bot or a team to another workspace (null = General). A bot keeps its own memory, which goes with it.
 * Refused while a team would be left mixing workspaces, so the person decides who leaves which team.
 */
export function moveBot(userId: string, botId: string, raw: unknown): void {
  const target = spaceIdFrom(userId, raw);
  const bot = db.prepare('SELECT id, name, kind, space_id, is_primary FROM bots WHERE id=? AND user_id=?').get(botId, userId) as any;
  if (!bot) throw new SpaceError('Bot not found.', 404);
  if ((bot.space_id ?? null) === target) return;
  if (bot.is_primary) throw new SpaceError('Your main bot stays in General, so it can reach every workspace.', 409);
  if (bot.kind === 'team') {
    const members = db.prepare(
      "SELECT b.name, b.space_id, b.is_primary FROM team_members tm JOIN bots b ON b.id = tm.member_id WHERE tm.team_id=? AND tm.member_kind='bot'",
    ).all(botId) as any[];
    const outside = members.filter((m) => !fitsSpace(m, target)).map((m) => m.name);
    if (outside.length) throw new SpaceError(`Move ${outside.join(', ')} to that workspace first, or take them off this team.`, 409);
  } else {
    const teams = db.prepare(
      "SELECT t.name, t.space_id FROM team_members tm JOIN bots t ON t.id = tm.team_id WHERE tm.member_kind='bot' AND tm.member_id=?",
    ).all(botId) as any[];
    const outside = teams.filter((t) => (t.space_id ?? null) !== target).map((t) => t.name);
    if (outside.length) throw new SpaceError(`Take this bot off ${outside.join(', ')} first.`, 409);
  }
  // Its helpers (subagents) go with it, so they keep reading the same memory and can still report back.
  const helpers = (db.prepare('PRAGMA table_info(bots)').all() as { name: string }[]).some((c) => c.name === 'parent_bot_id');
  db.prepare(`UPDATE bots SET space_id=?, updated_at=? WHERE id=?${helpers ? ' OR parent_bot_id=?' : ''}`).run(target, now(), botId, ...(helpers ? [botId] : []));
}
