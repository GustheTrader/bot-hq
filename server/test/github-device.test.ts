import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const D = await import('../src/github-device.js');

/** A stand-in for the gh process: we write its output and decide how it exits. */
function fakeGh() {
  const proc = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => void };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.kill = () => proc.emit('exit', 1);
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => { calls.push({ cmd, args, env: opts.env }); return proc as any; };
  return { proc, spawn, calls };
}

test('parseDeviceCode finds the one-time code', () => {
  assert.equal(D.parseDeviceCode('! First copy your one-time code: 1A2B-3C4D\nPress Enter to open github.com'), '1A2B-3C4D');
  assert.equal(D.parseDeviceCode('nothing here'), null);
});

test('startDeviceLogin hands back the code, then reports done after gh exits cleanly', async () => {
  const { proc, spawn, calls } = fakeGh();
  let setup = 0;
  const p = D.startDeviceLogin(spawn as any, async () => { setup++; });
  proc.stderr.write('! First copy your one-time code: ABCD-1234\n');
  assert.deepEqual(await p, { code: 'ABCD-1234', url: D.DEVICE_URL });
  assert.equal(calls[0].cmd, 'gh');
  assert.deepEqual(calls[0].args, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web']);
  assert.equal(calls[0].env.GH_BROWSER, 'true');
  assert.equal(D.deviceStatus().state, 'waiting');
  // A second start while waiting returns the same code instead of a new process.
  assert.deepEqual(await D.startDeviceLogin(spawn as any), { code: 'ABCD-1234', url: D.DEVICE_URL });
  assert.equal(calls.length, 1);
  proc.stderr.write('✓ Logged in as GustheTrader\n');
  proc.emit('exit', 0);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(D.deviceStatus(), { state: 'done', account: 'GustheTrader' });
  assert.equal(setup, 1);
});

test('a gh that is missing or quits early is reported, not hung on', async () => {
  const a = fakeGh();
  const pa = D.startDeviceLogin(a.spawn as any);
  a.proc.emit('error', Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(pa, /not installed/);
  const b = fakeGh();
  const pb = D.startDeviceLogin(b.spawn as any);
  b.proc.stderr.write('error connecting to api.github.com\n');
  b.proc.emit('exit', 1);
  await assert.rejects(pb, /error connecting/);
  assert.equal(D.deviceStatus().state, 'error');
});
