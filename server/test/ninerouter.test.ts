import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

process.env.XAI_API_KEY = 'test'; process.env.COMPOSIO_API_KEY = 'test'; process.env.SESSION_SECRET = 'test'; process.env.COMPUTER_PROVIDER = 'local';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ninerouter-test-'));
fs.writeFileSync(path.join(dir, 'pw'), 'dash-pass\n');
fs.writeFileSync(path.join(dir, 'key'), 'client-key\n');
process.env.NINEROUTER_PASSWORD_FILE = path.join(dir, 'pw');
process.env.NINEROUTER_KEY_FILE = path.join(dir, 'key');

// A fake 9Router: dashboard API behind a cookie, plus the client chat endpoint.
const conns: any[] = [];
let settings: any = { rtkEnabled: true, cavemanEnabled: false, ponytailEnabled: false, cloudEnabled: false, tunnelEnabled: false, requireApiKey: true };
const seen: { method: string; url: string; body: any }[] = [];
let validOverride: boolean | null = null;
let chatOk = true;
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined;
    seen.push({ method: req.method!, url: req.url!, body });
    const send = (code: number, v: unknown, headers: Record<string, string> = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(v)); };
    if (req.url === '/api/auth/login') return body?.password === 'dash-pass' ? send(200, { success: true }, { 'set-cookie': 'auth_token=sess1; Path=/; HttpOnly' }) : send(401, { error: 'bad password' });
    if (req.url === '/v1/chat/completions') {
      if (req.headers.authorization !== 'Bearer client-key') return send(401, { error: { message: 'Invalid API key' } });
      return chatOk ? send(200, { model: body.model, choices: [{ message: { content: 'ok' } }] }) : send(404, { error: { message: 'No active credentials for provider: x' } });
    }
    if (req.headers.cookie !== 'auth_token=sess1') return send(401, { error: 'login required' });
    if (req.url === '/api/providers' && req.method === 'GET') return send(200, { connections: conns });
    if (req.url === '/api/providers/validate') return send(200, { valid: validOverride ?? body.apiKey !== 'bad-key-000', error: validOverride === false || body.apiKey === 'bad-key-000' ? 'Invalid API key' : null });
    if (req.url === '/api/providers' && req.method === 'POST') {
      const c = { id: `c${conns.length + 1}`, provider: body.provider, name: body.name, isActive: true, testStatus: 'active', apiKey: body.apiKey, accessToken: 'secret-token' };
      conns.push(c);
      return send(200, { connection: c });
    }
    const del = /^\/api\/providers\/([^/]+)$/.exec(req.url!);
    if (del && req.method === 'DELETE') { const i = conns.findIndex((c) => c.id === del[1]); if (i < 0) return send(404, { error: 'Connection not found' }); conns.splice(i, 1); return send(200, { message: 'ok' }); }
    if (req.url === '/api/combos') return send(200, { combos: [{ name: 'hq-free', models: ['a', 'b'] }] });
    if (req.url === '/api/settings' && req.method === 'GET') return send(200, settings);
    if (req.url === '/api/settings' && req.method === 'PATCH') { settings = { ...settings, ...body }; return send(200, settings); }
    send(404, { error: 'not found' });
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
process.env.NINEROUTER_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
after(() => fake.close());

const nr = await import('../src/ninerouter.js');

test('status lists connections without keys or tokens', async () => {
  conns.push({ id: 'c0', provider: 'gemini', name: 'Gemini', isActive: true, testStatus: 'active', apiKey: 'AIza-should-not-leak', accessToken: 'tok' });
  const s = await nr.routerStatus();
  assert.equal(s.up, true);
  assert.equal(s.connections.length, 1);
  assert.deepEqual(Object.keys(s.connections[0]).sort(), ['active', 'id', 'lastError', 'name', 'provider', 'status']);
  assert.ok(!JSON.stringify(s).includes('should-not-leak') && !JSON.stringify(s).includes('"tok"'));
  assert.equal(s.features.rtkEnabled, true);
  assert.deepEqual(s.combos, [{ name: 'hq-free', models: 2 }]);
  conns.length = 0;
});

test('frontier and unknown providers are refused before reaching 9Router', async () => {
  for (const p of ['anthropic', 'openai', 'xai', 'kiro', 'claude-code', '']) {
    const before = seen.length;
    await assert.rejects(nr.addRouterKey(p, 'some-long-key-123'), nr.RouterUserError);
    assert.equal(seen.length, before, `${p} reached 9Router`);
  }
});

test('a rejected key is not saved', async () => {
  await assert.rejects(nr.addRouterKey('gemini', 'bad-key-000'), /rejected the key/);
  assert.equal(conns.length, 0);
});

test('a good key is validated, saved under the provider name, and proven with a real call', async () => {
  const r = await nr.addRouterKey('gemini', 'AIza-good-key-123');
  assert.equal(r.connection?.provider, 'gemini');
  assert.equal(conns[0].name, 'Google Gemini (AI Studio)');
  assert.equal(r.test.ok, true);
  const chat = seen.filter((x) => x.url === '/v1/chat/completions').at(-1)!;
  assert.match(chat.body.model, /^gemini\//);
  assert.ok(!('apiKey' in (r.connection as any)), 'the key is not echoed back');
});

test('format-only validators: a saved key whose real call fails is reported, not hidden', async () => {
  validOverride = true; chatOk = false;
  const r = await nr.addRouterKey('nvidia', 'nvapi-fake-but-format-ok');
  assert.equal(r.test.ok, false);
  assert.match(r.test.detail, /No active credentials/);
  validOverride = null; chatOk = true;
});

test('Cloudflare needs its Account ID', async () => {
  await assert.rejects(nr.addRouterKey('cloudflare-ai', 'cf-token-123456'), /Account ID is required/);
  const r = await nr.addRouterKey('cloudflare-ai', 'cf-token-123456', { accountId: 'abc123def456' });
  assert.ok(r.connection);
  const saved = seen.filter((x) => x.url === '/api/providers' && x.method === 'POST').at(-1)!;
  assert.deepEqual(saved.body.providerSpecificData, { accountId: 'abc123def456' });
});

test('keys can be removed; bad ids are refused', async () => {
  const id = conns[0].id;
  await nr.removeRouterKey(id);
  assert.ok(!conns.some((c) => c.id === id));
  await assert.rejects(nr.removeRouterKey('../settings'), nr.RouterUserError);
});

test('only the allowed feature switches exist', async () => {
  assert.equal(nr.isRouterFeature('cavemanEnabled'), true);
  for (const k of ['cloudEnabled', 'tunnelEnabled', 'headroomEnabled', 'requireApiKey', '__proto__', 'constructor']) assert.equal(nr.isRouterFeature(k), false, k);
  await nr.setRouterFeature('cavemanEnabled', true);
  assert.equal(settings.cavemanEnabled, true);
});

test('an expired dashboard session signs in again', async () => {
  const logins = seen.filter((x) => x.url === '/api/auth/login').length;
  const orig = fake.listeners('request')[0] as any;
  let failOnce = true;
  fake.removeAllListeners('request');
  fake.on('request', (req, res) => {
    if (failOnce && req.url === '/api/combos') { failOnce = false; res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"expired"}'); }
    orig(req, res);
  });
  const s = await nr.routerStatus();
  assert.equal(s.up, true);
  assert.ok(seen.filter((x) => x.url === '/api/auth/login').length > logins, 'signed in again');
});
