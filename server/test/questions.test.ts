import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The store reads DB_PATH at import time, so point it at a scratch file before importing.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'questions-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.XAI_API_KEY = 'test';
process.env.COMPOSIO_API_KEY = 'test';
process.env.COMPUTER_PROVIDER = 'local';
process.env.SESSION_SECRET = 'test-secret';
process.env.ORGO_API_KEY = 'test';

const { db, now } = await import('../src/db.js');
const { newId } = await import('../src/lib/ids.js');
const { appendRow, getLive, setLive, setPendingQuestion, clearPendingQuestion, restorePendingQuestions } = await import('../src/store.js');

function mkBot(): string {
  const user = newId('usr');
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(user, `${user}@example.com`, user, now());
  const id = newId('bot');
  db.prepare(
    'INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, user, 'Scout', '', '', '', 'blob', 'blue', 'personal', now(), now());
  return id;
}

const ask = (botId: string, status: 'pending' | 'answered' = 'pending') =>
  appendRow(botId, 'card', { type: 'card', card: 'question', question: 'Which inbox?', options: ['Work', 'Personal'], status });

test('a pending question marks the bot as waiting, not idle', () => {
  const bot = mkBot();
  const row = ask(bot);
  setPendingQuestion(bot, { seq: row.seq, question: 'Which inbox?', options: ['Work', 'Personal'] });
  const l = getLive(bot);
  assert.equal(l.isRunning, false);
  assert.equal(l.awaiting?.reason, 'Which inbox?');
  assert.equal(l.activity?.kind, 'waiting_for_you');
  assert.deepEqual(l.question, { seq: row.seq, question: 'Which inbox?', options: ['Work', 'Personal'] });
});

test('clearing only applies to the question it was asked about', () => {
  const bot = mkBot();
  const row = ask(bot);
  setPendingQuestion(bot, { seq: row.seq, question: 'Which inbox?', options: ['Work'] });

  clearPendingQuestion(bot, row.seq + 99); // a different (older) question: leave the waiting state alone
  assert.ok(getLive(bot).question);

  clearPendingQuestion(bot, row.seq);
  const l = getLive(bot);
  assert.equal(l.question, null);
  assert.equal(l.awaiting, null);
  assert.equal(l.activity, null);
});

test('clearing does not stop a bot that is already running its next turn', () => {
  const bot = mkBot();
  const row = ask(bot);
  setPendingQuestion(bot, { seq: row.seq, question: 'Which inbox?', options: ['Work'] });
  setLive(bot, { isRunning: true, activity: { kind: 'thinking', since: now() } });
  clearPendingQuestion(bot, row.seq);
  assert.equal(getLive(bot).isRunning, true);
  assert.equal(getLive(bot).activity?.kind, 'thinking');
});

test('restore brings back an unanswered question after a restart', () => {
  const bot = mkBot();
  const row = ask(bot);
  assert.equal(getLive(bot).question, undefined, 'a fresh process has no live state for the bot');
  restorePendingQuestions();
  const l = getLive(bot);
  assert.equal(l.question?.seq, row.seq);
  assert.deepEqual(l.question?.options, ['Work', 'Personal']);
  assert.equal(l.awaiting?.reason, 'Which inbox?');
});

test('restore ignores answered questions and ones the person already replied to in their own words', () => {
  const answered = mkBot();
  ask(answered, 'answered');

  const typed = mkBot();
  ask(typed);
  appendRow(typed, 'message', { type: 'message', role: 'user', text: 'Work, thanks' });

  restorePendingQuestions();
  assert.equal(getLive(answered).question, undefined);
  assert.equal(getLive(typed).question, undefined);
});

test('restore picks the newest pending question when a bot asked more than one', () => {
  const bot = mkBot();
  ask(bot);
  const second = appendRow(bot, 'card', { type: 'card', card: 'question', question: 'Which day?', options: ['Mon', 'Tue'], status: 'pending' });
  restorePendingQuestions();
  assert.equal(getLive(bot).question?.seq, second.seq);
  assert.equal(getLive(bot).question?.question, 'Which day?');
});
