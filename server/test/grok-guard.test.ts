import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

process.env.NODE_ENV = 'test';
const { grokEnvProblems, testFlag } = await import('../src/grok-guard.js');

const serverDir = path.resolve(new URL('.', import.meta.url).pathname, '..');
const tsx = path.resolve(serverDir, '../node_modules/.bin/tsx');

test('test-only switches are reported outside NODE_ENV=test', () => {
  for (const name of ['GROK_TEST_NO_SCREEN', 'GROK_TEST_NO_DISPATCH', 'GROK_CALLBACK_LOG', 'GROK_NOTIFY_BIN', 'GROK_TEST_SWEEP_MS']) {
    assert.equal(grokEnvProblems({ NODE_ENV: 'production', [name]: '1' }).length, 1, name);
    assert.equal(grokEnvProblems({ [name]: '1' }).length, 1, `${name} with NODE_ENV unset`);
    assert.equal(grokEnvProblems({ NODE_ENV: 'test', [name]: '1' }).length, 0, `${name} in test`);
  }
});

test('callback log and real delivery cannot both be configured', () => {
  assert.ok(grokEnvProblems({ NODE_ENV: 'test', GROK_CALLBACK_LOG: '/x', GROK_CALLBACK_ENABLED: '1' }).length > 0);
});

test('bridge listener must be a specific loopback address unless explicitly allowed', () => {
  assert.equal(grokEnvProblems({ GROK_BRIDGE_PORT: '9911' }).length, 0); // defaults to 127.0.0.1
  assert.equal(grokEnvProblems({ GROK_BRIDGE_PORT: '9911', GROK_BRIDGE_HOST: '::1' }).length, 0);
  assert.ok(grokEnvProblems({ GROK_BRIDGE_PORT: '9911', GROK_BRIDGE_HOST: '0.0.0.0' }).length > 0);
  assert.ok(grokEnvProblems({ GROK_BRIDGE_PORT: '9911', GROK_BRIDGE_HOST: '::', GROK_BRIDGE_ALLOW_NONLOOPBACK: '1' }).length > 0, 'wildcards never allowed');
  assert.ok(grokEnvProblems({ GROK_BRIDGE_PORT: '9911', GROK_BRIDGE_HOST: '100.64.0.5' }).length > 0);
  assert.equal(grokEnvProblems({ GROK_BRIDGE_PORT: '9911', GROK_BRIDGE_HOST: '100.64.0.5', GROK_BRIDGE_ALLOW_NONLOOPBACK: '1' }).length, 0);
  assert.ok(grokEnvProblems({ GROK_BRIDGE_PORT: '8797', PORT: '8797' }).length > 0, 'must not share the main port');
});

test('a clean production environment has no problems', () => {
  assert.deepEqual(grokEnvProblems({ NODE_ENV: 'production', PORT: '8797' }), []);
});

test('testFlag only honours switches in test mode', () => {
  process.env.GROK_TEST_NO_SCREEN = '1';
  assert.equal(testFlag('GROK_TEST_NO_SCREEN'), true);
  delete process.env.GROK_TEST_NO_SCREEN;
  assert.equal(testFlag('GROK_TEST_NO_SCREEN'), false);
});

function boot(extra: Record<string, string>) {
  // Only PATH/HOME/TMPDIR plus the switch under test: the guard must stop the process before anything else loads.
  return spawnSync(tsx, ['src/index.ts'], {
    cwd: serverDir,
    env: { PATH: process.env.PATH!, HOME: process.env.TMPDIR!, TMPDIR: process.env.TMPDIR!, ...extra },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('server refuses to boot in production with a test switch set', () => {
  const r = boot({ NODE_ENV: 'production', GROK_TEST_NO_SCREEN: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to start/i);
  assert.match(r.stderr, /GROK_TEST_NO_SCREEN/);
});

test('server refuses to boot with the callback log set outside test mode', () => {
  const r = boot({ GROK_CALLBACK_LOG: '/dev/null' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /GROK_CALLBACK_LOG/);
});

test('server refuses to boot with a wildcard bridge listener', () => {
  const r = boot({ GROK_BRIDGE_PORT: '9911', GROK_BRIDGE_HOST: '0.0.0.0' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /GROK_BRIDGE_HOST/);
});
