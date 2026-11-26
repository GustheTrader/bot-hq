import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banks-'));
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the DB may still be open on Windows */ } });
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
  const res = await M.recall(banks, 'holiday', s.fn);
  assert.equal(res.hits.length, 2);
  assert.equal(res.failed.length, 0);
  const text = M.formatRecall(res, banks);
  assert.match(text, /## Reader \(own\)\n- Reader prefers short replies\. \(2026-11-20\)/);
  assert.match(text, /## Everyone \(shared\)\n- The office closes Dec 24\./);
  assert.doesNotMatch(text, /Team Desk/);

  const sharedBank = banks.find((b) => b.id === 'shared')!;
  await M.retain(sharedBank, 'Global fact.', { by: 'Reader (bot)' }, s.fn);
  assert.ok(!s.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/banks/shared')));
  assert.equal(M.formatRecall({ hits: [], failed: [] }, banks.slice(0, 1)), 'Nothing found in Reader (own).');
});

test('an unreachable store says so', async () => {
  const user = mkUser();
  const bot = mkBot(user, 'Lonely');
  const down = (async () => { throw new Error('ECONNREFUSED'); }) as any;
  await assert.rejects(M.recall(M.pickBanks(user, bot, {}), 'x', down), /not answering/);
});

test('teams are picked by name or id; a team alone means save to that team; duplicate names need the id', () => {
  const user = mkUser();
  const bot = mkBot(user, 'Dup');
  const a = createTeam(user, 'Ops', { botIds: [bot, mkBot(user, 'P1')] });
  const b = createTeam(user, 'Ops', { botIds: [bot, mkBot(user, 'P2')] });
  const solo = mkBot(user, 'Solo');
  const only = createTeam(user, 'Desk', { botIds: [solo, mkBot(user, 'P3')] });
  assert.equal(M.pickBanks(user, solo, { team: 'desk', write: true })[0].id, only, 'team without scope saves to that team');
  assert.throws(() => M.pickBanks(user, bot, { team: 'Ops', write: true }), (e: any) => e.message.includes(a) && e.message.includes(b) && /pass its id/.test(e.message));
  assert.equal(M.pickBanks(user, bot, { team: b, write: true })[0].id, b);
  assert.equal(M.pickBanks(user, bot, { team: 'Ops' }).length, 2, 'recall searches both');
});

test('retain refuses text over the limit instead of cutting it', async () => {
  const user = mkUser();
  const bot = mkBot(user, 'Long');
  const [bank] = M.pickBanks(user, bot, { write: true });
  await assert.rejects(M.retain(bank, 'x'.repeat(M.MAX_MEMORY + 1), { by: 'Long (bot)' }, fakeStore().fn), /8001 characters; one memory holds at most 8000/);
});

test('recall keeps the banks that answered when one fails, and fails only when all do', async () => {
  const user = mkUser();
  const bot = mkBot(user, 'Half');
  const banks = M.pickBanks(user, bot, {});
  const fn = (async (url: string) => url.includes('/banks/shared/')
    ? { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' }
    : { ok: true, status: 200, json: async () => ({ results: [{ text: 'Own fact.' }] }), text: async () => '' }) as any;
  const res = await M.recall(banks, 'q', fn);
  assert.deepEqual(res.hits.map((h) => h.text), ['Own fact.']);
  assert.deepEqual(res.failed.map((b) => b.id), ['shared']);
  assert.match(M.formatRecall(res, banks), /Own fact\.\n\(Could not search Everyone \(shared\) just now\.\)/);
  const down = (async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' })) as any;
  await assert.rejects(M.recall(banks, 'q', down), (e: any) => e.status === 503);
});

test('forgetting checks the HTTP status, not the words in the error body', async () => {
  const gone = (async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })) as any;
  await M.forgetDocument('shared', 'doc', gone); // already gone: fine
  const broken = (async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'upstream said 404 earlier' })) as any;
  await assert.rejects(M.forgetDocument('shared', 'doc', broken), (e: any) => e.status === 500);
});

test('bankById is scoped to one account', () => {
  const a = mkUser(), b = mkUser();
  const theirs = mkBot(b, 'Theirs');
  assert.equal(M.bankById(a, theirs), null);
  assert.equal(M.bankById(b, theirs)?.id, theirs);
  assert.equal(M.bankById(a, 'shared')?.id, 'shared');
});

test('a durable save waits through an outage and is delivered by the retry, once, under one document id', async () => {
  const user = mkUser();
  const t = createTeam(user, 'Retry', { botIds: [mkBot(user, 'R1'), mkBot(user, 'R2')] });
  const bank = M.teamBank(user, t)!;
  const down = (async () => { throw new Error('ECONNREFUSED'); }) as any;
  await M.retainDurably(user, bank, 'Task finished: renewal sent.', { by: 'Test', documentId: 'revopt-task1' }, down);
  assert.equal((db.prepare("SELECT attempts FROM memory_pending WHERE document_id='revopt-task1'").get() as any).attempts, 1);
  const s = fakeStore();
  const r = await M.retryPending(s.fn);
  assert.deepEqual(r, { delivered: 1, waiting: 0 });
  const post = s.calls.find((c) => c.method === 'POST')!;
  assert.equal(post.body.items[0].document_id, 'revopt-task1');
  assert.equal(post.body.items[0].update_mode, 'replace');
  assert.deepEqual(await M.retryPending(s.fn), { delivered: 0, waiting: 0 });
});

test('a team with a scope other than team is an error, not a silent switch', () => {
  const user = mkUser();
  const bot = mkBot(user, 'Mixed');
  const t = createTeam(user, 'Ops', { botIds: [bot, mkBot(user, 'Mx2')] });
  assert.throws(() => M.pickBanks(user, bot, { layer: 'everyone', team: 'Ops', write: true }), /team goes with scope "team"/);
  assert.throws(() => M.pickBanks(user, bot, { layer: 'me', team: 'Ops' }), /team goes with scope "team"/);
  assert.equal(M.pickBanks(user, bot, { layer: 'team', team: 'Ops', write: true })[0].id, t);
  assert.equal(M.pickBanks(user, bot, { layer: 'all', team: 'Ops' })[0].id, t, 'scope all with a team narrows to that team');
});
