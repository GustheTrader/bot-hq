import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.XAI_API_KEY = 'test'; process.env.COMPOSIO_API_KEY = 'test'; process.env.SESSION_SECRET = 'test'; process.env.COMPUTER_PROVIDER = 'local';
process.env.DB_PATH = (await import('node:path')).join((await import('node:os')).tmpdir(), `hidden-test-${process.pid}.db`);
process.env.HIDDEN_PROVIDERS = 'copilot, XAI-OAuth ,Openai-Codex';
process.env.HIDDEN_HARNESSES = ' DeepSeek ,OPENCODE';
process.env.HERMES_URL = 'http://127.0.0.1:9'; // nothing answers: subscriptions read Hermes as "could not tell"

const { toProviders } = await import('../src/engine.js');
const { listSubscriptions } = await import('../src/subscriptions.js');
const { env } = await import('../src/env.js');
const { visibleHarnesses, harnessSwitchRefusal, harnessHidden } = await import('../src/harness.js');

test('hide lists are trimmed and lower-cased', () => {
  assert.deepEqual(env.hiddenProviders, ['copilot', 'xai-oauth', 'openai-codex']);
  assert.deepEqual(env.hiddenHarnesses, ['deepseek', 'opencode']);
});

test('hidden providers leave the Engine panel, even when signed in or well known', () => {
  const ids = toProviders({ providers: [
    { slug: 'openai-codex', authenticated: true, models: ['m'] },
    { slug: 'copilot', authenticated: true, models: ['m'] },
    { slug: 'xai', authenticated: false },
    { slug: 'xai-oauth', authenticated: false },
    { slug: 'gemini', authenticated: false },
  ] }).map((p) => p.id);
  assert.ok(ids.includes('gemini') && !ids.includes('openai-codex'));
  for (const gone of ['copilot', 'xai-oauth']) assert.ok(!ids.includes(gone), gone);
  assert.ok(ids.includes('xai'), 'only the listed ids are hidden');
});

test('hiding any provider id a Subscriptions row stands for drops the row', async () => {
  const ids = (await listSubscriptions()).map((s) => s.id);
  assert.ok(!ids.includes('xai'), 'xai-oauth hides the Grok row');
  assert.ok(!ids.includes('openai'), 'openai-codex hides the ChatGPT row');
  assert.ok(ids.includes('anthropic') && ids.includes('ollama-cloud'));
});

test('hidden harnesses leave the picker', () => {
  const ids = visibleHarnesses().map((h) => h.id);
  assert.ok(!ids.includes('deepseek') && !ids.includes('opencode'));
  assert.ok(ids.includes('hermes') && ids.includes('codex'));
  assert.equal(harnessHidden('  DeepSeek'), true);
});

test('switching to a hidden harness is refused, staying on one is not', () => {
  assert.match(harnessSwitchRefusal('hermes', 'deepseek') ?? '', /turned off/);
  assert.equal(harnessSwitchRefusal('deepseek', 'deepseek'), null, 'a bot already on it keeps it');
  assert.equal(harnessSwitchRefusal('deepseek', 'codex'), null, 'leaving it is fine');
});
