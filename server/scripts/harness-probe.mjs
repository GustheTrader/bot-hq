// Does an ACP harness actually get the app's data tools? One real turn per harness, no bot needed.
// Run from server/: node --env-file=../.env scripts/harness-probe.mjs <codex|claude-code|pi|opencode> ["<prompt>"]
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const HARNESS = {
  codex: ['codex-acp'],
  'claude-code': ['claude-agent-acp'],
  pi: ['pi-acp'],
  opencode: ['opencode', 'acp'],
};
const id = process.argv[2];
const prompt = process.argv[3] ?? 'Use the hq data tools to find where the ORNN model bias is documented, then quote one line. Do not use a shell.';
if (!HARNESS[id]) { console.error('usage: harness-probe.mjs <codex|claude-code|pi|opencode> ["prompt"]'); process.exit(2); }

const db = new Database(new URL('../../data/grokbot.db', import.meta.url).pathname, { readonly: true });
const bot = db.prepare("SELECT id,name FROM bots ORDER BY engine='primary' DESC LIMIT 1").get();
const tok = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`mcp:${bot.id}`).digest('hex');
// Mirror harness.ts: pi-acp accepts mcpServers but never connects them, so Pi is given the app's
// tools through its own .pi/mcp.json (trusted by the pi-trusted wrapper) and handed nothing here.
const slug = bot.engine === 'primary' ? 'primary' : bot.id;
const hqUrl = `http://127.0.0.1:8797/mcp/${slug}`;
const hqTok = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`mcp:${slug}`).digest('hex');
const mcpServers = id === 'pi'
  ? []
  : [{ type: 'http', name: 'hq', url: hqUrl, headers: [{ name: 'Authorization', value: `Bearer ${hqTok}` }] }];
if (id === 'pi') {
  const dir = `/root/grokbot/files/${bot.id}/.pi`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/mcp.json`, JSON.stringify({ mcpServers: { hq: { url: hqUrl, headers: { Authorization: `Bearer ${hqTok}` } } } }, null, 2));
}

const [bin, ...args] = HARNESS[id];
const childEnv = { ...process.env };
if (id === 'pi') childEnv.PI_ACP_PI_COMMAND = new URL('./pi-trusted', import.meta.url).pathname;
const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: childEnv });
let buf = '';
let nextId = 0;
const pending = new Map();
const toolCalls = [];
const text = [];
let stderr = '';

child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      continue;
    }
    // The app answers permission requests with allow_once (harness.ts answer()); the probe must too,
    // or a harness that asks before its second tool call stalls the turn.
    if (msg.method === 'session/request_permission') {
      const opts = Array.isArray(msg.params?.options) ? msg.params.options : [];
      const pick = opts.find((o) => o.kind === 'allow_once') ?? opts.find((o) => String(o.kind).startsWith('allow'));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' } } }) + '\n');
      continue;
    }
    const u = msg.params?.update;
    if (!u) continue;
    if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      const name = u.title ?? u.kind ?? u.toolCallId;
      const prev = toolCalls.find((t) => t.id === u.toolCallId);
      if (prev) { prev.status = u.status ?? prev.status; prev.name = u.title ?? prev.name; }
      else toolCalls.push({ id: u.toolCallId, name, status: u.status ?? 'pending' });
    }
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') text.push(u.content.text);
  }
});

const rpc = (method, params) => new Promise((resolve, reject) => {
  const rid = ++nextId;
  pending.set(rid, { resolve, reject });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
  setTimeout(() => { if (pending.delete(rid)) reject(new Error(`${method} timed out`)); }, 600_000);
});

const t0 = Date.now();
try {
  await rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  const s = await rpc('session/new', { cwd: `/root/grokbot/files/${bot.id}`, mcpServers });
  const sessionId = s?.sessionId;
  if (!sessionId) throw new Error('no sessionId');
  await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
  const dataCalls = toolCalls.filter((t) => /data_(search|read|list|grep)/.test(t.name ?? ''));
  const answer = text.join('').trim();
  console.log(JSON.stringify({
    harness: id, bot: bot.name, ms: Date.now() - t0,
    tool_calls: toolCalls.length, data_tool_calls: dataCalls.map((t) => t.name),
    saw_data_tools: dataCalls.length > 0,
    answer_chars: answer.length,
    answer: answer.slice(0, 400),
    stderr: stderr.slice(-300),
  }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ harness: id, error: String(e.message ?? e), tool_calls: toolCalls.map((t) => t.name), stderr: stderr.slice(-600) }, null, 2));
} finally {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  setTimeout(() => process.exit(0), 500);
}
