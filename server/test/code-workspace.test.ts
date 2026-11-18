import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codews-db-')), 'test.db');
process.env.XAI_API_KEY = 'test';
process.env.COMPOSIO_API_KEY = 'test';
process.env.COMPUTER_PROVIDER = 'local';
process.env.SESSION_SECRET = 'test-secret';
process.env.ORGO_API_KEY = 'test';
delete process.env.T3_BIN;

const W = await import('../src/code-workspace.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codews-'));
const root = path.join(base, 'workspace');
const inside = path.join(root, 'Projects', 'pricing');
const outside = path.join(base, 'elsewhere');
fs.mkdirSync(inside, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(root, 'a-file.txt'), 'x');
const real = (p: string) => fs.realpathSync(p);
const status = (n: number) => (e: any) => e.status === n;

test('a folder inside the workspace resolves to its real path', () => {
  assert.equal(W.resolveProjectFolder(inside, [root]), real(inside));
  assert.equal(W.resolveProjectFolder(`  ${inside}  `, [root]), real(inside), 'surrounding spaces are ignored');
  assert.equal(W.resolveProjectFolder(root, [root]), real(root), 'the root itself is allowed');
});

test('an empty, relative, missing or file path is refused with a clear message', () => {
  assert.throws(() => W.resolveProjectFolder('', [root]), /no folder yet/);
  assert.throws(() => W.resolveProjectFolder('   ', [root]), /no folder yet/);
  assert.throws(() => W.resolveProjectFolder('Projects/pricing', [root]), /full path/);
  assert.throws(() => W.resolveProjectFolder('~/Projects', [root]), /full path/);
  assert.throws(() => W.resolveProjectFolder(path.join(root, 'nope'), [root]), status(404));
  assert.throws(() => W.resolveProjectFolder(path.join(root, 'a-file.txt'), [root]), /not a folder/);
});

test('a folder outside the workspace is refused, including by climbing out with ..', () => {
  assert.throws(() => W.resolveProjectFolder(outside, [root]), /outside the workspace/);
  assert.throws(() => W.resolveProjectFolder(path.join(inside, '..', '..', '..', 'elsewhere'), [root]), /outside the workspace/);
  assert.throws(() => W.resolveProjectFolder(os.tmpdir(), [root]), /outside the workspace/);
});

test('a sibling that merely starts with the workspace name is not inside it', () => {
  const sibling = `${root}-evil`;
  fs.mkdirSync(sibling, { recursive: true });
  assert.throws(() => W.resolveProjectFolder(sibling, [root]), /outside the workspace/);
});

test('a symlink inside the workspace that leads outside it is refused', (t) => {
  const link = path.join(root, 'sneaky');
  try { fs.symlinkSync(outside, link, 'dir'); } catch { t.skip('symlinks are not permitted on this machine'); return; }
  assert.throws(() => W.resolveProjectFolder(link, [root]), /outside the workspace/);
});

test('with several allowed roots, any of them will do; a root that does not exist allows nothing', () => {
  assert.equal(W.resolveProjectFolder(outside, [root, outside]), real(outside));
  assert.throws(() => W.resolveProjectFolder(inside, [path.join(base, 'no-such-root')]), /outside the workspace/);
});

test('the newest installed T3 is found by version number, not by name', () => {
  const versions = path.join(base, 'versions');
  for (const v of ['0.1.6', '0.1.10', '0.1.9']) { fs.mkdirSync(path.join(versions, v), { recursive: true }); fs.writeFileSync(path.join(versions, v, 't3'), ''); }
  fs.mkdirSync(path.join(versions, '0.9.0'), { recursive: true }); // a version folder with no binary is ignored
  fs.mkdirSync(path.join(versions, 'latest'), { recursive: true });
  assert.equal(W.findT3Bin(versions), path.join(versions, '0.1.10', 't3'));
  assert.equal(W.findT3Bin(path.join(base, 'no-versions-here')), null);
});

test('T3_BIN overrides the search', () => {
  process.env.T3_BIN = '/opt/custom/t3';
  try { assert.equal(W.findT3Bin(path.join(base, 'versions')), '/opt/custom/t3'); } finally { delete process.env.T3_BIN; }
});

test('adding runs T3 by full path with an argument list: no shell, the folder is one argument', async () => {
  let seen: { file: string; args: string[]; timeout: number } | null = null;
  const run: any = (file: string, args: string[], opts: { timeout: number }, cb: any) => { seen = { file, args, timeout: opts.timeout }; cb(null, 'added', ''); };
  const folder = path.join(root, 'Projects', 'name with spaces; rm -rf');
  const r = await W.addToCode(folder, 'Pricing; echo hi', '/x/t3', run);
  assert.deepEqual(r, { already: false });
  assert.deepEqual(seen, { file: '/x/t3', args: ['project', 'add', folder, '--title', 'Pricing; echo hi'], timeout: 20_000 });
});

test('a folder T3 already has counts as success; other failures say why', async () => {
  const failing = (stderr: string): any => (_f: string, _a: string[], _o: unknown, cb: any) => cb(Object.assign(new Error('exit 1'), { code: 1 }), '', stderr);
  assert.deepEqual(await W.addToCode(inside, 'P', '/x/t3', failing('Error: project already exists at /x')), { already: true });
  await assert.rejects(W.addToCode(inside, 'P', '/x/t3', failing('\nError: the server is not running\nstack...')), (e: any) => e.status === 409 && /Could not add the folder to Code: Error: the server is not running/.test(e.message));
});

test('no T3 installed is a clear error, not a crash', async () => {
  await assert.rejects(W.addToCode(inside, 'P', null), (e: any) => e.status === 409 && /not installed/.test(e.message));
});
