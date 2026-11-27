import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.XAI_API_KEY = 'test'; process.env.COMPOSIO_API_KEY = 'test'; process.env.SESSION_SECRET = 'test'; process.env.COMPUTER_PROVIDER = 'local';
process.env.FIRECRAWL_API_KEY = 'fc-test';
process.env.DB_PATH = (await import('node:path')).join((await import('node:os')).tmpdir(), `websearch-test-${process.pid}.db`);

const web = await import('../src/websearch.js');
const { toolMap } = await import('../src/agent/tools.js');

type Sent = { url: string; body: any; auth: string };
const sent: Sent[] = [];
let reply: { status: number; body: any } = { status: 200, body: {} };
web.setFetchForTests((async (url: any, init: any) => {
  sent.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization });
  return new Response(JSON.stringify(reply.body), { status: reply.status });
}) as typeof fetch);

test('the tools are offered when the key is set', () => {
  assert.ok(toolMap.has('web_search'));
  assert.ok(toolMap.has('web_read'));
});

test('search sends the key, a site filter and a recency filter, and lists hits', async () => {
  reply = { status: 200, body: { success: true, data: [{ title: 'Need patio cover', url: 'https://reno.craigslist.org/x/1.html', description: 'Looking for a contractor' }, { title: 'no link' }] } };
  const out = await toolMap.get('web_search')!.impl({ query: 'patio cover', site: 'https://craigslist.org/', recent: 'week', limit: 50 }, {} as any);
  const s = sent.at(-1)!;
  assert.equal(s.url, 'https://api.firecrawl.dev/v1/search');
  assert.equal(s.auth, 'Bearer fc-test');
  assert.deepEqual(s.body, { query: 'site:craigslist.org patio cover', limit: 20, tbs: 'qdr:w' });
  assert.match(out.output, /1\. Need patio cover\nhttps:\/\/reno\.craigslist\.org\/x\/1\.html/);
  assert.doesNotMatch(out.output, /no link/);
});

test('a junk site value is ignored rather than sent', async () => {
  reply = { status: 200, body: { success: true, data: [] } };
  const out = await toolMap.get('web_search')!.impl({ query: 'handyman', site: 'not a site' }, {} as any);
  assert.equal(sent.at(-1)!.body.query, 'handyman');
  assert.equal(out.output, 'No results.');
});

test('read returns the page text, cut when long', async () => {
  reply = { status: 200, body: { success: true, data: { markdown: 'x'.repeat(25_000), metadata: { title: 'Post' } } } };
  const out = await toolMap.get('web_read')!.impl({ url: 'https://nextdoor.com/p/abc' }, {} as any);
  assert.deepEqual(sent.at(-1)!.body, { url: 'https://nextdoor.com/p/abc', formats: ['markdown'], onlyMainContent: true });
  assert.match(out.output, /^Post\nhttps:\/\/nextdoor\.com\/p\/abc/);
  assert.match(out.output, /\[Cut: the page is longer\.\]$/);
});

test('bad links are refused before any call; credit and rate errors read plainly', async () => {
  const n = sent.length;
  await assert.rejects(web.webRead('javascript:alert(1)'), /full http\(s\) link/);
  await assert.rejects(web.webSearch({ query: '  ' }), /Give a query/);
  assert.equal(sent.length, n);
  reply = { status: 402, body: { success: false, error: 'Insufficient credits' } };
  await assert.rejects(web.webSearch({ query: 'x' }), /out of Firecrawl credits/);
  reply = { status: 429, body: { success: false } };
  await assert.rejects(web.webSearch({ query: 'x' }), /rate limited/);
});
