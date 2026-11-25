import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-slots-'));
process.env.XAI_API_KEY = 'test';
process.env.COMPOSIO_API_KEY = 'test';
process.env.SESSION_SECRET = 'test';
process.env.COMPUTER_PROVIDER = 'local';
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.BH_MAX_CONCURRENT = '2';

const { withTurnSlot } = await import('../src/harness.js');

const tick = () => new Promise((r) => setTimeout(r, 20));

async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick(); }
  throw new Error(`never became true: ${label}`);
}

/** Let every turn finish, including ones that only start after an earlier one releases. */
async function drain(releases: (() => void)[]) {
  for (let idle = 0, i = 0; i < 60 && idle < 3; i++) {
    if (releases.length) { releases.shift()!(); idle = 0; } else idle++;
    await tick();
  }
}

test('a harness runs at most BH_MAX_CONCURRENT turns and the rest wait their place', async () => {
  let started = 0;
  let running = 0;
  let peak = 0;
  const releases: (() => void)[] = [];
  const turn = () => withTurnSlot('codex', new AbortController().signal, async () => {
    started += 1;
    running += 1;
    peak = Math.max(peak, running);
    await new Promise<void>((r) => releases.push(r));
    running -= 1;
  });

  const turns = [turn(), turn(), turn(), turn()];
  await until(() => started === 2, 'two turns running');
  await tick();
  assert.equal(running, 2, 'two of four turns are inside the cap');
  assert.equal(started, 2, 'the third turn waits');

  releases.shift()!();
  await until(() => started === 3, 'third turn started');
  assert.equal(running, 2, 'a finished turn hands its slot to the next waiter');

  await drain(releases);
  await Promise.all(turns);
  assert.equal(peak, 2, 'the cap never broke');
});

test('an aborted queued turn gives its place back instead of leaking a slot', async () => {
  const releases: (() => void)[] = [];
  const first = withTurnSlot('claude', new AbortController().signal, () => new Promise<void>((r) => releases.push(r)));
  const third = withTurnSlot('claude', new AbortController().signal, () => new Promise<void>((r) => releases.push(r)));
  const queuedCtl = new AbortController();
  const queued = withTurnSlot('claude', queuedCtl.signal, () => new Promise<void>(() => {}));
  await until(() => releases.length === 2, 'two claude turns running');

  queuedCtl.abort();
  await assert.rejects(queued, /interrupted/);

  let started = 0;
  const late = withTurnSlot('claude', new AbortController().signal, () => {
    started += 1;
    return new Promise<void>((r) => releases.push(r));
  });
  await drain(releases);
  await Promise.all([first, third, late]);
  assert.equal(started, 1, 'the freed slot went to the next queued turn');
});

test('BH_MAX_CONCURRENT=0 turns the cap off', async () => {
  process.env.BH_MAX_CONCURRENT = '0';
  try {
    let started = 0;
    const releases: (() => void)[] = [];
    const turn = () => withTurnSlot('pi', new AbortController().signal, () => {
      started += 1;
      return new Promise<void>((r) => releases.push(r));
    });
    const turns = [turn(), turn(), turn()];
    await until(() => started === 3, 'three uncapped turns running');
    await drain(releases);
    await Promise.all(turns);
  } finally {
    process.env.BH_MAX_CONCURRENT = '2';
  }
});
