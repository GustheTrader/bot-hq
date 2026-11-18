import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { GROK_TEST_MODE } from './grok-guard.js';
import { db, now } from './db.js';
import './grok-db.js';

/**
 * Callback delivery to Grok Bot from the grok_outbox table (at least once; the receiver dedupes on the task id
 * `jobId:event:outboxId`, passed as thoth-notify's second argument).
 *
 * Retry schedule after each failure, each with ±20% jitter: 30s, 2m, 10m, 30m, 1h, 3h, 6h, 6h, 6h (about 23h
 * in total). The 10th failed attempt marks the row dead. Dead rows are counted on every sweep, an alert is
 * drafted (never sent) when the count rises, and `grok-outbox-cli redrive` puts them back in the queue.
 */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000, 21_600_000, 21_600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const NOTIFY_BIN = '/usr/local/bin/thoth-notify';

export type OutboxRow = { id: number; job_id: string; event: string; message: string; attempts: number };
type Delivery = (row: OutboxRow) => Promise<void>;

export async function deliverCallbacks(send: Delivery, clock = Date.now(), rand: () => number = Math.random) {
  const rows = db.prepare("SELECT * FROM grok_outbox WHERE status='pending' AND next_at<=? ORDER BY id LIMIT 20").all(clock) as OutboxRow[];
  for (const r of rows) {
    try {
      await send(r);
      db.prepare("UPDATE grok_outbox SET status='delivered',attempts=attempts+1,delivered_at=?,last_error=NULL WHERE id=? AND status='pending'").run(clock, r.id);
    } catch {
      const n = r.attempts + 1;
      if (n >= MAX_ATTEMPTS) {
        db.prepare("UPDATE grok_outbox SET status='dead',attempts=?,dead_at=?,last_error='delivery failed' WHERE id=? AND status='pending'").run(n, clock, r.id);
      } else {
        const wait = Math.round(RETRY_DELAYS_MS[n - 1] * (0.8 + 0.4 * rand()));
        db.prepare("UPDATE grok_outbox SET attempts=?,next_at=?,last_error='delivery failed' WHERE id=? AND status='pending'").run(n, clock + wait, r.id);
      }
    }
  }
}

/** Real delivery: thoth-notify must print a 2xx status. The test-only log/stub switches are refused at boot outside tests. */
export async function sendConfigured(row: OutboxRow) {
  if (GROK_TEST_MODE && process.env.GROK_CALLBACK_LOG) {
    fs.appendFileSync(process.env.GROK_CALLBACK_LOG, JSON.stringify({ id: row.id, task: `${row.job_id}:${row.event}:${row.id}`, message: row.message, at: Date.now() }) + '\n', { mode: 0o600 });
    return;
  }
  if (process.env.GROK_CALLBACK_ENABLED !== '1') throw new Error('disabled');
  const bin = GROK_TEST_MODE && process.env.GROK_NOTIFY_BIN ? process.env.GROK_NOTIFY_BIN : NOTIFY_BIN;
  await new Promise<void>((resolve, reject) =>
    execFile(bin, [row.message, `${row.job_id}:${row.event}:${row.id}`], { timeout: 25_000 }, (error, stdout) => {
      if (error || !/^2\d\d\s*$/.test(String(stdout))) reject(new Error('delivery failed'));
      else resolve();
    }),
  );
}

/** Put dead rows back in the queue (all of them, or the given ids). Returns how many moved. */
export function redriveDead(ids: number[] | 'all', clock = now()): number {
  const sql = "UPDATE grok_outbox SET status='pending',attempts=0,next_at=?,dead_at=NULL,last_error=NULL,redrives=redrives+1 WHERE status='dead'";
  if (ids === 'all') return db.prepare(sql).run(clock).changes;
  let n = 0;
  for (const id of ids) n += db.prepare(`${sql} AND id=?`).run(clock, id).changes;
  return n;
}

/** Count dead rows; when the count rose since the last draft, write a new alert draft. Nothing is sent. */
export function checkDeadLetters(clock = now()): { dead: number; drafted: boolean } {
  const dead = (db.prepare("SELECT COUNT(*) n FROM grok_outbox WHERE status='dead'").get() as any).n as number;
  const last = (db.prepare("SELECT dead_count FROM grok_alert_drafts WHERE kind='dead_letter' ORDER BY id DESC LIMIT 1").get() as any)?.dead_count ?? 0;
  if (dead === 0 || dead <= last) return { dead, drafted: false };
  const oldest = db.prepare("SELECT job_id,event,dead_at FROM grok_outbox WHERE status='dead' ORDER BY dead_at ASC LIMIT 1").get() as any;
  const body = `DRAFT (not sent): ${dead} Grok Bot callback(s) failed for ~24h and are dead-lettered. Oldest: job ${oldest.job_id} (${oldest.event}). ` +
    'Check the webhook, then run: cd server && node --env-file=../.env dist/grok-outbox-cli.js redrive --all-dead';
  db.prepare("INSERT INTO grok_alert_drafts(created_at,kind,dead_count,body) VALUES (?,'dead_letter',?,?)").run(clock, dead, body);
  console.warn(`[grok callback] ${dead} dead-lettered callback(s); alert drafted (not sent)`);
  return { dead, drafted: true };
}

let busy = false;
export function startGrokCallbacks() {
  if (!(GROK_TEST_MODE && process.env.GROK_CALLBACK_LOG) && process.env.GROK_CALLBACK_ENABLED !== '1') {
    console.log('[grok callback] delivery off (GROK_CALLBACK_ENABLED is not 1); callbacks stay queued in grok_outbox');
    return;
  }
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await deliverCallbacks(sendConfigured); } catch { console.error('[grok callback] worker error'); } finally { busy = false; }
  };
  void tick();
  setInterval(() => void tick(), 1000).unref();
}
