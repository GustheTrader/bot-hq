import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';

process.env.XAI_API_KEY = 'test'; process.env.COMPOSIO_API_KEY = 'test'; process.env.SESSION_SECRET = 'test'; process.env.COMPUTER_PROVIDER = 'local';
process.env.BUILDFLOW_API_KEY = 'svc-key-123';
process.env.DB_PATH = (await import('node:path')).join((await import('node:os')).tmpdir(), `bf-test-${process.pid}.db`);

// A fake Build-flow that echoes what it received.
const seen: { path: string; key: string | undefined; actor: string | undefined; cookie: string | undefined }[] = [];
const upstream = http.createServer((req, res) => {
  seen.push({ path: req.url ?? '', key: req.headers['x-api-key'] as string | undefined, actor: req.headers['x-actor'] as string | undefined, cookie: req.headers.cookie });
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'x=1' });
  res.end(JSON.stringify({ ok: true }));
});
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
process.env.BUILDFLOW_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

const { proxyBuildflow } = await import('../src/buildflow.js');
const app = new Hono();
app.all('/buildflow/*', (c) => proxyBuildflow(c));

test('the client portal and its assets pass through without a session and without the service key', async () => {
  for (const p of ['/buildflow/portal/abc', '/buildflow/api/v1/portal/abc', '/buildflow/assets/index.js']) {
    const r = await app.request(p, { headers: { cookie: 'grokbot_session=nope' } });
    assert.equal(r.status, 200, p);
    const last = seen.at(-1)!;
    assert.equal(last.path, p.replace('/buildflow', ''));
    assert.equal(last.key, undefined);
    assert.equal(last.cookie, undefined, 'Bot HQ cookies never reach Build-flow');
    assert.equal(r.headers.get('set-cookie'), null);
  }
});

test('everything else needs a Bot HQ session: API answers 401, pages go to sign-in', async () => {
  const before = seen.length;
  const api = await app.request('/buildflow/api/v1/leads');
  assert.equal(api.status, 401);
  const page = await app.request('/buildflow/leads');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/');
  assert.equal(seen.length, before, 'nothing reached Build-flow');
});

test.after(() => upstream.close());
