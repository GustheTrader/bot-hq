import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.XAI_API_KEY = 'test'; process.env.COMPOSIO_API_KEY = 'test'; process.env.SESSION_SECRET = 'test'; process.env.COMPUTER_PROVIDER = 'local';
process.env.MACRO_MCP_URL = 'https://mcp.example/mcp';
process.env.MACRO_AUTH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-gtm-'));
const G = await import('../src/macro-gtm.js');
const C = await import('../src/macro-client.js');

const t = (id: string, at: string, people: string[]) => ({ id, subject: 's', from: null, participants: people.map((email) => ({ name: null, email })), at, read: true, count: 1 });

test('fromEmail groups the other side by domain, skipping my own domain and free mail', () => {
  const r = G.fromEmail([
    t('1', '2026-11-20T00:00:00Z', ['me@zen.ai', 'ann@acme.com', 'bob@acme.com']),
    t('2', '2026-11-22T00:00:00Z', ['me@zen.ai', 'ann@acme.com']),
    t('3', '2026-11-21T00:00:00Z', ['me@zen.ai', 'pal@gmail.com', 'cto@globex.io']),
  ], 'me@zen.ai');
  assert.deepEqual(r.companies.map((c) => [c.domain, c.threads, c.people]), [['acme.com', 2, 2], ['globex.io', 1, 1]]);
  assert.equal(r.companies[0].lastAt, '2026-11-22T00:00:00Z');
  assert.ok(!r.contacts.some((p) => p.email === 'me@zen.ai'));
  assert.equal(r.contacts.find((p) => p.email === 'pal@gmail.com')?.company, null);
  assert.equal(r.contacts.find((p) => p.email === 'ann@acme.com')?.company, 'acme.com');
});

test('inputs are validated and embedded as JSON literals', () => {
  assert.throws(() => G.checkId('../x'), /Unknown item/);
  assert.throws(() => G.checkDomain('not a domain'), /Unknown domain/);
  assert.equal(G.checkDomain('Acme.COM'), 'acme.com');
  assert.throws(() => G.checkQuery('x'.repeat(201)), /too long/);
  const src = G.overviewProgram('"; process.exit(1); "');
  assert.ok(src.includes(JSON.stringify('"; process.exit(1); "')));
  assert.ok(!src.includes('const q: string = ""; process.exit'));
});

test('toPlainText turns HTML email into text and leaves plain text alone', () => {
  assert.equal(G.toPlainText('Hi Ann,\nthanks'), 'Hi Ann,\nthanks');
  assert.equal(G.toPlainText('<html><style>p{}</style><p>Hi &amp; bye</p><script>x()</script><br>Ann</html>'), 'Hi & bye\n\nAnn');
});

test('parseMcpReply reads plain JSON and SSE replies', () => {
  assert.deepEqual(C.parseMcpReply('{"id":2,"result":{}}', 'application/json', 2), { id: 2, result: {} });
  assert.deepEqual(C.parseMcpReply('event: message\ndata: {"id":2,"result":{"ok":1}}\n\n', 'text/event-stream', 2), { id: 2, result: { ok: 1 } });
});

test('writeTokenFile replaces the file atomically and keeps Hermes fields', () => {
  const dir = path.join(process.env.MACRO_AUTH_HOME!, 'mcp-tokens');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'macro.json');
  C.writeTokenFile({ access_token: 'a', hermes_issuer: 'https://mcp.example' }, f);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { access_token: 'a', hermes_issuer: 'https://mcp.example' });
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});
