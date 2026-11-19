import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-db-')), 'test.db');
process.env.XAI_API_KEY = 'test';
process.env.COMPOSIO_API_KEY = 'test';
process.env.COMPUTER_PROVIDER = 'local';
process.env.SESSION_SECRET = 'test-secret';
process.env.ORGO_API_KEY = 'test';

const { screensToSleep } = await import('../src/screen-sleep.js');

const MIN = 60_000;
const base = { now: 100 * MIN, idleMs: 20 * MIN, startedAt: 0, turnActive: () => false, viewers: () => 0, lastWatched: () => 0 };
const s = (botId: string, idleMin: number, asleep = false) => ({ botId, lastUsedAt: base.now - idleMin * MIN, asleep });

test('a screen unused for the idle time goes to sleep; a recently used one does not', () => {
  assert.deepEqual(screensToSleep([s('a', 25), s('b', 5)], base), ['a']);
});

test('a running turn or a viewer keeps a screen awake', () => {
  assert.deepEqual(screensToSleep([s('a', 60), s('b', 60)], { ...base, turnActive: (id) => id === 'a', viewers: (id) => (id === 'b' ? 1 : 0) }), []);
});

test('a viewer who just left counts as use', () => {
  assert.deepEqual(screensToSleep([s('a', 60)], { ...base, lastWatched: () => base.now - 2 * MIN }), []);
});

test('nothing sleeps sooner than the idle time after a restart, and asleep screens are skipped', () => {
  assert.deepEqual(screensToSleep([s('a', 60)], { ...base, startedAt: base.now - 5 * MIN }), []);
  assert.deepEqual(screensToSleep([s('a', 60, true)], base), []);
});

test('an idle time of 0 turns sleep off', () => {
  assert.deepEqual(screensToSleep([s('a', 600)], { ...base, idleMs: 0 }), []);
});

test('markSleepingScreens marks leased screens whose display is down, and leaves running ones', async () => {
  const { db } = await import('../src/db.js');
  const C = await import('../src/computer.js');
  const now = Date.now();
  db.prepare("INSERT OR IGNORE INTO users(id,email,name,created_at) VALUES ('u1','u1@test','U',?)").run(now);
  db.prepare('INSERT OR REPLACE INTO screens(bot_id,user_id,screen_id,last_used_at) VALUES (?,?,?,?),(?,?,?,?)').run('bot_up', 'u1', 'screen-100', now, 'bot_down', 'u1', 'screen-101', now);
  const marked = await C.markSleepingScreens(async (id) => id === 'screen-100');
  assert.deepEqual(marked, ['bot_down']);
  const screens = C.computerState('u1').screens;
  assert.equal(screens.find((s) => s.botId === 'bot_down')?.asleep, true);
  assert.equal(screens.find((s) => s.botId === 'bot_up')?.asleep, undefined);
  assert.deepEqual(await C.markSleepingScreens(async () => false), ['bot_up']); // already-marked ones are skipped
});
