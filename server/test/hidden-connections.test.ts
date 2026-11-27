import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.XAI_API_KEY = 'test'; process.env.COMPOSIO_API_KEY = 'test'; process.env.SESSION_SECRET = 'test'; process.env.COMPUTER_PROVIDER = 'local';
process.env.DB_PATH = (await import('node:path')).join((await import('node:os')).tmpdir(), `hidden-test-${process.pid}.db`);
process.env.HIDDEN_PROVIDERS = 'copilot, XAI ,xai-oauth';
process.env.HIDDEN_HARNESSES = 'deepseek';
process.env.HERMES_URL = 'http://127.0.0.1:9'; // nothing answers: subscriptions read Hermes as "could not tell"

const { toProviders } = await import('../src/engine.js');
const { listSubscriptions } = await import('../src/subscriptions.js');
const { env } = await import('../src/env.js');

test('hide lists are trimmed and lower-cased', () => {
  assert.deepEqual(env.hiddenProviders, ['copilot', 'xai', 'xai-oauth']);
  assert.deepEqual(env.hiddenHarnesses, ['deepseek']);
});

test('hidden providers leave the Engine panel, even when signed in or well known', () => {
  const ids = toProviders({ providers: [
    { slug: 'openai-codex', authenticated: true, models: ['m'] },
    { slug: 'copilot', authenticated: true, models: ['m'] },
    { slug: 'xai', authenticated: false },
    { slug: 'xai-oauth', authenticated: false },
    { slug: 'gemini', authenticated: false },
  ] }).map((p) => p.id);
  assert.ok(ids.includes('openai-codex') && ids.includes('gemini'));
  for (const gone of ['copilot', 'xai', 'xai-oauth']) assert.ok(!ids.includes(gone), gone);
});

test('a hidden provider drops its Subscriptions row', async () => {
  const ids = (await listSubscriptions()).map((s) => s.id);
  assert.ok(!ids.includes('xai'));
  assert.ok(ids.includes('openai') && ids.includes('anthropic'));
});
