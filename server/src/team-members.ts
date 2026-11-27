import type Database from 'better-sqlite3';

/**
 * Workspace members: people who sign in with their own Google account but work in someone else's workspace.
 *
 * Bot HQ scopes everything (bots, chats, tasks, projects, connected apps, the computer) by a user id. A member's
 * session simply carries the workspace owner's id (see lib/auth.ts), so every existing query shares the owner's
 * data with no other change; the member's own id is kept as `actorId` to say who typed what.
 *
 * When someone joins, what they had made on their own (their bots, people, tasks, projects) moves into the
 * workspace, and their per-account leftovers (their own computer row, app-connection session, policies) are
 * dropped, since the workspace's are used from now on. Leaving only removes the membership: the work they did
 * stays in the workspace.
 */

export class TeamError extends Error {}

/** Tables whose rows follow a person into the workspace (`user_id` re-pointed). */
const MOVE = ['bots', 'screens', 'humans', 'revopt_tasks', 'projects', 'spaces', 'grok_jobs'];
/** Per-account rows the member no longer uses once they share the workspace's. */
const DROP = ['computers', 'composio_sessions', 'proactivity', 'policies'];

export function initTeamMembers(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_members (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL
  )`);
}

/** The workspace a person works in: the one they are a member of, else their own. */
export function workspaceOf(db: Database.Database, userId: string): string {
  const r = db.prepare('SELECT workspace_id FROM workspace_members WHERE user_id=?').get(userId) as any;
  return r?.workspace_id ?? userId;
}

export interface Member { id: string; email: string; name: string; addedAt: number }

export function listMembers(db: Database.Database, workspaceId: string): Member[] {
  return (db.prepare('SELECT u.id, u.email, u.name, m.added_at FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.added_at').all(workspaceId) as any[])
    .map((r) => ({ id: r.id, email: r.email, name: r.name, addedAt: r.added_at }));
}

const tableHas = (db: Database.Database, table: string, col: string) =>
  (db.prepare('SELECT COUNT(*) n FROM pragma_table_info(?) WHERE name=?').get(table, col) as any).n > 0;

/** The most workspaces one account may hold (spaces.ts SPACE_LIMITS, repeated so this module stays database-only). */
const MAX_SPACES = 50;

/** Before a newcomer's workspaces move across: refuses past the limit and renames any whose name is already used. */
function mergeSpaceNames(db: Database.Database, ownerId: string, memberId: string) {
  const names = (id: string) => db.prepare('SELECT id, name FROM spaces WHERE user_id=? ORDER BY created_at').all(id) as { id: string; name: string }[];
  const mine = names(ownerId);
  const theirs = names(memberId);
  if (mine.length + theirs.length > MAX_SPACES) throw new TeamError(`Together you would have more than ${MAX_SPACES} workspaces. Delete some empty ones first.`);
  const used = new Set(mine.map((s) => s.name.toLowerCase()));
  const all = new Set([...used, ...theirs.map((s) => s.name.toLowerCase())]);
  for (const s of theirs) {
    if (!used.has(s.name.toLowerCase())) { used.add(s.name.toLowerCase()); continue; }
    let name = s.name;
    for (let i = 2; all.has(name.toLowerCase()); i++) name = `${s.name.slice(0, 54)} ${i}`;
    db.prepare('UPDATE spaces SET name=? WHERE id=?').run(name, s.id);
    used.add(name.toLowerCase());
    all.add(name.toLowerCase());
  }
}

/**
 * Brings the person with this email into `workspaceId`. They must have signed in once (so they have an account)
 * and must not already be in a workspace or have members of their own. Returns the new member and how many of
 * their bots moved across.
 */
export function addMember(db: Database.Database, workspaceId: string, email: string, ts = Date.now()): { member: Member; botsMoved: number } {
  const clean = String(email ?? '').trim().toLowerCase();
  if (!clean.includes('@')) throw new TeamError('Enter their email address.');
  const u = db.prepare('SELECT id, email, name FROM users WHERE lower(email)=?').get(clean) as any;
  if (!u) throw new TeamError('They need to sign in to Bot HQ once first (their email must be on the allowed list).');
  if (u.id === workspaceId) throw new TeamError('That is you.');
  if (workspaceOf(db, workspaceId) !== workspaceId) throw new TeamError('Only the workspace owner can add people.');
  if (workspaceOf(db, u.id) !== u.id) throw new TeamError('They are already part of a workspace.');
  if (listMembers(db, u.id).length) throw new TeamError('They have members of their own.');

  let botsMoved = 0;
  db.transaction(() => {
    if (tableHas(db, 'spaces', 'user_id')) mergeSpaceNames(db, workspaceId, u.id);
    for (const t of MOVE) {
      if (!tableHas(db, t, 'user_id')) continue;
      const r = db.prepare(`UPDATE ${t} SET user_id=? WHERE user_id=?`).run(workspaceId, u.id);
      if (t === 'bots') botsMoved = r.changes;
    }
    // The workspace already has a main point of contact; the newcomer's main bot becomes a regular teammate.
    if (tableHas(db, 'bots', 'is_primary')) {
      const primaries = db.prepare('SELECT id FROM bots WHERE user_id=? AND is_primary=1 ORDER BY created_at').all(workspaceId) as any[];
      for (const p of primaries.slice(1)) db.prepare('UPDATE bots SET is_primary=0 WHERE id=?').run(p.id);
    }
    for (const t of DROP) if (tableHas(db, t, 'user_id')) db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(u.id);
    db.prepare('INSERT INTO workspace_members(user_id, workspace_id, added_at) VALUES (?,?,?)').run(u.id, workspaceId, ts);
  })();
  return { member: { id: u.id, email: u.email, name: u.name, addedAt: ts }, botsMoved };
}

/** Takes a member out of the workspace. What they made stays here; they go back to a workspace of their own. */
export function removeMember(db: Database.Database, workspaceId: string, memberId: string): boolean {
  return db.prepare('DELETE FROM workspace_members WHERE user_id=? AND workspace_id=?').run(memberId, workspaceId).changes > 0;
}
