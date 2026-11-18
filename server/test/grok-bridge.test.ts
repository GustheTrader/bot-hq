import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR!, 'grok-bridge-test-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.XAI_API_KEY = 'test'; process.env.COMPOSIO_API_KEY = 'test';
process.env.COMPUTER_PROVIDER = 'local'; process.env.SESSION_SECRET = 'test-only';
process.env.GROK_AUTH_FAIL_LIMIT = '1000'; // throttling has its own tests
const key = crypto.randomBytes(32).toString('base64url');
const sha = crypto.createHash('sha256').update(key).digest('hex');
process.env.GROK_INTEGRATION_KEY_SHA256 = sha;
process.env.GROK_INTEGRATION_USER_ID = 'user-test';
const { grokApi } = await import('../src/routes-grok.js');

const get = (token?: string, extra: Record<string, string> = {}) =>
  grokApi.request('/jobs/nope', { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } });

test('missing key is rejected', async () => assert.equal((await get()).status, 401));
test('wrong key is rejected', async () => assert.equal((await get(crypto.randomBytes(32).toString('base64url'))).status, 401));
test('malformed key is rejected', async () => assert.equal((await get('wrong')).status, 401));
test('lowercase scheme and query-string keys are rejected', async () => {
  assert.equal((await grokApi.request('/jobs/nope', { headers: { authorization: `bearer ${key}` } })).status, 401);
  assert.equal((await grokApi.request(`/jobs/nope?key=${key}`)).status, 401);
});
test('an HQ session cookie does not unlock the bridge', async () => assert.equal((await get(undefined, { cookie: 'grokbot_session=anything' })).status, 401));
test('valid key passes authentication', async () => assert.equal((await get(key)).status, 404));
test('removing the env hash revokes the key', async () => {
  delete process.env.GROK_INTEGRATION_KEY_SHA256;
  assert.equal((await get(key)).status, 401);
});
test('a key file is re-read per request, so emptying or deleting it revokes without a restart', async () => {
  const file = path.join(dir, 'key.sha256');
  fs.writeFileSync(file, `${sha}\n`, { mode: 0o600 });
  process.env.GROK_INTEGRATION_KEY_SHA256_FILE = file;
  assert.equal((await get(key)).status, 404);
  fs.writeFileSync(file, '');
  assert.equal((await get(key)).status, 401);
  fs.writeFileSync(file, `${sha}\n`);
  assert.equal((await get(key)).status, 404);
  fs.rmSync(file);
  assert.equal((await get(key)).status, 401);
  delete process.env.GROK_INTEGRATION_KEY_SHA256_FILE;
});
