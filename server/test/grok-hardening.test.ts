import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hardening-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(dir, 'db.sqlite');
process.env.XAI_API_KEY = 'test'; process.env.COMPOSIO_API_KEY = 'test'; process.env.SESSION_SECRET = 'test'; process.env.COMPUTER_PROVIDER = 'local';
process.env.GROK_TEST_NO_SCREEN = '1'; process.env.GROK_TEST_NO_DISPATCH = '1';
process.env.HERMES_URL = 'http://127.0.0.1:1'; process.env.HERMES_KEY = 'stub';
process.env.GROK_INTEGRATION_USER_ID = 'owner';
process.env.GROK_INTEGRATION_BOT_IDS = 'bot';
process.env.GROK_MAX_OPEN_PER_BOT = '1000'; process.env.GROK_MAX_JOBS_PER_DAY = '1000'; // caps have their own tests
const key = crypto.randomBytes(32).toString('base64url');
process.env.GROK_INTEGRATION_KEY_SHA256 = crypto.createHash('sha256').update(key).digest('hex');
const { db, now } = await import('../src/db.js');
const { grokApi } = await import('../src/routes-grok.js');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner', 'owner@example.invalid', 'Owner', now());
db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('bot', 'owner', 'Test', now(), now());
const request = (url: string, body: any) => grokApi.request(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const job = { botId: 'bot', title: 'Test', brief: 'Do something', sourceRef: 'unique-1' };

test('submission is idempotent and conflicting replays rejected', async () => {
  const first = await request('/jobs', job); assert.equal(first.status, 202); const a: any = await first.json();
  const second = await request('/jobs', job); assert.equal(second.status, 200); const b: any = await second.json(); assert.equal(a.jobId, b.jobId);
  const conflict = await request('/jobs', { ...job, brief: 'changed' }); assert.equal(conflict.status, 409);
  assert.equal((db.prepare('select count(*) n from grok_jobs').get() as any).n, 1);
});
test('unknown bot rejected', async () => {
  process.env.GROK_INTEGRATION_BOT_IDS = 'bot,unknown';
  assert.equal((await request('/jobs', { ...job, botId: 'unknown', sourceRef: 'none' })).status, 404);
  process.env.GROK_INTEGRATION_BOT_IDS = 'bot';
});
test('oversized brief rejected', async () => assert.equal((await request('/jobs', { ...job, sourceRef: 'big', brief: 'x'.repeat(20001) })).status, 400));
test('request body over hard byte limit rejected', async () => assert.equal((await request('/jobs', { ...job, brief: 'x'.repeat(200000) })).status, 413));
test('rate limit bounds a flood', async () => {
  let reason = '';
  for (let i = 0; i < 40; i++) {
    const r = await request('/jobs', { ...job, sourceRef: `flood-${i}` });
    if (r.status === 429) { reason = ((await r.json()) as any).error; break; }
  }
  assert.equal(reason, 'rate limited');
});
