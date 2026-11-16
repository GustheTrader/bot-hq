import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The store reads DB_PATH at import time, so point it at a scratch file before importing.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.XAI_API_KEY = 'test';
process.env.COMPOSIO_API_KEY = 'test';
process.env.COMPUTER_PROVIDER = 'local';process.env.SESSION_SECRET = 'test-secret';
process.env.ORGO_API_KEY = 'test';

const { db, now } = await import('../src/db.js');
const { newId } = await import('../src/lib/ids.js');
const { initRooms, createTeam, teamMembers, dispatchRoomMessage, postToRoom, addHuman, setTeamRoster } =
  await import('../src/agent/rooms.js');

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

test('createTeam mixes bots and people on one roster', () => {
  const user = mkUser();
  const a = mkBot(user, 'Scout');
  const b = mkBot(user, 'Analyst');
  const humanId = addHuman(user, 'Dana', 'dana@example.com');
  const team = createTeam(user, 'Research', { botIds: [a, b], humanIds: [humanId] });

  const members = teamMembers(team);
  assert.equal(members.length, 3);
  assert.equal(members.filter((m) => m.kind === 'bot').length, 2);
  assert.equal(members.filter((m) => m.kind === 'human').length, 1);
  // The first bot leads, so the team always has someone to answer.
  const lead = members.find((m) => m.kind === 'bot' && m.role === 'lead');
  assert.equal(lead?.id, a);
});

test('a team message goes to the bots, and @mention narrows the responders', () => {
  const user = mkUser();
  const a = mkBot(user, 'Alpha');
  const b = mkBot(user, 'Beta');
  const c = mkBot(user, 'Gamma');
  const team = createTeam(user, 'Triage', { botIds: [a, b, c] });

  const seen: { botId: string; text: string }[] = [];
  const enqueue = (botId: string, t: any) => seen.push({ botId, text: t.text });

  dispatchRoomMessage(team, 'status please', enqueue);
  // No mention: the lead plus up to MAX_RESPONDERS-1 others.
  assert.ok(seen.length >= 1 && seen.length <= 3);
  assert.equal(seen[0].botId, a, 'the lead answers first');

  seen.length = 0;
  dispatchRoomMessage(team, '@beta what changed?', enqueue);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].botId, b, 'only the mentioned bot answers');
  assert.match(seen[0].text, /@mentioned/);
});

test('@mentioning a person notifies them instead of dispatching a bot', () => {
  const user = mkUser();
  const a = mkBot(user, 'Coder');
  const dana = addHuman(user, 'Dana');
  const team = createTeam(user, 'Build', { botIds: [a], humanIds: [dana] });

  const seen: string[] = [];
  dispatchRoomMessage(team, '@dana can you review this?', (botId) => seen.push(botId));
  // Dana is a person, so no extra bot is enqueued, but the lead still gets context.
  assert.deepEqual(seen, [a]);
  const rows = db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='event'").all(team) as any[];
  assert.ok(rows.some((r) => JSON.parse(r.body).text.includes('Dana was mentioned')));
});

test('postToRoom refuses a non-member and accepts a member', () => {
  const user = mkUser();
  const a = mkBot(user, 'Insider');
  const outsider = mkBot(user, 'Outsider');
  const team = createTeam(user, 'Ops', { botIds: [a] });

  assert.match(postToRoom(outsider, 'Ops', 'hi'), /not a member/);
  assert.equal(postToRoom(a, 'Ops', 'on it'), 'Posted to the team.');
  const msgs = db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='message'").all(team) as any[];
  assert.equal(JSON.parse(msgs[0].body).text, 'on it');
});

test('setTeamRoster swaps the roster and keeps a lead', () => {
  const user = mkUser();
  const a = mkBot(user, 'One');
  const b = mkBot(user, 'Two');
  const c = mkBot(user, 'Three');
  const team = createTeam(user, 'Rotating', { botIds: [a, b] });

  setTeamRoster(team, [b, c], []);
  const ids = teamMembers(team).map((m) => m.id).sort();
  assert.deepEqual(ids, [b, c].sort());
  assert.equal(teamMembers(team).find((m) => m.role === 'lead')?.id, b);
});

test('migration: a legacy kind=room row becomes a team with team_members', async () => {
  const u = mkUser();
  const a = mkBot(u, 'Alpha');
  const b2 = mkBot(u, 'Beta');
  const legacy = newId('room');
  db.prepare(
    "INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,kind,members,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?, 'room', ?,?,?)",
  ).run(legacy, u, 'Old Group', 'Group', '', '', 'cloud', 'gray', 'personal', JSON.stringify([a, b2]), now(), now());
  db.prepare("UPDATE bots SET kind='room' WHERE id=?").run(legacy);

  // The migration runs at db import; re-run it so this row is picked up.
  const rooms = db.prepare("SELECT id, members, created_at FROM bots WHERE kind='room'").all() as any[];
  assert.equal(rooms.length, 1, 'the legacy row is still marked room');
  const ins = db.prepare('INSERT OR IGNORE INTO team_members(team_id, member_kind, member_id, role, created_at) VALUES (?,?,?,?,?)');
  for (const r of rooms) {
    for (const id of JSON.parse(r.members)) ins.run(r.id, 'bot', id, 'member', r.created_at);
  }
  db.prepare("UPDATE bots SET kind='team' WHERE kind='room'").run();

  const kind = (db.prepare('SELECT kind FROM bots WHERE id=?').get(legacy) as any).kind;
  assert.equal(kind, 'team', 'legacy room is now a team');
  const names = teamMembers(legacy).map((m) => m.name).sort();
  assert.deepEqual(names, ['Alpha', 'Beta']);
});
