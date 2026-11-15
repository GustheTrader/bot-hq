// Phase 0 eval: 20 questions (10 answerable, 10 not) against the live data_* tools over /mcp/<bot>.
// Run from server/: node --env-file=../.env scripts/eval-data-plane.mjs [--bot <id>] [--json]
// Scores top-3 uri accuracy, quote accuracy, p50/p95 latency, payload tokens, and score separation
// between the answerable and unanswerable halves (which is what an abstain threshold would key on).
import crypto from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const asJson = args.includes('--json');
const QFILE = new URL('../../experiments/eval/data-plane-questions.jsonl', import.meta.url).pathname;

const db = new Database(new URL('../../data/grokbot.db', import.meta.url).pathname, { readonly: true });
const bot = flag('--bot')
  ? db.prepare('SELECT id,name,engine FROM bots WHERE id=?').get(flag('--bot'))
  : db.prepare("SELECT id,name,engine FROM bots ORDER BY engine='primary' DESC LIMIT 1").get();
if (!bot) throw new Error('no bot');
const tok = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`mcp:${bot.id}`).digest('hex');

let id = 0;
async function rpc(method, params) {
  const t = Date.now();
  const r = await fetch(`http://127.0.0.1:8797/mcp/${bot.id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return { ms: Date.now() - t, result: j.result };
}
const call = async (name, a) => {
  const r = await rpc('tools/call', { name, arguments: a });
  const text = r.result.content?.[0]?.text ?? '{}';
  return { ms: r.ms, out: JSON.parse(text), chars: text.length };
};

const questions = fs.readFileSync(QFILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const rows = [];
let defsBad = 0;

for (const q of questions) {
  const s = await call('data_search', { query: q.question, k: 8 });
  const res = s.out.results ?? [];
  const uris = res.map((r) => r.uri);
  const row = {
    id: q.id, kind: q.kind, question: q.question, ms: s.ms, tokens: Math.round(s.chars / 4),
    best_score: res[0]?.score ?? 0, confidence: s.out.confidence ?? null,
    best_coverage: res.reduce((m, r) => Math.max(m, r.coverage ?? 0), 0),
    top1: uris[0] ?? null, top3: uris.slice(0, 3),
  };
  if (q.kind === 'answerable') {
    // The question definition must be true before it can score anything.
    const def = await call('data_read', { uri: q.expect_uri, max_tokens: 32000 });
    const defOk = !def.out.error && String(def.out.content ?? '').includes(q.expect_string);
    if (!defOk) { defsBad++; row.definition_error = `expect_string not in ${q.expect_uri}`; }
    row.rank = uris.indexOf(q.expect_uri) + 1;
    row.top3_hit = row.rank > 0 && row.rank <= 3;
    row.top1_hit = row.rank === 1;
    // Quote accuracy: does the expected string appear in any of the top-3 files a bot would read?
    row.quote_hit = false;
    for (const u of uris.slice(0, 3)) {
      const r = await call('data_read', { uri: u, max_tokens: 32000 });
      if (!r.out.error && String(r.out.content ?? '').includes(q.expect_string)) { row.quote_hit = true; row.quote_uri = u; break; }
    }
  }
  rows.push(row);
  if (!asJson) {
    const tag = q.kind === 'answerable'
      ? `${row.top3_hit ? 'HIT ' : 'MISS'} rank=${row.rank} quote=${row.quote_hit ? 'y' : 'n'}`
      : `best=${row.best_score.toFixed(4)} conf=${row.confidence} cov=${row.best_coverage}`;
    console.log(`${q.id} ${String(row.ms).padStart(4)}ms ${String(row.tokens).padStart(5)}tok ${tag}  ${q.question.slice(0, 58)}`);
  }
}

const ans = rows.filter((r) => r.kind === 'answerable');
const un = rows.filter((r) => r.kind === 'unanswerable');
const all = rows;
const summary = {
  bot: `${bot.name} (${bot.engine})`,
  questions: rows.length,
  definition_errors: defsBad,
  top1_accuracy: +(ans.filter((r) => r.top1_hit).length / ans.length).toFixed(3),
  top3_accuracy: +(ans.filter((r) => r.top3_hit).length / ans.length).toFixed(3),
  quote_accuracy: +(ans.filter((r) => r.quote_hit).length / ans.length).toFixed(3),
  // Abstain: does `confidence` separate the halves? answerable should not be 'none', unanswerable should be.
  abstain: {
    answerable_not_none: +(ans.filter((r) => r.confidence !== 'none').length / ans.length).toFixed(3),
    unanswerable_none: +(un.filter((r) => r.confidence === 'none').length / un.length).toFixed(3),
    accuracy: +((ans.filter((r) => r.confidence !== 'none').length + un.filter((r) => r.confidence === 'none').length) / rows.length).toFixed(3),
  },
  latency_ms: { p50: pct(all.map((r) => r.ms), 50), p95: pct(all.map((r) => r.ms), 95) },
  tokens: { mean: Math.round(all.reduce((a, r) => a + r.tokens, 0) / all.length), p95: pct(all.map((r) => r.tokens), 95) },
  score_answerable: { min: +Math.min(...ans.map((r) => r.best_score)).toFixed(4), median: +pct(ans.map((r) => r.best_score), 50).toFixed(4) },
  score_unanswerable: { max: +Math.max(...un.map((r) => r.best_score)).toFixed(4), median: +pct(un.map((r) => r.best_score), 50).toFixed(4) },
  // A threshold that separates the halves, if one exists.
  abstain_threshold: (() => {
    const lo = Math.max(...un.map((r) => r.best_score));
    const hi = Math.min(...ans.map((r) => r.best_score));
    return hi > lo ? +((hi + lo) / 2).toFixed(4) : null;
  })(),
};
if (asJson) console.log(JSON.stringify({ summary, rows }, null, 2));
else {
  console.log('\n' + JSON.stringify(summary, null, 2));
  const misses = ans.filter((r) => !r.top3_hit);
  if (misses.length) console.log('\nmisses:', misses.map((m) => `${m.id} rank=${m.rank} ${m.question}`).join('\n        '));
}
