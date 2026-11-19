import { test } from 'node:test';
import assert from 'node:assert/strict';

const S = await import('../src/superset.js');

const cfg = { url: 'http://127.0.0.1:8088', publicUrl: 'https://superset.example', user: 'bothq', password: 'pw-secret' };

/** A fake Superset: records calls and answers like the real API. */
function fake(over: Record<string, (init: any) => { status?: number; body?: any; cookie?: string }> = {}) {
  const calls: { url: string; init: any }[] = [];
  const f = async (url: string, init: any = {}) => {
    calls.push({ url, init });
    const path = url.replace(cfg.url, '');
    const key = Object.keys(over).find((k) => path.startsWith(k));
    const r = key ? over[key](init) : path.startsWith('/api/v1/security/login') ? { body: { access_token: 'tok' } }
      : path.startsWith('/api/v1/security/csrf_token') ? { body: { result: 'csrf1' }, cookie: 'session=abc; HttpOnly' } : { status: 404, body: {} };
    const status = r.status ?? 200;
    return { ok: status < 300, status, json: async () => r.body ?? {}, headers: { get: (n: string) => (n === 'set-cookie' ? r.cookie ?? null : null) } };
  };
  return { f, calls };
}

test('supersetConfig needs a public URL, user and password (from a file too)', () => {
  assert.equal(S.supersetConfig({}), null);
  const c = S.supersetConfig({ SUPERSET_PUBLIC_URL: 'https://s.example/', SUPERSET_USER: 'bothq', SUPERSET_PASSWORD: 'x' });
  assert.deepEqual(c, { url: 'http://127.0.0.1:8088', publicUrl: 'https://s.example', user: 'bothq', password: 'x' });
});

test('guestToken signs in, sends CSRF + cookie, asks for one dashboard, and returns only the token', async () => {
  const { f, calls } = fake({ '/api/v1/security/guest_token/': () => ({ body: { token: 'guest-123' } }) });
  const t = await S.guestToken(cfg, '0f8c2b1e-1111-4222-8333-944455556666', { id: 'u1', name: 'Gus Trader' }, f as any);
  assert.equal(t, 'guest-123');
  const login = JSON.parse(calls[0].init.body);
  assert.equal(login.username, 'bothq');
  const g = calls.find((c) => c.url.endsWith('/guest_token/'))!;
  assert.equal(g.init.headers['X-CSRFToken'], 'csrf1');
  assert.equal(g.init.headers.Cookie, 'session=abc');
  const body = JSON.parse(g.init.body);
  assert.deepEqual(body.resources, [{ type: 'dashboard', id: '0f8c2b1e-1111-4222-8333-944455556666' }]);
  assert.equal(body.user.username, 'bothq_u1');
  assert.equal(body.user.first_name, 'Gus');
});

test('guestToken refuses a malformed embed id before calling Superset', async () => {
  const { f, calls } = fake();
  await assert.rejects(S.guestToken(cfg, '../admin', { id: 'u', name: 'x' }, f as any), /Unknown embedded dashboard/);
  assert.equal(calls.length, 0);
});

test('listDashboards attaches embed ids and public links; a bad sign-in is explained', async () => {
  const { f } = fake({
    '/api/v1/dashboard/?': () => ({ body: { result: [{ id: 7, dashboard_title: 'Pipeline', url: '/superset/dashboard/7/' }, { id: 8, dashboard_title: 'Races' }] } }),
    '/api/v1/dashboard/7/embedded': () => ({ body: { result: { uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } } }),
  });
  const list = await S.listDashboards(cfg, f as any);
  assert.deepEqual(list.map((d) => [d.id, d.title, d.embedId, d.url]), [
    [7, 'Pipeline', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'https://superset.example/superset/dashboard/7/'],
    [8, 'Races', null, 'https://superset.example/superset/dashboard/8/'],
  ]);
  const bad = fake({ '/api/v1/security/login': () => ({ status: 401 }) });
  await assert.rejects(S.listDashboards(cfg, bad.f as any), /could not sign in/);
});

test('enableEmbedding posts the allowed origins and returns the embed id', async () => {
  const { f, calls } = fake({ '/api/v1/dashboard/7/embedded': () => ({ body: { result: { uuid: 'u-1' } } }) });
  assert.equal(await S.enableEmbedding(cfg, '7', ['https://bot-hq-sandy.vercel.app'], f as any), 'u-1');
  const post = calls.find((c) => c.url.endsWith('/7/embedded'))!;
  assert.equal(post.init.method, 'POST');
  assert.deepEqual(JSON.parse(post.init.body), { allowed_domains: ['https://bot-hq-sandy.vercel.app'] });
  await assert.rejects(S.enableEmbedding(cfg, 'x', [], f as any), /Unknown dashboard/);
});
