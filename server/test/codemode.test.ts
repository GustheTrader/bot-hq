import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.XAI_API_KEY = 'test'; process.env.COMPOSIO_API_KEY = 'test'; process.env.SESSION_SECRET = 'test'; process.env.COMPUTER_PROVIDER = 'local';
process.env.DB_PATH = (await import('node:path')).join((await import('node:os')).tmpdir(), `codemode-test-${process.pid}.db`);
process.env.CODEMODE_SECRET = 'exec-secret';

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

// A fake executor. A "script" here is JSON: {"calls":[{name,args}], "token"?: override}. It plays each
// call back to Bot HQ's inner route, like the real Worker does, and returns what it got.
let hqUrl = '';
const execSeen: { path: string; auth?: string; body: any }[] = [];
const executor = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', async () => {
    const body = raw ? JSON.parse(raw) : {};
    execSeen.push({ path: req.url ?? '', auth: req.headers.authorization, body });
    const send = (code: number, v: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.headers.authorization !== 'Bearer exec-secret') return send(401, { error: 'unauthorized' });
    if (req.url === '/types') return send(200, { types: `declare const codemode: {\n${body.tools.map((t: any) => `\t${t.name}: (input: any) => Promise<unknown>;`).join('\n')}\n}` });
    if (req.url === '/run') {
      const script = JSON.parse(body.code);
      const results: unknown[] = [];
      for (const call of script.calls) {
        const r = await fetch(`${hqUrl}/mcp/${body.botId}/inner`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${script.token ?? body.runToken}` },
          body: JSON.stringify({ name: call.name, args: call.args ?? {} }),
        });
        results.push({ status: r.status, ...(await r.json()) });
      }
      return send(200, { result: results, logs: ['hello from the script'] });
    }
    send(404, {});
  });
});
process.env.CODEMODE_URL = `http://127.0.0.1:${await listen(executor)}`;

const { db, now } = await import('../src/db.js');
const { mcpApi } = await import('../src/mcp.js');
const { mcpToken } = await import('../src/engine.js');
const { splitTools, startRun, runForToken, endRun, callSummary } = await import('../src/codemode.js');
const { Hono } = await import('hono');
const { getRequestListener } = await import('@hono/node-server');

const app = new Hono();
app.route('/mcp', mcpApi);
const hq = http.createServer(getRequestListener(app.fetch));
hqUrl = `http://127.0.0.1:${await listen(hq)}`;
after(() => { hq.close(); executor.close(); });

const user = 'u-cm';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(user, `${user}@example.com`, user, now());
for (const [id, code] of [['bot-cm', 1], ['bot-plain', 0]] as const) {
  db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,created_at,updated_at,code_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, user, id, '', '', '', 'blob', 'blue', 'personal', now(), now(), code);
}

async function rpc(botId: string, method: string, params: unknown = {}) {
  const r = await fetch(`${hqUrl}/mcp/${botId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpToken(botId)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await r.json()) as any;
}

test('splitTools keeps turn-ending and Composio tools direct', () => {
  const t = (name: string) => ({ name, description: '', inputSchema: {} });
  const { direct, scripted } = splitTools([t('ask_user'), t('stay_silent'), t('list_routines'), t('COMPOSIO_SEARCH_TOOLS')]);
  assert.deepEqual(direct.map((x) => x.name), ['ask_user', 'stay_silent', 'COMPOSIO_SEARCH_TOOLS']);
  assert.deepEqual(scripted.map((x) => x.name), ['list_routines', 'COMPOSIO_SEARCH_TOOLS']);
});

test('run tokens are bound to their bot, signature and run', () => {
  const { runId, token } = startRun('bot-cm', null, ['list_routines']);
  assert.ok(runForToken('bot-cm', token));
  assert.equal(runForToken('bot-plain', token), null, 'another bot');
  assert.equal(runForToken('bot-cm', token.slice(0, -2) + 'xx'), null, 'tampered signature');
  endRun(runId);
  assert.equal(runForToken('bot-cm', token), null, 'finished run');
});

test('callSummary counts calls per tool', () => {
  assert.equal(callSummary(['a', 'b', 'b']), 'Ran 3 tools: a ×1, b ×2');
  assert.equal(callSummary([]), 'Ran a script (no tool calls)');
});

test('a bot without Code Mode lists every tool as before', async () => {
  const names = (await rpc('bot-plain', 'tools/list')).result.tools.map((t: any) => t.name);
  assert.ok(names.includes('list_routines'));
  assert.ok(!names.includes('run_code'));
});

test('a Code Mode bot lists run_code (with types) plus only the direct tools', async () => {
  const tools = (await rpc('bot-cm', 'tools/list')).result.tools;
  const names = tools.map((t: any) => t.name);
  assert.equal(names[0], 'run_code');
  assert.ok(names.includes('ask_user') && names.includes('stay_silent'));
  assert.ok(!names.includes('list_routines'), 'scripted tools are not listed directly');
  assert.match(tools[0].description, /list_routines: \(input: any\)/);
});

test('run_code runs inner calls through Bot HQ and returns only the result', async () => {
  const code = JSON.stringify({ calls: [{ name: 'list_routines' }, { name: 'list_routines' }] });
  const r = (await rpc('bot-cm', 'tools/call', { name: 'run_code', arguments: { code } })).result;
  assert.ok(!r.isError, r.content[0].text);
  const out = r.content[0].text;
  assert.match(out, /"status": 200/);
  assert.match(out, /hello from the script/, 'logs come back');
  const run = execSeen.find((e) => e.path === '/run')!;
  assert.deepEqual(run.body.tools.includes('ask_user'), false, 'turn-ending tools are not offered to scripts');
  assert.equal(run.auth, 'Bearer exec-secret');
});

test('scripts cannot call direct-only tools, and forged tokens are refused', async () => {
  const code = JSON.stringify({ calls: [{ name: 'ask_user', args: { question: 'q', options: ['a'] } }] });
  const out = (await rpc('bot-cm', 'tools/call', { name: 'run_code', arguments: { code } })).result.content[0].text;
  assert.match(out, /"status": 400/);
  assert.match(out, /not available to scripts|No tool named ask_user/);

  const forged = JSON.stringify({ token: 'bot-cm.x.9999999999999.bad', calls: [{ name: 'list_routines' }] });
  const out2 = (await rpc('bot-cm', 'tools/call', { name: 'run_code', arguments: { code: forged } })).result.content[0].text;
  assert.match(out2, /"status": 401/);
});

test('the inner route rejects the bot\'s own MCP token', async () => {
  const r = await fetch(`${hqUrl}/mcp/bot-cm/inner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpToken('bot-cm')}` },
    body: JSON.stringify({ name: 'list_routines', args: {} }),
  });
  assert.equal(r.status, 401);
});

test('run_code on a bot without Code Mode is not a tool', async () => {
  const r = (await rpc('bot-plain', 'tools/call', { name: 'run_code', arguments: { code: '{}' } })).result;
  assert.ok(r.isError);
  assert.match(r.content[0].text, /Code Mode is off/);
});
