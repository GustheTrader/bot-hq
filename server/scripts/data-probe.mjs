// Live check of the data_* tools over /mcp/<primary bot>. Run from server/: node --env-file=../.env scripts/data-probe.mjs "<query>"
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
const db = new Database(new URL('../../data/grokbot.db', import.meta.url).pathname, { readonly: true });
const bot = db.prepare("SELECT id,name,engine FROM bots ORDER BY engine='primary' DESC LIMIT 1").get();
const tok = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`mcp:${bot.id}`).digest('hex');
let id = 0;
async function rpc(method, params) {
  const t = Date.now();
  const r = await fetch(`http://127.0.0.1:8797/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await r.json(); j.ms = Date.now() - t; return j;
}
const call = async (name, args) => { const j = await rpc('tools/call', { name, arguments: args }); return { ms: j.ms, out: JSON.parse(j.result.content[0].text) }; };
console.log('bot', bot.name, bot.engine);
const list = await rpc('tools/list', {});
console.log('data tools:', list.result.tools.map(t => t.name).filter(n => n.startsWith('data_')));
const s = await call('data_search', { query: process.argv[2] ?? 'what did we decide about the ORNN model bias', k: 5 });
console.log('search ms', s.ms, 'catalog_age', s.out.catalog_age_seconds);
for (const r of s.out.results) console.log(' ', r.score, r.engines.join('+'), r.uri, '|', r.snippet.slice(0, 110));
const g = await call('data_grep', { pattern: 'xfail', uri: 'fs://workspace/Projects/ornn-sme/', glob: '*.md', literal: true, max_hits: 3 });
console.log('grep ms', g.ms, g.out.hits.map(h => `${h.uri}:${h.line} ${h.text.slice(0, 120)}`));
const h = g.out.hits[0];
if (h) { const rd = await call('data_read', { uri: h.uri, start: h.line, end: h.line + 1 }); console.log('read ms', rd.ms, rd.out.hash.slice(0, 20), rd.out.mtime, '\n', rd.out.content.slice(0, 300)); }
console.log('secret:', (await call('data_read', { uri: 'fs://workspace/Projects/gridiron-picks/.picks.env' })).out);
console.log('escape:', (await call('data_read', { uri: '/etc/shadow' })).out);
console.log('roots:', JSON.stringify((await call('data_list', {})).out));
