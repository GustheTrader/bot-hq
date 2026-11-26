import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-'));
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the DB may still be open on Windows */ } });
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.XAI_API_KEY = 'test';
process.env.COMPOSIO_API_KEY = 'test';
process.env.COMPUTER_PROVIDER = 'local';
process.env.SESSION_SECRET = 'test-secret';
process.env.ORGO_API_KEY = 'test';

const { db, now } = await import('../src/db.js');
const { newId } = await import('../src/lib/ids.js');
const { initRooms, createTeam, outsiders, teamSpace } = await import('../src/agent/rooms.js');
const { initSubagents, createSubagent } = await import('../src/agent/subagents.js');
const S = await import('../src/spaces.js');
const M = await import('../src/memory-banks.js');
const P = await import('../src/projects.js');
const { startWork } = await import('../src/routes-launch.js');
const { routeNote } = await import('../src/obsidian.js');
const { TEMPLATES, planFromTemplate } = await import('../src/bot-templates.js');
const { isPortraitPreset } = await import('../src/portraits.js');

initRooms();
initSubagents();

const mkUser = () => {
  const id = newId('usr');
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, id, now());
  return id;
};
const mkBot = (userId: string, name: string, spaceId: string | null = null, primary = false) => {
  const id = newId('bot');
  db.prepare('INSERT INTO bots(id,user_id,name,avatar_shape,avatar_color,mode,is_primary,space_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, userId, name, 'blob', 'blue', 'personal', primary ? 1 : 0, spaceId, now(), now());
  return id;
};
const world = () => {
  const user = mkUser();
  const a = S.createSpace(user, { name: 'Sierra Home Pros' });
  const b = S.createSpace(user, { name: 'Race Lab', kind: 'project' });
  const chief = mkBot(user, 'Chief', null, true);
  const botA = mkBot(user, 'Dispatch', a.id);
  const botB = mkBot(user, 'Analyst', b.id);
  const general = mkBot(user, 'Helper');
  return { user, a, b, chief, botA, botB, general };
};
const bankIds = (user: string, bot: string) => M.banksForBot(user, bot).map((x) => x.id);

test("workspace names are unique, folder-safe, and one account cannot use another account's", () => {
  const { user, a } = world();
  assert.throws(() => S.createSpace(user, { name: 'sierra home pros' }), /already exists/);
  assert.throws(() => S.createSpace(user, { name: 'a/b' }), /Leave out/);
  assert.throws(() => S.createSpace(user, { name: 'Shared' }), /already exists/);
  assert.throws(() => S.createSpace(user, { name: 'X', kind: 'club' }), /business or a project/);
  assert.throws(() => S.spaceIdFrom(mkUser(), a.id), /does not exist/);
});

test('a workspace bot reads its workspace bank instead of the shared one', () => {
  const { user, a, b, chief, botA, general } = world();
  assert.deepEqual(bankIds(user, botA), [botA, a.id]);
  assert.deepEqual(bankIds(user, general), [general, M.SHARED]);
  assert.deepEqual(bankIds(user, chief), [chief, M.SHARED]);
  const [bank] = M.pickBanks(user, botA, { layer: 'everyone', write: true });
  assert.equal(bank.id, a.id);
  assert.ok(!bankIds(user, botA).includes(b.id));
  assert.ok(M.userMayView(user, a.id));
  assert.ok(!M.userMayView(mkUser(), a.id));
});

test('bots reach their own workspace and the main bot only', () => {
  const bot = { space_id: 'x' };
  assert.ok(S.canReach(bot, { space_id: 'x' }));
  assert.ok(!S.canReach(bot, { space_id: 'y' }));
  assert.ok(!S.canReach(bot, { space_id: null }));
  assert.ok(S.canReach(bot, { space_id: null, is_primary: 1 }));
});

test('teams stay inside a workspace, and a stale membership gives no team memory', () => {
  const { user, a, chief, botA, botB } = world();
  assert.equal(teamSpace([chief, botA]), a.id);
  assert.deepEqual(outsiders([chief, botA, botB], a.id), ['Analyst']);
  const team = createTeam(user, 'Ops', { botIds: [chief, botA] });
  assert.equal((db.prepare('SELECT space_id FROM bots WHERE id=?').get(team) as any).space_id, a.id);
  assert.ok(bankIds(user, botA).includes(team));
  assert.ok(bankIds(user, chief).includes(team));
  db.prepare('INSERT INTO team_members(team_id,member_kind,member_id,role,created_at) VALUES (?,?,?,?,?)').run(team, 'bot', botB, 'member', now());
  assert.ok(!bankIds(user, botB).includes(team));
});

test('moving a bot is refused while a team would mix workspaces; the main bot never moves', () => {
  const { user, a, b, chief, botA } = world();
  const team = createTeam(user, 'Ops', { botIds: [botA] });
  assert.throws(() => S.moveBot(user, botA, b.id), /Take this bot off Ops/);
  assert.throws(() => S.moveBot(user, team, b.id), /Move Dispatch/);
  assert.throws(() => S.moveBot(user, chief, a.id), /stays in General/);
  db.prepare('DELETE FROM team_members WHERE team_id=?').run(team);
  const helper = createSubagent(botA, 'check the schedule');
  assert.deepEqual(bankIds(user, helper.id), [helper.id, a.id]);
  S.moveBot(user, botA, b.id);
  assert.deepEqual(bankIds(user, botA), [botA, b.id]);
  assert.deepEqual(bankIds(user, helper.id), [helper.id, b.id]);
});

test('only an empty workspace can be deleted', () => {
  const { user, a } = world();
  assert.throws(() => S.deleteSpace(user, a.id), /Move or delete/);
  const empty = S.createSpace(user, { name: 'Empty' });
  S.deleteSpace(user, empty.id);
  assert.equal(S.getSpace(user, empty.id), null);
});

test('a workspace project starts only on its own bots or the main bot', () => {
  const { user, a, chief, botA, botB, general } = world();
  const project = P.createProject(user, { name: 'Spring push', spaceId: a.id });
  assert.equal(project.spaceId, a.id);
  assert.equal(P.updateProject(user, project.id, { name: 'Spring' }).spaceId, a.id);
  assert.throws(() => P.createProject(user, { name: 'x', spaceId: 'spc_nope' }), /does not exist/);
  const deps = { getBotRow: (id: string) => db.prepare('SELECT * FROM bots WHERE id=?').get(id) as any, appendRow: () => {}, enqueue: () => {} };
  const start = (botId: string) => startWork(user, { botId, projectId: project.id, prompt: 'go' }, deps);
  start(botA);
  start(chief);
  assert.throws(() => start(botB), /another workspace/);
  assert.throws(() => start(general), /another workspace/);
});

test('vault notes under Businesses/<workspace>/ go to that workspace', () => {
  const { user, a } = world();
  const route = routeNote(user, 'Businesses/Sierra Home Pros/pricing.md');
  assert.ok(!('skip' in route));
  assert.equal(route.id, a.id);
  assert.ok('skip' in routeNote(user, 'Businesses/Nobody/x.md'));
});

test('every template starts with its own preset portrait', () => {
  const images = TEMPLATES.map((t) => {
    const answers = Object.fromEntries(t.inputs.map((i) => [i.key, i.default ?? (i.key === 'repo' ? 'o/n' : 'x')]));
    return planFromTemplate(t.id, answers, { available: new Set(['buildflow'] as const) }).bot.avatarImage;
  });
  assert.ok(images.every(isPortraitPreset));
  assert.equal(new Set(images).size, TEMPLATES.length);
});
