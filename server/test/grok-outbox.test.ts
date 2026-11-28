import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-test-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(dir, 'db');
process.env.XAI_API_KEY = 'test-only'; process.env.COMPOSIO_API_KEY = 'test-only'; process.env.SESSION_SECRET = 'test-only'; process.env.COMPUTER_PROVIDER = 'local';
const { db } = await import('../src/db.js');
const { queueCallback } = await import('../src/grok-db.js');
const { deliverCallbacks, sendConfigured, redriveDead, checkDeadLetters, RETRY_DELAYS_MS, MAX_ATTEMPTS } = await import('../src/grok-notify.js');

const row = () => db.prepare('SELECT * FROM grok_outbox ORDER BY id DESC LIMIT 1').get() as any;
const fail = async () => { throw new Error('offline'); };
const mid = () => 0.5; // jitter factor exactly 1.0

test('retries spread over roughly a day before dead-letter', async () => {
  queueCallback('j1', 'completed', 'Synthetic');
  let clock = Date.now() + 10;
  const waits: number[] = [];
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    assert.equal(row().status, 'pending', `attempt ${i + 1} still pending`);
    clock = Math.max(clock, row().next_at);
    await deliverCallbacks(fail, clock, mid);
    if (row().status === 'pending') waits.push(row().next_at - clock);
  }
  assert.equal(row().status, 'dead');
  assert.equal(row().attempts, MAX_ATTEMPTS);
  assert.ok(row().dead_at >= clock);
  assert.equal(waits[0], 30_000, 'first retry after 30s');
  const total = waits.reduce((a, b) => a + b, 0);
  assert.ok(total >= 20 * 3600_000 && total <= 28 * 3600_000, `window ${total / 3600_000}h`);
  assert.deepEqual(waits, RETRY_DELAYS_MS.slice(0, MAX_ATTEMPTS - 1));
});

test('jitter stays within ±20% of the schedule', async () => {
  queueCallback('j-jitter', 'completed', 'Synthetic');
  const clock = Date.now() + 10;
  await deliverCallbacks(fail, clock, () => 0);
  assert.equal(row().next_at - clock, 24_000);
  const second = row().next_at;
  await deliverCallbacks(fail, second, () => 0.999999);
  assert.ok(Math.abs(row().next_at - second - 144_000) < 5, 'second retry ~2m * 1.2');
});

test('a successful retry is delivered once and not repeated', async () => {
  queueCallback('j2', 'completed', 'Synthetic 2');
  let calls = 0;
  await deliverCallbacks(async () => { calls++; throw new Error('offline'); }, Date.now() + 10, mid);
  await deliverCallbacks(async () => { calls++; }, row().next_at, mid);
  assert.equal(row().status, 'delivered');
  assert.equal(row().attempts, 2);
  // Other tests leave pending rows behind; only count deliveries of this row.
  await deliverCallbacks(async (r) => { if (r.job_id === 'j2') calls++; }, Date.now() + 10 ** 9, mid);
  assert.equal(calls, 2);
});

test('dead letters are drafted once per increase, never sent, and can be redriven', async () => {
  db.prepare('DELETE FROM grok_alert_drafts').run();
  const dead = (db.prepare("SELECT COUNT(*) n FROM grok_outbox WHERE status='dead'").get() as any).n;
  assert.ok(dead >= 1);
  const first = checkDeadLetters();
  assert.equal(first.dead, dead);
  assert.equal(first.drafted, true);
  assert.equal(checkDeadLetters().drafted, false, 'no new draft without new dead rows');
  const draft = db.prepare('SELECT * FROM grok_alert_drafts ORDER BY id DESC LIMIT 1').get() as any;
  assert.equal(draft.status, 'draft');
  assert.match(draft.body, /redrive/);
  const deadRow = db.prepare("SELECT id FROM grok_outbox WHERE status='dead' LIMIT 1").get() as any;
  assert.equal(redriveDead([deadRow.id]), 1);
  const r = db.prepare('SELECT * FROM grok_outbox WHERE id=?').get(deadRow.id) as any;
  assert.equal(r.status, 'pending');
  assert.equal(r.attempts, 0);
  assert.equal(r.redrives, 1);
  assert.equal(redriveDead([deadRow.id]), 0, 'only dead rows can be redriven');
});

function stubNotify(code: string) {
  const bin = path.join(dir, `notify-${code}.sh`);
  const argsFile = path.join(dir, `args-${code}.txt`);
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n%s\\n' "$1" "$2" > '${argsFile}'\necho ${code}\n`, { mode: 0o700 });
  return { bin, argsFile };
}

test('a real non-2xx from the notify program counts as a failure', async () => {
  const { bin } = stubNotify('500');
  process.env.GROK_CALLBACK_ENABLED = '1'; process.env.GROK_NOTIFY_BIN = bin;
  queueCallback('j500', 'completed', 'Synthetic 500');
  await deliverCallbacks(sendConfigured, Date.now() + 10, mid);
  assert.equal(row().status, 'pending');
  assert.equal(row().attempts, 1);
  assert.equal(row().last_error, 'delivery failed');
});

test('a 2xx delivers and passes jobId:event:outboxId as the task id', async () => {
  const { bin, argsFile } = stubNotify('200');
  process.env.GROK_CALLBACK_ENABLED = '1'; process.env.GROK_NOTIFY_BIN = bin;
  queueCallback('j200', 'needs_input', 'Synthetic 200');
  const id = row().id;
  await deliverCallbacks(sendConfigured, Date.now() + 10, mid);
  assert.equal((db.prepare('SELECT status FROM grok_outbox WHERE id=?').get(id) as any).status, 'delivered');
  const [msg, task] = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
  assert.equal(msg, 'Synthetic 200');
  assert.equal(task, `j200:needs_input:${id}`);
});

test('without delivery configured nothing is marked delivered', async () => {
  delete process.env.GROK_CALLBACK_ENABLED; delete process.env.GROK_NOTIFY_BIN;
  queueCallback('jnone', 'completed', 'Synthetic none');
  await deliverCallbacks(sendConfigured, Date.now() + 10, mid);
  assert.notEqual(row().status, 'delivered');
});
