import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui-relay-'));
// db.ts / env.ts read these at import time, so set them before importing.
process.env.DB_PATH = path.join(base, 'test.db');
process.env.XAI_API_KEY = 'test';
process.env.COMPOSIO_API_KEY = 'test';
process.env.COMPUTER_PROVIDER = 'local';
process.env.SESSION_SECRET = 'test-secret';
process.env.ORGO_API_KEY = 'test';
process.env.APP_URL = 'http://app.example';

const { WebSocket, WebSocketServer } = await import('ws');
const { db, now } = await import('../src/db.js');
const { attachA2uiRelay, a2uiApi, TOKEN_HEADER, MAX_PENDING_FRAMES } = await import('../src/a2ui-relay.js');

// --- fixtures: two users with sessions, and a member of the owner's workspace ---
function mkUser(id: string, email: string, sessionToken: string, expiresAt = now() + 3_600_000) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, email, id, now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(sessionToken, id, now(), expiresAt);
}
mkUser('usr_owner', 'owner@x.com', 'tok_owner');
mkUser('usr_other', 'other@x.com', 'tok_other');
mkUser('usr_mate', 'mate@x.com', 'tok_mate');
db.prepare('INSERT INTO workspace_members(user_id,workspace_id,added_at) VALUES (?,?,?)').run('usr_mate', 'usr_owner', now());

// --- a tiny upstream standing in for the Rust agent ---
const upstreamHeaders: http.IncomingHttpHeaders[] = [];
const upstreamGot: string[] = [];
const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
upstream.on('connection', (s, req) => {
  upstreamHeaders.push(req.headers);
  s.send(JSON.stringify({ version: '1.0', hello: true }));
  s.on('message', (d) => {
    upstreamGot.push(d.toString());
    s.send(`echo:${d.toString()}`);
  });
});
await new Promise((r) => upstream.once('listening', r));
process.env.BOTHQ_A2UI_AGENT_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
process.env.BOTHQ_A2UI_TOKEN = 'agent-secret';

// --- the Bot HQ side: a plain http server with the relay attached ---
const server = http.createServer((_req, res) => res.end('ok'));
attachA2uiRelay(server, { revalidateMs: 100 });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;
const host = `127.0.0.1:${port}`;

after(() => {
  server.close();
  upstream.close();
  fs.rmSync(base, { recursive: true, force: true });
});

type Outcome = { status: number } | { ws: InstanceType<typeof WebSocket> };
function connect(headers: Record<string, string>): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}/a2ui/ws`, { headers });
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_req, res) => { resolve({ status: res.statusCode ?? 0 }); res.resume(); });
    ws.once('error', (e) => reject(e));
  });
}
const statusOf = (o: Outcome) => ('status' in o ? o.status : 101);
const nextMessage = (ws: InstanceType<typeof WebSocket>) => new Promise<string>((r) => ws.once('message', (d) => r(d.toString())));
const alive = async () => {
  const r = await fetch(`http://${host}/`);
  return r.status === 200 && (await r.text()) === 'ok';
};

test('a malformed session cookie is treated as signed out (401) and the process stays up', async () => {
  delete process.env.BOTHQ_A2UI_OWNER;
  for (const cookie of ['grokbot_session=%', 'grokbot_session=%E0%A4%A', 'a=b; grokbot_session=%zz']) {
    assert.equal(statusOf(await connect({ cookie })), 401, cookie);
  }
  assert.ok(await alive());
});

test('no cookie / unknown session -> 401', async () => {
  delete process.env.BOTHQ_A2UI_OWNER;
  assert.equal(statusOf(await connect({})), 401);
  assert.equal(statusOf(await connect({ cookie: 'grokbot_session=nope' })), 401);
});

test('a cross-site Origin is rejected even with a valid session', async () => {
  delete process.env.BOTHQ_A2UI_OWNER;
  assert.equal(statusOf(await connect({ cookie: 'grokbot_session=tok_owner', origin: 'https://evil.example' })), 403);
  assert.equal(statusOf(await connect({ cookie: 'grokbot_session=tok_owner', origin: 'not a url' })), 403);
  // The app's own origin (APP_URL) and an Origin matching Host are fine.
  for (const origin of ['http://app.example', `http://${host}`]) {
    const o = await connect({ cookie: 'grokbot_session=tok_owner', origin });
    assert.equal(statusOf(o), 101, origin);
    if ('ws' in o) o.ws.close();
  }
});

test('BOTHQ_A2UI_OWNER admits only that workspace (incl. its members): others get 403', async () => {
  for (const owner of ['usr_owner', 'Owner@X.com']) {
    process.env.BOTHQ_A2UI_OWNER = owner;
    assert.equal(statusOf(await connect({ cookie: 'grokbot_session=tok_other' })), 403, owner);
    for (const tok of ['tok_owner', 'tok_mate']) {
      const o = await connect({ cookie: `grokbot_session=${tok}` });
      assert.equal(statusOf(o), 101, `${owner} ${tok}`);
      if ('ws' in o) o.ws.close();
    }
  }
  process.env.BOTHQ_A2UI_OWNER = 'nobody@x.com'; // names no user: nobody is admitted
  assert.equal(statusOf(await connect({ cookie: 'grokbot_session=tok_owner' })), 403);
  delete process.env.BOTHQ_A2UI_OWNER;
});

test('happy path: frames relay both ways and the agent token header is forwarded', async () => {
  process.env.BOTHQ_A2UI_OWNER = 'usr_owner';
  upstreamHeaders.length = 0;
  upstreamGot.length = 0;
  const o = await connect({ cookie: 'grokbot_session=tok_owner', origin: 'http://app.example' });
  assert.ok('ws' in o);
  const ws = o.ws;
  assert.equal(await nextMessage(ws), JSON.stringify({ version: '1.0', hello: true }));
  const frame = JSON.stringify({ version: '1.0', action: { name: 'ticketEdited' } });
  const echoed = nextMessage(ws);
  ws.send(frame);
  assert.equal(await echoed, `echo:${frame}`);
  assert.deepEqual(upstreamGot, [frame]);
  assert.equal(upstreamHeaders[0][TOKEN_HEADER], 'agent-secret');
  // The browser's cookie is not passed on to the agent.
  assert.equal(upstreamHeaders[0].cookie, undefined);
  ws.close();
  delete process.env.BOTHQ_A2UI_OWNER;
});

test('an open relay is closed once its session is gone', async () => {
  mkUser('usr_brief', 'brief@x.com', 'tok_brief');
  const o = await connect({ cookie: 'grokbot_session=tok_brief' });
  assert.ok('ws' in o);
  const closed = new Promise<number>((r) => o.ws.once('close', (code) => r(code)));
  db.prepare('DELETE FROM auth_sessions WHERE token=?').run('tok_brief');
  assert.equal(await closed, 4401);
});

test('the pending queue before upstream opens is bounded', async () => {
  // An agent that accepts TCP but never finishes the WebSocket handshake.
  const stall = http.createServer();
  stall.on('upgrade', () => { /* never answer */ });
  await new Promise<void>((r) => stall.listen(0, '127.0.0.1', r));
  const prev = process.env.BOTHQ_A2UI_AGENT_URL;
  process.env.BOTHQ_A2UI_AGENT_URL = `http://127.0.0.1:${(stall.address() as AddressInfo).port}`;
  try {
    const o = await connect({ cookie: 'grokbot_session=tok_owner' });
    assert.ok('ws' in o);
    const closed = new Promise<number>((r) => o.ws.once('close', (code) => r(code)));
    for (let i = 0; i <= MAX_PENDING_FRAMES; i++) o.ws.send(`{"n":${i}}`);
    assert.equal(await closed, 1013);
  } finally {
    process.env.BOTHQ_A2UI_AGENT_URL = prev;
    stall.closeAllConnections();
    stall.close();
  }
});

test('/a2ui/health requires sign-in and the owner, and sends the agent token', async () => {
  const seen: (string | undefined)[] = [];
  const h = http.createServer((req, res) => {
    seen.push(req.headers[TOKEN_HEADER] as string | undefined);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sessionId: 's', head: 1, surfaces: [], orders: 0, resumed: false }));
  });
  await new Promise<void>((r) => h.listen(0, '127.0.0.1', r));
  const prev = process.env.BOTHQ_A2UI_AGENT_URL;
  process.env.BOTHQ_A2UI_AGENT_URL = `http://127.0.0.1:${(h.address() as AddressInfo).port}`;
  process.env.BOTHQ_A2UI_OWNER = 'usr_owner';
  try {
    const get = (cookie?: string) => a2uiApi.request('/health', { headers: cookie ? { cookie } : {} });
    assert.equal((await get()).status, 401);
    assert.equal((await get('grokbot_session=%')).status, 401);
    assert.equal((await get('grokbot_session=tok_other')).status, 403);
    const ok = await get('grokbot_session=tok_owner');
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { sessionId: string }).sessionId, 's');
    assert.deepEqual(seen, ['agent-secret']);
  } finally {
    process.env.BOTHQ_A2UI_AGENT_URL = prev;
    delete process.env.BOTHQ_A2UI_OWNER;
    h.close();
  }
});
