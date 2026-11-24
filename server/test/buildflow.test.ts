import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';

process.env.XAI_API_KEY = 'test'; process.env.COMPOSIO_API_KEY = 'test'; process.env.SESSION_SECRET = 'test'; process.env.COMPUTER_PROVIDER = 'local';
process.env.BUILDFLOW_API_KEY = 'svc-key-123';
process.env.DB_PATH = (await import('node:path')).join((await import('node:os')).tmpdir(), `bf-test-${process.pid}.db`);

// A fake Build-flow that echoes what it received, and knows one job (JOB-1001).
const seen: { path: string; key: string | undefined; actor: string | undefined; cookie: string | undefined; auth?: string; body?: Buffer }[] = [];
const SUMMARY = {
  job: { id: 'p1', number: 'JOB-1001', name: 'Smith kitchen remodel', client: 'Pat Smith', status: 'active' },
  contract: { original: 13392, approvedChangeOrders: 1200, pendingChangeOrders: 0, revised: 14592 },
  schedule: { items: 2, complete: 0, progress: 40, late: [], next: [{ id: 's1', title: 'Cabinets', startDate: '2026-12-03', endDate: '2026-12-05', status: 'not_started' }] },
  waitingOnClient: { changeOrders: [{ id: 'c1', number: 'CO-0002', title: 'Upgrade hood', total: 800 }], selections: [] },
  lastDailyLog: { date: '2026-12-01', author: 'Ana', workPerformed: 'Demo done' },
};
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (d: Buffer) => chunks.push(d));
  req.on('end', () => {
    seen.push({ path: req.url ?? '', key: req.headers['x-api-key'] as string | undefined, actor: req.headers['x-actor'] as string | undefined, cookie: req.headers.cookie, auth: req.headers.authorization, body: Buffer.concat(chunks) });
    const m = /^\/api\/v1\/jobs\/by-number\/(.+)$/.exec(req.url ?? '');
    if (m) {
      const known = /^(job%20|job-|JOB-)?1001$/i.test(m[1]);
      res.writeHead(known ? 200 : 404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(known ? SUMMARY : { error: `No job ${decodeURIComponent(m[1])} in Build-flow.` }));
    }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'x=1' });
    res.end(JSON.stringify({ ok: true }));
  });
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
  assert.equal(page.status, 401);
  assert.equal(page.headers.get('location'), null, 'no redirect (Vercel would turn it into Zo’s address)');
  assert.match(await page.text(), /Sign in to Bot HQ first/);
  assert.equal(seen.length, before, 'nothing reached Build-flow');
});

test('job numbers: loose matching, lookup with the service key, unknown numbers are null', async () => {
  const B = await import('../src/buildflow.js');
  for (const s of ['JOB-1001', 'job 1001', '#1001', '1001', ' job-1001 ']) assert.equal(B.looksLikeJobNumber(s), true, s);
  for (const s of ['ops@acme.com', 'acme.com', '12', 'JOB-', 'call Pat']) assert.equal(B.looksLikeJobNumber(s), false, s);
  const s = await B.jobByNumber('job 1001', 'Ops Team (team)');
  assert.equal(s.job.id, 'p1');
  assert.equal(seen.at(-1)!.key, 'svc-key-123');
  assert.equal(seen.at(-1)!.actor, 'Ops Team (team)');
  assert.equal(await B.jobByNumber('JOB-2002', 'x'), null);
});

test('jobBrief tells the bot the job, its money, what is next, what waits on the client, and which tool to use', async () => {
  const { jobBrief } = await import('../src/buildflow.js');
  const b = jobBrief(SUMMARY);
  assert.match(b, /JOB-1001 "Smith kitchen remodel" for Pat Smith/);
  assert.match(b, /job_id p1/);
  assert.match(b, /Contract \$14,592/);
  assert.match(b, /Next: Cabinets \(2026-12-03\)/);
  assert.match(b, /CO-0002 Upgrade hood \$800/);
  assert.match(b, /buildflow_job/);
});

test('/field is public: it forwards the crew token and nothing of Bot HQ, passes uploads through, and reaches only /field', async () => {
  const { proxyField } = await import('../src/buildflow.js');
  const f = new Hono();
  f.all('/field', (c) => proxyField(c));
  f.all('/field/*', (c) => proxyField(c));

  const r = await f.request('/field/api/jobs?today=2026-11-24', { headers: { cookie: 'grokbot_session=abc', authorization: 'Bearer crew-token', 'x-api-key': 'attacker', 'x-actor': 'attacker' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('set-cookie'), null);
  let last = seen.at(-1)!;
  assert.equal(last.path, '/field/api/jobs?today=2026-11-24');
  assert.equal(last.auth, 'Bearer crew-token', 'the crew token is passed on');
  assert.equal(last.key, undefined, 'no service key, whatever the caller sent');
  assert.equal(last.actor, undefined);
  assert.equal(last.cookie, undefined, 'Bot HQ cookies never reach Build-flow');

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 300 }, (_, i) => i % 251)]);
  const up = await f.request('/field/api/photos', { method: 'POST', headers: { 'content-type': 'image/jpeg', authorization: 'Bearer crew-token' }, body: jpeg });
  assert.equal(up.status, 200);
  last = seen.at(-1)!;
  assert.equal(last.path, '/field/api/photos');
  assert.ok(last.body!.equals(jpeg), 'the photo arrives byte for byte');

  // Nothing outside /field can be reached through it.
  const before = seen.length;
  for (const p of ['/field/../api/v1/leads', '/field/%2e%2e/api/v1/leads', '/field/..%2f..%2fapi/v1/leads', '/fieldwork', '/api/v1/leads']) {
    const x = await f.request(p, { headers: { authorization: 'Bearer x' } });
    assert.notEqual(x.status, 200, p);
  }
  assert.equal(seen.slice(before).filter((s) => !s.path.startsWith('/field')).length, 0, 'no request left /field');
});

test.after(() => upstream.close());
