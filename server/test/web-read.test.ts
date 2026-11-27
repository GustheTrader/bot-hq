import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.XAI_API_KEY = 'test'; process.env.COMPOSIO_API_KEY = 'test'; process.env.SESSION_SECRET = 'test'; process.env.COMPUTER_PROVIDER = 'local';
process.env.FIRECRAWL_API_KEY = 'fc-test';
process.env.DB_PATH = (await import('node:path')).join((await import('node:os')).tmpdir(), `web-read-test-${process.pid}.db`);

const web = await import('../src/websearch.js');

// A fake network: Firecrawl answers from `firecrawl`, any other address from `pages` (with an optional redirect).
type Seen = { url: string; method: string; ua?: string };
const seen: Seen[] = [];
let firecrawl: { status: number; body: any; headers?: Record<string, string> }[] = [];
let pages: Record<string, { status?: number; html: string; landed?: string }> = {};
const slept: number[] = [];
web.setSleepForTests(async (ms) => { slept.push(ms); });
web.setFetchForTests((async (url: any, init: any = {}) => {
  const u = String(url);
  seen.push({ url: u, method: init.method ?? 'GET', ua: init.headers?.['User-Agent'] });
  if (u.startsWith('https://api.firecrawl.dev/')) {
    const r = firecrawl.shift() ?? { status: 500, body: { success: false, error: 'no reply queued' } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }
  const p = pages[u];
  if (!p) return new Response('not found', { status: 404 });
  const res = new Response(p.html, { status: p.status ?? 200 });
  Object.defineProperty(res, 'url', { value: p.landed ?? u });
  return res;
}) as typeof fetch);

const POST = `<html><head><title>I need someone - labor gigs - craigslist</title></head><body>
<h1><span class="postingtitletext"> <span id="titletextonly">Need patio cover built</span> <small> (Sparks)</small></span></h1>
<div class="attrgroup"> <div class="attr remuneration"> <span class="labl">compensation:</span> <span class="valu">$2,000 &amp; up</span> </div>
<div class="attr"> <span class="labl">employment type:</span> <span class="valu">contract</span> </div></div>
<section id="postingbody">
  <div class="print-information print-qrcode-container"><p class="print-qrcode-label">QR Code Link to This Post</p><div class="print-qrcode" data-location="x"></div></div>
  Looking for someone to build a 12x20 patio cover.<br>Call me &#39;soon&#39;.
</section>
<p class="postinginfo reveal">posted: <time class="date timeago" datetime="2026-11-25T09:10:00-0800">2026-11-25</time></p>
<script>var tracking = 1;</script></body></html>`;

const SEARCH = `<html><head><title>reno gigs - craigslist</title></head><body><ol>
<li class="cl-static-search-result" title="Gazebo help"><a href="https://www.craigslist.org/view/d/reno-gazebo-help/AAA"><div class="title">Gazebo help</div><div class="details"><div class="price">$300</div><div class="location">
  Reno
</div></div></a></li>
<li class="cl-static-search-result" title="Hiring"><a href="https://www.craigslist.org/view/d/reno-hiring/BBB"><div class="title">Hiring &amp; paying</div><div class="details"><div class="price">$0</div></div></a></li>
</ol></body></html>`;

test('a Craigslist post is read directly (not through Firecrawl) into title, date, place, details and text', async () => {
  const url = 'https://www.craigslist.org/view/d/sparks-patio/ZZZ';
  pages[url] = { html: POST };
  seen.length = 0;
  const p = await web.webRead(url);
  assert.ok(!seen.some((s) => s.url.includes('firecrawl')), 'Firecrawl is not asked');
  assert.match(seen[0].ua ?? '', /Mozilla/);
  assert.equal(p.title, 'Need patio cover built');
  assert.equal(p.text, "Posted: 2026-11-25T09:10:00-0800\nWhere: Sparks\ncompensation: $2,000 & up\nemployment type: contract\n\nLooking for someone to build a 12x20 patio cover.\nCall me 'soon'.");
  assert.doesNotMatch(p.text, /QR Code|tracking/);
});

test('a Craigslist search page becomes a list of posts with their links', async () => {
  const url = 'https://reno.craigslist.org/search/ggg?query=gazebo';
  pages[url] = { html: SEARCH, landed: 'https://www.craigslist.org/search/area/reno?cat=ggg&query=gazebo' };
  const p = await web.webRead(url);
  assert.equal(p.url, 'https://www.craigslist.org/search/area/reno?cat=ggg&query=gazebo');
  assert.equal(p.text, '2 posts on this page (newest first; open one with web_read for its date and text):\n- Gazebo help | $300 | Reno\n  https://www.craigslist.org/view/d/reno-gazebo-help/AAA\n- Hiring & paying\n  https://www.craigslist.org/view/d/reno-hiring/BBB');
});

test('Craigslist reading stays on Craigslist: no http, no lookalike hosts, no redirect away; gone posts say so', async () => {
  assert.equal(web.isCraigslist(new URL('http://reno.craigslist.org/x')), false);
  assert.equal(web.isCraigslist(new URL('https://craigslist.org.evil.com/x')), false);
  assert.equal(web.isCraigslist(new URL('https://evilcraigslist.org/x')), false);
  const away = 'https://reno.craigslist.org/away';
  pages[away] = { html: 'x', landed: 'http://127.0.0.1:8797/api/bots' };
  await assert.rejects(web.webRead(away), /redirects off Craigslist/);
  const gone = 'https://www.craigslist.org/view/d/old/OLD';
  pages[gone] = { html: 'gone', status: 410 };
  await assert.rejects(web.webRead(gone), /gone \(deleted or expired\)/);
});

test('Reddit and Facebook are refused up front with a useful message, without spending a call', async () => {
  seen.length = 0;
  await assert.rejects(web.webRead('https://www.reddit.com/r/Reno/comments/1'), /judge the post from its web_search snippet/i);
  await assert.rejects(web.webRead('https://m.facebook.com/groups/1/posts/2'), /can't be opened from here/);
  assert.equal(seen.length, 0);
});

test('other sites still go through Firecrawl; a site it refuses gets a plain message', async () => {
  firecrawl = [{ status: 200, body: { success: true, data: { markdown: '# Hi', metadata: { title: 'Blog' } } } }];
  const p = await web.webRead('https://example.com/post');
  assert.equal(p.title, 'Blog');
  assert.equal(p.text, '# Hi');
  firecrawl = [{ status: 403, body: { success: false, error: 'We do not support this site.' } }];
  await assert.rejects(web.webRead('https://nextdoor.com/p/1'), /can't be read from here.*search snippet/);
});

test('a rate-limited call waits as asked and retries once; a second limit is reported', async () => {
  slept.length = 0;
  firecrawl = [{ status: 429, body: { success: false }, headers: { 'retry-after': '7' } }, { status: 200, body: { success: true, data: [{ title: 'Ok', url: 'https://a.com/1' }] } }];
  const hits = await web.webSearch({ query: 'patio' });
  assert.deepEqual(slept, [7000]);
  assert.equal(hits[0].title, 'Ok');
  firecrawl = [{ status: 429, body: { success: false } }, { status: 429, body: { success: false } }];
  await assert.rejects(web.webSearch({ query: 'patio' }), /rate limited/);
  assert.deepEqual(slept, [7000, 10000], 'no Retry-After: waits 10 s');
  assert.equal(web.retryDelayMs('999'), 20000, 'never more than 20 s');
});
