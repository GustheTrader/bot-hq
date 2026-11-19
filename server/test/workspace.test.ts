import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-db-')), 'test.db');
process.env.XAI_API_KEY = 'test';
process.env.COMPOSIO_API_KEY = 'test';
process.env.COMPUTER_PROVIDER = 'local';
process.env.SESSION_SECRET = 'test-secret';
process.env.ORGO_API_KEY = 'test';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')));
const projects = path.join(base, 'Projects');
fs.mkdirSync(projects);
process.env.CODE_ROOTS = base;
process.env.WORKSPACE_PROJECTS_DIR = projects;

const W = await import('../src/workspace.js');
type Runner = import('../src/code-workspace.js').Runner;

test('checkName refuses path tricks and accepts ordinary names', () => {
  assert.equal(W.checkName(' Pricing Lab '), 'Pricing Lab');
  for (const bad of ['../x', 'a/b', '.hidden', 'x..y', '', 'trail.', 'semi;colon']) assert.throws(() => W.checkName(bad), /short folder name/);
});

test('createFolder makes a new folder inside the projects folder and refuses an existing one', () => {
  const p = W.createFolder('fresh-one');
  assert.equal(p, path.join(projects, 'fresh-one'));
  assert.ok(fs.statSync(p).isDirectory());
  assert.throws(() => W.createFolder('fresh-one'), /already exists/);
});

test('parseRepo reads owner/name, web and SSH addresses', () => {
  assert.deepEqual(W.parseRepo('octocat/hello-world'), { owner: 'octocat', name: 'hello-world' });
  assert.deepEqual(W.parseRepo('https://github.com/GustheTrader/bot-hq.git'), { owner: 'GustheTrader', name: 'bot-hq' });
  assert.deepEqual(W.parseRepo('git@github.com:a-b/c.d'), { owner: 'a-b', name: 'c.d' });
  for (const bad of ['', 'nope', 'https://evil.com/a/b', 'a/b/c', 'a/..', '-x/y']) assert.throws(() => W.parseRepo(bad), /owner\/name/);
});

test('cloneRepo runs gh with an argument list into a new folder, and explains a refused repo', async () => {
  const calls: string[][] = [];
  const ok: Runner = (file, args, _o, cb) => { calls.push([file, ...args]); cb(null, '', ''); };
  const p = await W.cloneRepo('octocat/hello-world', undefined, ok);
  assert.equal(p, path.join(projects, 'hello-world'));
  assert.deepEqual(calls[0], ['gh', 'repo', 'clone', 'octocat/hello-world', p]);
  const denied: Runner = (_f, _a, _o, cb) => cb(new Error('x'), '', 'GraphQL: Could not resolve to a Repository (repository)\nmore');
  await assert.rejects(W.cloneRepo('octocat/missing', undefined, denied), /Could not clone it: GraphQL/);
  fs.mkdirSync(path.join(projects, 'taken'));
  await assert.rejects(W.cloneRepo('octocat/taken', undefined, ok), /already exists/);
});

test('checkBranch keeps git-safe names only', () => {
  assert.equal(W.checkBranch('feature/login'), 'feature/login');
  for (const bad of ['-x', 'a..b', 'a//b', 'a/', 'a.lock', 'has space', '']) assert.throws(() => W.checkBranch(bad), /branch name/);
});

test('addWorktree adds a sibling worktree, and falls back to an existing branch', async () => {
  const repo = path.join(base, 'Projects', 'app');
  fs.mkdirSync(repo);
  const calls: string[][] = [];
  const first: Runner = (file, args, _o, cb) => { calls.push([file, ...args]); cb(null, '', ''); };
  const p = await W.addWorktree(repo, 'feat/login', 'main', first);
  assert.equal(p, `${repo}-feat-login`);
  assert.deepEqual(calls[0], ['git', '-C', repo, 'worktree', 'add', '-b', 'feat/login', p, 'main']);
  const seen: string[][] = [];
  const exists: Runner = (file, args, _o, cb) => { seen.push([file, ...args]); if (args.includes('-b')) cb(new Error('x'), '', "fatal: a branch named 'dev' already exists"); else cb(null, '', ''); };
  const p2 = await W.addWorktree(repo, 'dev', undefined, exists);
  assert.deepEqual(seen[1], ['git', '-C', repo, 'worktree', 'add', p2, 'dev']);
  await assert.rejects(W.addWorktree(path.join(os.tmpdir()), 'x', undefined, first), /outside the workspace/);
});

test('githubStatus reads the account and never the token', async () => {
  const signed: Runner = (_f, _a, _o, cb) => cb(null, '', 'github.com\n  ✓ Logged in to github.com account GustheTrader (/root/.config/gh/hosts.yml)\n  - Token: gho_secret');
  assert.deepEqual(await W.githubStatus(signed), { installed: true, signedIn: true, account: 'GustheTrader' });
  const out: Runner = (_f, _a, _o, cb) => cb(new Error('x'), '', 'You are not logged into any GitHub hosts. To log in, run: gh auth login');
  assert.deepEqual(await W.githubStatus(out), { installed: true, signedIn: false, account: null });
  const missing: Runner = (_f, _a, _o, cb) => cb(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }), '', '');
  assert.deepEqual(await W.githubStatus(missing), { installed: false, signedIn: false, account: null });
});

test('terminalCommand runs OpenCode or a shell in the quoted folder', () => {
  const q = (s: string) => `'${s.replace(/'/g, `'\''`)}'`;
  assert.equal(W.terminalCommand("/w/it's", 'opencode', q), `cd '/w/it'\''s' && opencode`);
  assert.equal(W.terminalCommand('/w/a', 'shell', q), `cd '/w/a' && exec bash -l`);
});

test('resolveShowPath allows files in the workspace or the bot library, nothing else', () => {
  const f = path.join(projects, 'fresh-one', 'DESIGN.md');
  fs.writeFileSync(f, '# hi');
  assert.deepEqual(W.resolveShowPath(f, 'bot_x'), { real: f, isDir: false });
  if (process.platform !== 'win32') assert.equal(W.resolveShowPath(`file://${f}`, 'bot_x').real, f); // file:// paths are POSIX
  const lib = path.join(base, 'lib');
  fs.mkdirSync(path.join(lib, 'bot_x'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'bot_x', 'r.txt'), 'x');
  assert.equal(W.resolveShowPath(path.join(lib, 'bot_x', 'r.txt'), 'bot_x', lib).real, path.join(lib, 'bot_x', 'r.txt'));
  assert.throws(() => W.resolveShowPath(os.homedir(), 'bot_x', lib), /outside/);
  assert.throws(() => W.resolveShowPath('relative/x.md', 'bot_x'), /not a file/);
  assert.throws(() => W.resolveShowPath(path.join(projects, 'nope.md'), 'bot_x'), /not on the computer/);
});
