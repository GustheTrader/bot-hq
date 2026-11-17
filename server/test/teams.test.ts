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
const { initRooms, createTeam, teamMembers, dispatchRoomMessage, postToRoom, addHuman, setTeamRoster, teamBrief, setTeamBrief, setTeamLead, setTeamRole } =
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

test('team brief round-trips, is trimmed, and is cleared by an empty string', () => {
  const user = mkUser();
  const a = mkBot(user, 'Lead');
  const team = createTeam(user, 'Briefed', { botIds: [a] });

  assert.equal(teamBrief(team).text, '', 'a new team has no brief');
  const set = setTeamBrief(team, '  Ship the Q4 report.  ');
  assert.equal(set.text, 'Ship the Q4 report.');
  assert.ok(set.updatedAt, 'the write stamps updatedAt');
  assert.equal(teamBrief(team).text, 'Ship the Q4 report.');
  assert.equal(setTeamBrief(team, '').text, '', 'empty string clears the brief');
});

test('the brief is prepended to every responder prompt', () => {
  const user = mkUser();
  const a = mkBot(user, 'Lead');
  const team = createTeam(user, 'Directed', { botIds: [a] });
  setTeamBrief(team, 'Own the pricing model.');

  const seen: { botId: string; text: string }[] = [];
  dispatchRoomMessage(team, 'where are we?', (botId, t) => seen.push({ botId, text: t.text }));
  assert.equal(seen.length, 1);
  assert.match(seen[0].text, /Own the pricing model\./);
});

test('an observer is never a volunteer but runs when @mentioned', () => {
  const user = mkUser();
  const lead = mkBot(user, 'Lead');
  const eye = mkBot(user, 'Watcher');
  const team = createTeam(user, 'Watched', { botIds: [lead, eye] });
  setTeamRole(team, 'bot', eye, 'observer');

  const roster = teamMembers(team);
  assert.equal(roster.find((m) => m.id === eye)?.role, 'observer');
  assert.equal(roster.find((m) => m.id === lead)?.role, 'lead', 'the lead is untouched');

  // No mention: only the lead answers; the observer stays out of it.
  const silent: string[] = [];
  dispatchRoomMessage(team, 'status update please', (botId) => silent.push(botId));
  assert.deepEqual(silent, [lead]);

  // Mentioned by name: the observer is pulled in deliberately.
  const pulled: string[] = [];
  dispatchRoomMessage(team, '@Watcher what do you see?', (botId) => pulled.push(botId));
  assert.deepEqual(pulled, [eye]);
});

test('promoting a new lead demotes the old one and observers cannot lead', () => {
  const user = mkUser();
  const a = mkBot(user, 'Alpha');
  const b = mkBot(user, 'Beta');
  const team = createTeam(user, 'Chain', { botIds: [a, b] });
  assert.equal(teamMembers(team).find((m) => m.role === 'lead')?.id, a);

  setTeamLead(team, b);
  const leads = teamMembers(team).filter((m) => m.role === 'lead');
  assert.equal(leads.length, 1, 'exactly one lead');
  assert.equal(leads[0].id, b);

  setTeamRole(team, 'bot', a, 'observer');
  setTeamLead(team, a);
  assert.equal(teamMembers(team).find((m) => m.id === b)?.role, 'lead', 'an observer is not promoted to lead');
});
