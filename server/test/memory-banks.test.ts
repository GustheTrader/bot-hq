import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banks-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.XAI_API_KEY = 'test';
process.env.COMPOSIO_API_KEY = 'test';
process.env.COMPUTER_PROVIDER = 'local';
process.env.SESSION_SECRET = 'test-secret';
process.env.ORGO_API_KEY = 'test';

const { db, now } = await import('../src/db.js');
const { newId } = await import('../src/lib/ids.js');
const { initRooms, createTeam, setTeamRole } = await import('../src/agent/rooms.js');
const { initSubagents } = await import('../src/agent/subagents.js');
const M = await import('../src/memory-banks.js');

initRooms();
initSubagents(); // adds bots.hidden, as the server does at boot

const mkUser = () => {
  const id = newId('usr');
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, id, now());
  return id;
};
const mkBot = (userId: string, name: string) => {
  const id = newId('bot');
  db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, userId, name, '', '', '', 'blob', 'blue', 'personal', now(), now());
  return id;
};

/** A fake Hindsight that records calls and answers recall from a per-bank table. */
function fakeStore(facts: Record<string, string[]> = {}) {
  const calls: { method: string; url: string; body: any }[] = [];
  const fn = async (url: string, init: any = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? 'GET', url, body });
    const bank = /banks\/([^/]+)/.exec(url)?.[1] ?? '';
    if (url.endsWith('/memories/recall')) {
      if (!(bank in facts)) return { ok: false, status: 404, json: async () => ({}), text: async () => 'bank not found' };
      return { ok: true, status: 200, json: async () => ({ results: facts[bank].map((text) => ({ text, mentioned_at: '2026-11-20T00:00:00Z' })) }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ operation_id: 'op1' }), text: async () => '' };
  };
  return { calls, fn: fn as any };
}

test('a bot reads its own bank, its teams\' banks and shared; observers cannot write to a team bank', () => {
  const user = mkUser();
  const scout = mkBot(user, 'Scout');
  const analyst = mkBot(user, 'Analyst');
  const sales = createTeam(user, 'Sales', { botIds: [scout, analyst] });
  const ops = createTeam(user, 'Ops', { botIds: [scout, analyst] });
  setTeamRole(ops, 'bot', analyst, 'observer');

  const banks = M.banksForBot(user, analyst);
  assert.deepEqual(banks.map((b) => [b.layer, b.label, b.writable]), [
    ['me', 'Analyst (own)', true], ['team', 'Team Sales', true], ['team', 'Team Ops', false], ['everyone', 'Everyone (shared)', true],
  ]);
  assert.equal(banks[0].id, analyst);
  assert.equal(banks[1].id, sales);

  // Saving defaults to the bot's own bank; a team must be named when there are several.
  assert.equal(M.pickBanks(user, analyst, { write: true })[0].id, analyst);
  assert.throws(() => M.pickBanks(user, analyst, { layer: 'team', write: true }), /several teams/);
  assert.equal(M.pickBanks(user, analyst, { layer: 'team', team: 'sales', write: true })[0].id, sales);
  assert.throws(() => M.pickBanks(user, analyst, { layer: 'team', team: 'Ops', write: true }), /observer/);
  assert.throws(() => M.pickBanks(user, analyst, { team: 'Legal' }), /not on a team named "Legal"/);
  // Recall takes every match, observer banks included.
  assert.equal(M.pickBanks(user, analyst, { layer: 'team' }).length, 2);
  assert.equal(M.pickBanks(user, analyst, {}).length, 4);
});

test('another account\'s bots and teams are never in reach', () => {
  const a = mkUser(), b = mkUser();
  const mine = mkBot(a, 'Mine');
  const theirs = mkBot(b, 'Theirs');
  const theirTeam = createTeam(b, 'Theirs', { botIds: [theirs, mkBot(b, 'Other')] });
  assert.deepEqual(M.banksForBot(a, theirs), []);
  assert.equal(M.teamBank(a, theirTeam), null);
  assert.ok(M.userMayView(a, mine));
  assert.ok(M.userMayView(a, 'shared'));
  assert.ok(!M.userMayView(a, theirs));
  assert.ok(!M.userMayView(a, theirTeam));
});

test('retain creates the bank once, then saves asynchronously with who saved it', async () => {
  const user = mkUser();
  const bot = mkBot(user, 'Writer');
  const [bank] = M.pickBanks(user, bot, { write: true });
  const s = fakeStore();
  const r1 = await M.retain(bank, '  Acme renewed for 2027 at $40k.  ', { by: 'Writer (bot)', tags: ['acme'] }, s.fn);
  await M.retain(bank, 'Second fact.', { by: 'Writer (bot)' }, s.fn);
  assert.equal(r1.operationId, 'op1');
  const puts = s.calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 1, 'the bank is created only once per process');
  assert.match(puts[0].url, new RegExp(`/banks/${bot}$`));
  assert.equal(puts[0].body.name, 'Writer (own)');
  const post = s.calls.find((c) => c.method === 'POST')!;
  assert.equal(post.body.async, true);
  assert.equal(post.body.items[0].content, 'Acme renewed for 2027 at $40k.');
  assert.deepEqual(post.body.items[0].metadata, { by: 'Writer (bot)', layer: 'me' });
  assert.deepEqual(post.body.items[0].tags, ['acme']);
  await assert.rejects(M.retain(bank, '   ', { by: 'x' }, s.fn), /Nothing to remember/);
});

test('shared is never re-created; recall merges banks and treats a bank never written to as empty', async () => {
  const user = mkUser();
  const bot = mkBot(user, 'Reader');
  createTeam(user, 'Desk', { botIds: [bot, mkBot(user, 'Pal')] });
  const banks = M.pickBanks(user, bot, {});
  const s = fakeStore({ shared: ['The office closes Dec 24.'], [bot]: ['Reader prefers short replies.'] });
  const hits = await M.recall(banks, 'holiday', s.fn);
  assert.equal(hits.length, 2);
  const text = M.formatRecall(hits, banks);
  assert.match(text, /## Reader \(own\)\n- Reader prefers short replies\. \(2026-11-20\)/);
  assert.match(text, /## Everyone \(shared\)\n- The office closes Dec 24\./);
  assert.doesNotMatch(text, /Team Desk/);

  const sharedBank = banks.find((b) => b.id === 'shared')!;
  await M.retain(sharedBank, 'Global fact.', { by: 'Reader (bot)' }, s.fn);
  assert.ok(!s.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/banks/shared')));
  assert.equal(M.formatRecall([], banks.slice(0, 1)), 'Nothing found in Reader (own).');
});

test('an unreachable store says so', async () => {
  const user = mkUser();
  const bot = mkBot(user, 'Lonely');
  const down = (async () => { throw new Error('ECONNREFUSED'); }) as any;
  await assert.rejects(M.recall(M.pickBanks(user, bot, {}), 'x', down), /not answering/);
});
