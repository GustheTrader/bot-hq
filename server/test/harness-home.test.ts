import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-home-'));
process.env.XAI_API_KEY = 'test';
process.env.COMPOSIO_API_KEY = 'test';
process.env.SESSION_SECRET = 'test';
process.env.COMPUTER_PROVIDER = 'local';
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.BH_HOME_ROOT = path.join(tmp, 'homes');
// A stand-in for the signed-in root config, so the test does not need real credentials.
const shared = path.join(tmp, 'shared');
for (const dir of ['codex', 'claude', 'pi']) fs.mkdirSync(path.join(shared, dir), { recursive: true });
fs.writeFileSync(path.join(shared, 'codex', 'auth.json'), '{"token":"x"}');
fs.writeFileSync(path.join(shared, 'claude', '.credentials.json'), '{"token":"x"}');
fs.writeFileSync(path.join(shared, 'pi', 'auth.json'), '{"token":"x"}');
fs.mkdirSync(path.join(shared, 'pi', 'skills'), { recursive: true });
fs.writeFileSync(path.join(shared, 'claude.json'), '{}');
fs.writeFileSync(path.join(shared, '.gitconfig'), '[user]\n\temail = jeffgus@gmail.com\n');
process.env.HOME = shared;
process.env.CODEX_HOME = path.join(shared, 'codex');
process.env.CLAUDE_CONFIG_DIR = path.join(shared, 'claude');
process.env.PI_CODING_AGENT_DIR = path.join(shared, 'pi');

const { botEnvDirs } = await import('../src/harness.js');

test('each bot gets its own home and config dirs', () => {
  const a = botEnvDirs('bot_a');
  const b = botEnvDirs('bot_b');
  assert.notEqual(a.HOME, b.HOME);
  assert.notEqual(a.CLAUDE_CONFIG_DIR, b.CLAUDE_CONFIG_DIR);
  assert.ok(a.HOME.startsWith(path.join(tmp, 'homes')));
  for (const d of Object.values(a)) assert.ok(fs.statSync(d).isDirectory(), `${d} is not a directory`);
});

test('credentials are symlinked in, not copied, and sessions stay private', () => {
  const a = botEnvDirs('bot_a');
  const auth = path.join(a.CLAUDE_CONFIG_DIR, '.credentials.json');
  assert.ok(fs.lstatSync(auth).isSymbolicLink());
  assert.equal(fs.readFileSync(auth, 'utf8'), '{"token":"x"}');
  const piSkills = path.join(a.PI_CODING_AGENT_DIR, 'skills');
  assert.ok(fs.lstatSync(piSkills).isSymbolicLink());
  const gitconfig = path.join(a.HOME, '.gitconfig');
  assert.ok(fs.lstatSync(gitconfig).isSymbolicLink(), 'git identity is linked into the bot home');
  // Transcript dirs are not shared.
  assert.ok(!fs.existsSync(path.join(a.CLAUDE_CONFIG_DIR, 'projects')));
  assert.ok(!fs.existsSync(path.join(a.HOME, '.claude')));
});

test('BH_BOT_HOME=shared restores one shared config set', async () => {
  process.env.BH_BOT_HOME = 'shared';
  const mod = await import(`../src/harness.js?shared=${Date.now()}`);
  assert.deepEqual(mod.botEnvDirs('bot_c'), {});
  delete process.env.BH_BOT_HOME;
});
