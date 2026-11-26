import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { initTeamMembers } from './team-members.js';

fs.mkdirSync(path.dirname(env.dbPath), { recursive: true });
export const db = new Database(env.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,
  provisional_user_id TEXT NOT NULL,
  connected_account_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS computers (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  orgo_id TEXT,
  status TEXT NOT NULL DEFAULT 'absent',
  error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS screens (
  bot_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  screen_id TEXT NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  avatar_shape TEXT NOT NULL DEFAULT 'blob',
  avatar_color TEXT NOT NULL DEFAULT 'blue',
  mode TEXT NOT NULL DEFAULT 'personal',
  is_primary INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  effort TEXT NOT NULL DEFAULT 'medium',
  generation INTEGER NOT NULL DEFAULT 1,
  next_seq INTEGER NOT NULL DEFAULT 1,
  rev INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rows (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, generation, seq)
);
CREATE INDEX IF NOT EXISTS rows_rev ON rows(bot_id, updated_seq);
CREATE TABLE IF NOT EXISTS llm_items (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  item TEXT NOT NULL,
  PRIMARY KEY (bot_id, generation, idx)
);
CREATE TABLE IF NOT EXISTS pending_turns (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  row_seq INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS policies (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  mode TEXT NOT NULL,
  PRIMARY KEY (user_id, tool)
);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'working',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS composio_sessions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL
);
`);

// Idempotent column migrations for tables that predate a column.
function addColumn(table: string, col: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
addColumn('bots', 'voice', "TEXT NOT NULL DEFAULT 'luna'");
addColumn('bots', 'avatar_image', 'TEXT');
addColumn('bots', 'voice_speed', 'REAL NOT NULL DEFAULT 1');
addColumn('bots', 'voice_language', "TEXT NOT NULL DEFAULT 'auto'");
// Hermes engine: per-bot model choice, which engine runs the bot ('primary' = the existing agent,
// 'managed' = a gateway we start), and the managed gateway's port.
addColumn('bots', 'model', 'TEXT');
addColumn('bots', 'provider', 'TEXT');
addColumn('bots', 'engine', 'TEXT');
addColumn('bots', 'engine_port', 'INTEGER');
addColumn('bots', 'handback_at', 'INTEGER');
addColumn('bots', 'harness', "TEXT NOT NULL DEFAULT 'hermes'");
addColumn('bots', 'harness_model', 'TEXT');
addColumn('screens', 'width', 'INTEGER');
addColumn('screens', 'height', 'INTEGER');
// A team's standing brief: prepended to every member's context on each turn.
addColumn('bots', 'brief', 'TEXT');
addColumn('bots', 'brief_updated_at', 'INTEGER');

db.exec(`
CREATE TABLE IF NOT EXISTS humans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL
);

-- Membership for teams. A team is a bots row with kind='team'; members may be bots or humans.
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  member_kind TEXT NOT NULL,
  member_id TEXT NOT NULL,
  -- 'lead' speaks first, 'member' answers when addressed, 'observer' stays silent unless
  -- mentioned by name. Observers are read-only eyes on the team (a monitor bot, a person
  -- who is only watching). Kept as TEXT, not a CHECK, so older rows survive schema drift.
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, member_kind, member_id)
);
CREATE INDEX IF NOT EXISTS team_members_member ON team_members(member_kind, member_id);
`);
// RevOpt Admin: the revenue-operations console. A task is owned by a team, mixes a kind of
// work (email | crm | other) with a status a person triages, and carries an arbitrary payload
// (subject, threadId, dealStage, amountCents, ...). Kept apart from `tasks` (which belongs to
// a single bot) because a RevOpt task is dispatched to a whole team channel.
db.exec(`
CREATE TABLE IF NOT EXISTS revopt_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  -- 'email' | 'crm' | 'other'
  kind TEXT NOT NULL DEFAULT 'email',
  title TEXT NOT NULL,
  -- Free-text instruction the team reads; the task's brief.
  detail TEXT NOT NULL DEFAULT '',
  -- Who this touches: an email address, a domain, a person, a CRM record id.
  target TEXT NOT NULL DEFAULT '',
  -- 'todo' | 'running' | 'review' | 'done' | 'blocked'
  status TEXT NOT NULL DEFAULT 'todo',
  -- 'low' | 'normal' | 'high' | 'urgent'
  priority TEXT NOT NULL DEFAULT 'normal',
  payload TEXT NOT NULL DEFAULT '{}',
  -- The team-channel row this task dispatched, so the console can jump to the work.
  row_seq INTEGER,
  due_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS revopt_tasks_team ON revopt_tasks(team_id, status);
CREATE INDEX IF NOT EXISTS revopt_tasks_user ON revopt_tasks(user_id, created_at);
`);
// Projects: named pieces of ongoing work. A project carries standing notes, a default engine (harness and
// model) and its own skills; any bot can be pointed at one to start work with that context.
db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- Advisory path on the bot's computer; told to the bot, never opened by the server.
  folder TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  harness TEXT NOT NULL DEFAULT 'hermes',
  harness_model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id, updated_at);
CREATE TABLE IF NOT EXISTS project_skills (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS project_skills_project ON project_skills(project_id, created_at);
`);

// Workspaces, one per business or project (spaces.ts). A bot, team or project with no space_id is "General".
db.exec(`
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'business',
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'blue',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS spaces_user ON spaces(user_id, created_at);
`);
addColumn('bots', 'space_id', 'TEXT');
addColumn('projects', 'space_id', 'TEXT');


// Legacy group chats were kind='room' with a JSON members list of bot ids. Promote them to
// teams (with team_members rows) once, then leave 'room' behind. Idempotent: the UPDATE only
// matches rows still marked 'room'.
// A database created before teams existed has no kind/members columns yet; the legacy migration
// below reads them, so add them here (initRooms does the same, idempotently).
for (const col of ["kind TEXT NOT NULL DEFAULT 'agent'", 'members TEXT']) {
  try { db.exec(`ALTER TABLE bots ADD COLUMN ${col}`); } catch { /* exists */ }
}
function migrateRoomsToTeams() {
  const rooms = db.prepare("SELECT id, members, created_at FROM bots WHERE kind='room'").all() as any[];
  if (!rooms.length) return;
  const ins = db.prepare('INSERT OR IGNORE INTO team_members(team_id, member_kind, member_id, role, created_at) VALUES (?,?,?,?,?)');
  for (const r of rooms) {
    let ids: string[] = [];
    try { ids = r.members ? JSON.parse(r.members) : []; } catch { ids = []; }
    for (const id of ids) ins.run(r.id, 'bot', id, 'member', r.created_at ?? Date.now());
  }
  db.prepare("UPDATE bots SET kind='team' WHERE kind='room'").run();
}
migrateRoomsToTeams();
initTeamMembers(db);

export const now = () => Date.now();
