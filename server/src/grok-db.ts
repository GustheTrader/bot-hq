import './grok-guard.js';
import { db, now } from './db.js';

/**
 * Storage for the Grok Bot bridge. Single HQ process assumed (see REPORT.md): there is no cross-process lease.
 *
 * grok_jobs         one row per job; status: queued | running | needs_input | completed | failed | interrupted | cancelled
 * grok_outbox       callbacks to Grok Bot, written in the same transaction as the job transition they report
 * grok_audit        every authenticated bridge request (never the key itself: key_id is a hash prefix)
 * grok_auth_fail    failed key attempts per peer address, bounded to one row per address
 * grok_alert_drafts dead-letter alerts drafted for a human to send; nothing here is ever sent automatically
 */
db.exec(`CREATE TABLE IF NOT EXISTS grok_jobs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, bot_id TEXT NOT NULL, generation INTEGER NOT NULL,
 title TEXT NOT NULL, source_ref TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
 started_at INTEGER, finished_at INTEGER, steps INTEGER NOT NULL DEFAULT 0, last_step TEXT, final_reply TEXT
)`);
function addColumns(table: string, wanted: [string, string][]) {
  const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((x) => x.name));
  for (const [name, type] of wanted) if (!cols.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}
addColumns('grok_jobs', [['pending_text', 'TEXT'], ['payload_hash', 'TEXT'], ['question_seq', 'INTEGER'], ['end_reason', 'TEXT']]);
db.exec(`CREATE INDEX IF NOT EXISTS grok_jobs_bot_status ON grok_jobs(bot_id,status);
CREATE TABLE IF NOT EXISTS grok_outbox (
 id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, event TEXT NOT NULL, message TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
 last_error TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER
);
CREATE TABLE IF NOT EXISTS grok_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, ip TEXT NOT NULL, key_id TEXT, method TEXT NOT NULL,
 route TEXT NOT NULL, bot_id TEXT, source_ref TEXT, job_id TEXT, status INTEGER NOT NULL, reason TEXT
);
CREATE INDEX IF NOT EXISTS grok_audit_at ON grok_audit(at);
CREATE INDEX IF NOT EXISTS grok_audit_method_at ON grok_audit(method,at);
CREATE TABLE IF NOT EXISTS grok_auth_fail (
 ip TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL, total INTEGER NOT NULL, last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grok_alert_drafts (
 id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, kind TEXT NOT NULL, dead_count INTEGER NOT NULL,
 body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft'
);`);
addColumns('grok_outbox', [['dead_at', 'INTEGER'], ['redrives', 'INTEGER NOT NULL DEFAULT 0']]);

/**
 * sourceRef idempotency relies on this unique index. If existing data has duplicates, creating it fails:
 * keep HQ up, log it, and refuse new bridge jobs (503) until the rows are reconciled.
 */
export let grokIndexOk = true;
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS grok_jobs_source ON grok_jobs(user_id,source_ref)');
} catch {
  grokIndexOk = false;
  console.error('[grok bridge] unique sourceRef index could not be created; bridge jobs are disabled until duplicates are reconciled');
}

export const OPEN_STATUSES = ['queued', 'running', 'needs_input'] as const;

/**
 * Callback text: status and the title Grok Bot itself supplied, plus (unless GROK_CALLBACK_POINTER_ONLY=1) a
 * short excerpt of bot output, JSON-quoted and labelled untrusted. The receiver must treat it as data only.
 */
export function callbackText(job: { id: string; title?: string }, status: string, excerpt?: string | null) {
  let msg = `[HQ bridge] job=${job.id} status=${status}`;
  if (job.title) msg += ` title=${JSON.stringify(job.title.slice(0, 80))}`;
  if (excerpt && process.env.GROK_CALLBACK_POINTER_ONLY !== '1') msg += ` untrusted_excerpt=${JSON.stringify(excerpt.replace(/\s+/g, ' ').slice(0, 280))}`;
  return msg.slice(0, 450);
}

export function queueCallback(jobId: string, event: string, message: string) {
  db.prepare('INSERT INTO grok_outbox(job_id,event,message,next_at,created_at) VALUES(?,?,?,?,?)').run(jobId, event, message.replace(/[\r\n]+/g, ' ').slice(0, 450), now(), now());
}

const SETTABLE = new Set(['pending_text', 'question_seq', 'started_at', 'finished_at', 'steps', 'last_step', 'final_reply', 'end_reason']);

/**
 * Move a job between states only if it is still in one of `from`; returns whether it moved. When it moves and
 * `callback` is given, the callback is queued in the same transaction, so a report is never lost, and a racing
 * second transition (a turn ending after a reset already closed the job) changes and reports nothing.
 */
export function transitionJob(id: string, from: readonly string[], to: string, fields: Record<string, unknown> = {}, callback?: { excerpt?: string | null }): boolean {
  for (const k of Object.keys(fields)) if (!SETTABLE.has(k)) throw new Error(`bad field ${k}`);
  return db.transaction(() => {
    const job = db.prepare('SELECT id,title,status FROM grok_jobs WHERE id=?').get(id) as any;
    if (!job || !from.includes(job.status)) return false;
    const sets = ['status=?', ...Object.keys(fields).map((k) => `${k}=?`)];
    db.prepare(`UPDATE grok_jobs SET ${sets.join(',')} WHERE id=?`).run(to, ...Object.values(fields), id);
    if (callback) queueCallback(id, to, callbackText(job, to, callback.excerpt));
    return true;
  })();
}
