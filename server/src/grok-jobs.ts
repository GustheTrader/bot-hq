import { testFlag } from './grok-guard.js';
import { db, now } from './db.js';
import { OPEN_STATUSES, transitionJob } from './grok-db.js';
import { clearPendingQuestion, getBotRow, getLive, getRow, setLive, updateRow } from './store.js';
import { enqueue } from './agent/loop.js';
import { checkDeadLetters } from './grok-notify.js';

/**
 * Lifecycle of bridge jobs outside the turn itself: answers and dismissals from any screen, conversation
 * resets, and a periodic sweep that repairs anything a missed hook left behind.
 */

export function dispatchJob(job: { id: string; bot_id: string; pending_text: string }) {
  if (!testFlag('GROK_TEST_NO_DISPATCH')) enqueue(job.bot_id, { type: 'grok', text: job.pending_text, jobId: job.id });
}

/** Start queued jobs for bots that are not waiting on a question (any question: never consume one). */
export function redispatchQueued(botId?: string): number {
  const rows = (botId
    ? db.prepare("SELECT id,bot_id,pending_text FROM grok_jobs WHERE status='queued' AND pending_text IS NOT NULL AND bot_id=? ORDER BY created_at,rowid").all(botId)
    : db.prepare("SELECT id,bot_id,pending_text FROM grok_jobs WHERE status='queued' AND pending_text IS NOT NULL ORDER BY created_at,rowid").all()) as any[];
  let n = 0;
  for (const j of rows) if (!getLive(j.bot_id).question) { dispatchJob(j); n++; }
  return n;
}

/** The bridge job waiting on this question card, if any (current conversation only). */
export function jobForQuestion(botId: string, seq: number): any | null {
  const bot = getBotRow(botId);
  if (!bot) return null;
  return db.prepare("SELECT * FROM grok_jobs WHERE bot_id=? AND question_seq=? AND status='needs_input' AND generation=?").get(botId, seq, bot.generation) ?? null;
}

/**
 * An answer to a bridge job's question, from the bridge, the HQ card or a typed chat reply. Marks the card
 * answered (if it is not already), requeues the same job with the answer, and starts it. Returns false when
 * the question does not belong to an open bridge job, so the caller runs its normal path.
 */
export function resumeBridgeJob(botId: string, seq: number, answer: string): boolean {
  const job = jobForQuestion(botId, seq);
  if (!job) return false;
  const row = getRow(botId, seq);
  const question = row?.body.type === 'card' && row.body.card === 'question' ? row.body.question : '';
  const text = `[Answer to "${question}"] ${answer}`;
  const moved = db.transaction(() => {
    if (row?.body.type === 'card' && row.body.card === 'question' && row.body.status === 'pending') updateRow(botId, seq, { ...row.body, status: 'answered', answer } as any);
    return transitionJob(job.id, ['needs_input'], 'queued', { pending_text: text, question_seq: null, started_at: null, finished_at: null, steps: 0, last_step: null, final_reply: null });
  })();
  if (!moved) return false;
  clearPendingQuestion(botId, seq);
  dispatchJob({ id: job.id, bot_id: botId, pending_text: text });
  return true;
}

/** The question was dismissed: the job is cancelled (with a callback) and the bot's queue moves on. */
export function cancelBridgeJobForQuestion(botId: string, seq: number, reason = 'question dismissed in HQ'): boolean {
  const job = jobForQuestion(botId, seq);
  if (!job) return false;
  const moved = transitionJob(job.id, ['needs_input'], 'cancelled', { finished_at: now(), end_reason: reason }, { excerpt: reason });
  if (moved) {
    if (getLive(botId).grokJobId === job.id) setLive(botId, { grokJobId: null });
    redispatchQueued(botId);
  }
  return moved;
}

/** Close every open bridge job on a bot (conversation reset, bot removed). Running turns end as no-ops. */
export function interruptOpenJobs(botId: string, reason: string): number {
  const open = db.prepare(`SELECT id FROM grok_jobs WHERE bot_id=? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`).all(botId, ...OPEN_STATUSES) as any[];
  let n = 0;
  for (const j of open) if (transitionJob(j.id, OPEN_STATUSES, 'interrupted', { finished_at: now(), end_reason: reason }, { excerpt: reason })) n++;
  if (n && getLive(botId).grokJobId) setLive(botId, { grokJobId: null });
  return n;
}

/**
 * Repair pass, every minute: close open jobs whose bot or conversation is gone, settle needs_input jobs whose
 * card was answered or dismissed by a path without a hook, start queued work that is free to run, count dead
 * callbacks, and prune old audit rows.
 */
export function sweepGrokJobs(clock = now()) {
  const out = { interrupted: 0, resumed: 0, cancelled: 0, dispatched: 0, dead: 0 };
  // A live "waiting on a question" state whose card is gone or settled (reset, answered elsewhere) is cleared,
  // so it cannot hold queued bridge work back forever.
  for (const b of db.prepare("SELECT id FROM bots WHERE COALESCE(kind,'agent')<>'team'").all() as any[]) {
    const q = getLive(b.id).question;
    if (!q) continue;
    const card = getRow(b.id, q.seq);
    if (!card || card.body.type !== 'card' || card.body.card !== 'question' || card.body.status !== 'pending') clearPendingQuestion(b.id, q.seq);
  }
  const open = db.prepare("SELECT * FROM grok_jobs WHERE status IN ('queued','needs_input')").all() as any[];
  for (const j of open) {
    const bot = getBotRow(j.bot_id);
    if (!bot || bot.hidden || bot.kind === 'team' || bot.generation !== j.generation) {
      if (transitionJob(j.id, ['queued', 'needs_input'], 'interrupted', { finished_at: clock, end_reason: 'bot or conversation changed' }, { excerpt: 'bot or conversation changed' })) out.interrupted++;
      continue;
    }
    if (j.status !== 'needs_input') continue;
    const card = j.question_seq ? getRow(j.bot_id, j.question_seq) : null;
    if (!card || card.body.type !== 'card' || card.body.card !== 'question') {
      if (transitionJob(j.id, ['needs_input'], 'interrupted', { finished_at: clock, end_reason: 'question card missing' }, { excerpt: 'question card missing' })) out.interrupted++;
    } else if (card.body.status === 'answered') {
      if (resumeBridgeJob(j.bot_id, j.question_seq, String((card.body as any).answer ?? ''))) out.resumed++;
    } else if (card.body.status === 'dismissed') {
      if (cancelBridgeJobForQuestion(j.bot_id, j.question_seq)) out.cancelled++;
    }
  }
  out.dispatched = redispatchQueued();
  out.dead = checkDeadLetters(clock).dead;
  if (out.dead) console.warn(`[grok callback] dead-lettered callbacks: ${out.dead}`);
  db.prepare('DELETE FROM grok_audit WHERE at<?').run(clock - 30 * 86_400_000);
  db.prepare('DELETE FROM grok_auth_fail WHERE last_at<?').run(clock - 30 * 86_400_000);
  return out;
}

export function startGrokSweep() {
  const ms = testFlag('GROK_TEST_SWEEP_MS') ? Math.max(200, Number(process.env.GROK_TEST_SWEEP_MS)) : 60_000;
  setInterval(() => { try { sweepGrokJobs(); } catch { console.error('[grok bridge] sweep failed'); } }, ms).unref();
}

/** On boot: running turns may have had effects, so report them interrupted (never replay); then resume the rest. */
export function recoverGrokJobs() {
  for (const j of db.prepare("SELECT id FROM grok_jobs WHERE status='running'").all() as any[]) {
    transitionJob(j.id, ['running'], 'interrupted', { finished_at: now(), end_reason: 'HQ restarted mid-turn; outcome unknown, review before retrying' }, { excerpt: 'HQ restarted mid-turn; outcome unknown, review before retrying' });
  }
  for (const j of db.prepare("SELECT id,bot_id,question_seq FROM grok_jobs WHERE status='needs_input'").all() as any[]) {
    if (getLive(j.bot_id).question?.seq === j.question_seq) setLive(j.bot_id, { grokJobId: j.id });
  }
  sweepGrokJobs();
}
