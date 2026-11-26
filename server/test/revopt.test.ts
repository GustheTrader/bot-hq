import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the store at a scratch DB before importing anything that opens it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revopt-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.XAI_API_KEY = 'test';
process.env.COMPOSIO_API_KEY = 'test';
process.env.COMPUTER_PROVIDER = 'local';
process.env.SESSION_SECRET = 'test-secret';
process.env.ORGO_API_KEY = 'test';

const { db, now } = await import('../src/db.js');
const { newId } = await import('../src/lib/ids.js');
const { initRooms, createTeam } = await import('../src/agent/rooms.js');

initRooms();

function mkUser(id = newId('usr')): string {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, id, now());
  return id;
}

function mkBot(userId: string, name: string): string {
  const id = newId('bot');
  db.prepare(
    'INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, userId, name, '', '', '', 'blob', 'blue', 'personal', now(), now());
  return id;
}

/** Insert a task row directly, the way the route does, so we can assert on reads. */
function mkTask(userId: string, teamId: string, over: Partial<Record<string, unknown>> = {}) {
  const id = newId('rev');
  const t = now();
  db.prepare(
    `INSERT INTO revopt_tasks(id,user_id,team_id,kind,title,detail,target,status,priority,payload,created_at,updated_at,due_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, userId, teamId,
    over.kind ?? 'email',
    over.title ?? 'Reply to lead',
    over.detail ?? '',
    (over.target as string) ?? '',
    over.status ?? 'todo',
    over.priority ?? 'normal',
    over.payload ? JSON.stringify(over.payload) : '{}',
    t, t, (over.dueAt as number) ?? null,
  );
  return id;
}

test('a task row round-trips through the store with its team and payload', () => {
  const user = mkUser();
  const bot = mkBot(user, 'Sorter');
  const team = createTeam(user, 'RevOps', { botIds: [bot] });
  const id = mkTask(user, team, { kind: 'crm', priority: 'high', target: 'acme.com', payload: { dealStage: 'demo' } });

  const row = db.prepare('SELECT * FROM revopt_tasks WHERE id=?').get(id) as any;
  assert.equal(row.kind, 'crm');
  assert.equal(row.priority, 'high');
  assert.equal(row.target, 'acme.com');
  assert.deepEqual(JSON.parse(row.payload), { dealStage: 'demo' });
  assert.equal(row.team_id, team);
});

test('deleting a team cascades away its tasks', () => {
  const user = mkUser();
  const bot = mkBot(user, 'Sorter');
  const team = createTeam(user, 'Temp', { botIds: [bot] });
  const id = mkTask(user, team);
  assert.ok(db.prepare('SELECT 1 FROM revopt_tasks WHERE id=?').get(id));

  db.prepare('DELETE FROM bots WHERE id=?').run(team);
  assert.equal(db.prepare('SELECT 1 FROM revopt_tasks WHERE id=?').get(id), undefined, 'team delete cascades to tasks');
});

test('tasks are scoped to their owner', () => {
  const alice = mkUser();
  const bob = mkUser();
  const team = createTeam(alice, 'Alice Team', { botIds: [mkBot(alice, 'A')] });
  mkTask(alice, team);

  const aliceCount = (db.prepare('SELECT COUNT(*) n FROM revopt_tasks WHERE user_id=?').get(alice) as any).n;
  const bobCount = (db.prepare('SELECT COUNT(*) n FROM revopt_tasks WHERE user_id=?').get(bob) as any).n;
  assert.equal(aliceCount, 1);
  assert.equal(bobCount, 0, 'another user sees none of the tasks');
});

test('taskOutcome is what the team bots replied after the task was posted, newest last, at most two', async () => {
  const { taskOutcome } = await import('../src/routes-revopt.js');
  const { appendRow } = await import('../src/store.js');
  const user = mkUser();
  const a = mkBot(user, 'Ann'), b = mkBot(user, 'Ben');
  const team = createTeam(user, 'Outcomes', { botIds: [a, b] });
  appendRow(team, 'message', { type: 'message', role: 'assistant', text: 'old reply before the task', from: { kind: 'bot', id: a, name: 'Ann' } } as any);
  const posted = appendRow(team, 'message', { type: 'message', role: 'user', text: 'Task: renew Acme' } as any);
  appendRow(team, 'message', { type: 'message', role: 'assistant', text: 'Looking into Acme.', from: { kind: 'bot', id: a, name: 'Ann' } } as any);
  appendRow(team, 'event', { type: 'event', event: 'bot-message', text: 'noise' } as any);
  appendRow(team, 'message', { type: 'message', role: 'assistant', text: 'Drafted the renewal.', from: { kind: 'bot', id: b, name: 'Ben' } } as any);
  appendRow(team, 'message', { type: 'message', role: 'assistant', text: 'Sent  it\nto Dana.', from: { kind: 'bot', id: a, name: 'Ann' } } as any);
  assert.equal(taskOutcome({ team_id: team, row_seq: posted.seq }), 'Ben: Drafted the renewal. / Ann: Sent it to Dana.');
  assert.equal(taskOutcome({ team_id: team, row_seq: null }), '', 'a task never dispatched has no outcome');
});
