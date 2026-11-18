/**
 * Operator tool for Grok Bot callbacks. Reads/writes only the grok_outbox and grok_alert_drafts tables.
 *
 *   cd server && node --env-file=../.env dist/grok-outbox-cli.js status
 *   cd server && node --env-file=../.env dist/grok-outbox-cli.js redrive 12 13     # specific dead rows
 *   cd server && node --env-file=../.env dist/grok-outbox-cli.js redrive --all-dead
 *   cd server && node --env-file=../.env dist/grok-outbox-cli.js alerts           # drafted alerts (never sent)
 *
 * Message bodies are not printed (they can quote bot output). The running server's worker picks redriven rows
 * up on its next tick; nothing here contacts the webhook itself.
 */
import './grok-guard.js';
import { db } from './db.js';
import './grok-db.js';
import { redriveDead } from './grok-notify.js';

const [cmd, ...args] = process.argv.slice(2);
const iso = (t: number | null) => (t ? new Date(t).toISOString() : '-');

if (cmd === 'status') {
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM grok_outbox GROUP BY status ORDER BY status').all() as any[]) console.log(`${r.status}\t${r.n}`);
  for (const r of db.prepare("SELECT id,job_id,event,attempts,redrives,dead_at FROM grok_outbox WHERE status='dead' ORDER BY id").all() as any[]) {
    console.log(`dead #${r.id}\tjob=${r.job_id}\tevent=${r.event}\tattempts=${r.attempts}\tredrives=${r.redrives}\tdead_at=${iso(r.dead_at)}`);
  }
} else if (cmd === 'redrive') {
  const ids = args.includes('--all-dead') ? 'all' : args.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (ids !== 'all' && !ids.length) { console.error('usage: redrive <outbox id...> | --all-dead'); process.exit(2); }
  console.log(`redriven ${redriveDead(ids)}`);
} else if (cmd === 'alerts') {
  for (const r of db.prepare('SELECT id,created_at,kind,dead_count,status,body FROM grok_alert_drafts ORDER BY id DESC LIMIT 20').all() as any[]) {
    console.log(`#${r.id}\t${iso(r.created_at)}\t${r.kind}\tdead=${r.dead_count}\t${r.status}\n  ${r.body}`);
  }
} else {
  console.error('usage: grok-outbox-cli status | redrive <id...>|--all-dead | alerts');
  process.exit(2);
}
