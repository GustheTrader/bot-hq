import { env } from './env.js';

/**
 * Web search and page reading for every bot, through Firecrawl (FIRECRAWL_API_KEY).
 * Harness bots (Pi, Codex, Claude Code) get no web search of their own, so these are their way to the open web.
 */

const API = 'https://api.firecrawl.dev/v1';
const RECENT: Record<string, string> = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' };
const MAX_PAGE = 20_000;

type Fetch = typeof fetch;
let doFetch: Fetch = (...a) => fetch(...a);
/** Tests swap the network for a fake. */
export function setFetchForTests(f: Fetch | null) { doFetch = f ?? ((...a) => fetch(...a)); }

let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Tests skip the real waiting. */
export function setSleepForTests(f: ((ms: number) => Promise<void>) | null) { sleep = f ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))); }

export const webSearchEnabled = () => !!env.firecrawlKey;

/** How long a rate-limited call waits before its one retry: Firecrawl's Retry-After, else 10 s, at most 20 s. */
export function retryDelayMs(retryAfter: string | null): number {
  const s = Number(retryAfter);
  return Math.min(Math.max(Number.isFinite(s) && s > 0 ? s : 10, 1), 20) * 1000;
}

async function call(path: string, body: unknown, timeoutMs: number): Promise<any> {
  if (!env.firecrawlKey) throw new Error('Web search is not set up (FIRECRAWL_API_KEY is empty).');
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(`${API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.firecrawlKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Rate limited: wait as long as asked and try once more before giving the bot an error.
    if (res.status === 429 && attempt === 0) {
      await res.text().catch(() => '');
      await sleep(retryDelayMs(res.headers.get('retry-after')));
      continue;
    }
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok || data?.success === false) {
      const why = data?.error ?? text.slice(0, 200);
      if (res.status === 402) throw new Error('Web search is out of Firecrawl credits.');
      if (res.status === 429) throw new Error('Web search is busy (rate limited); wait a minute and try again.');
      throw new WebError(res.status, `Web search failed (${res.status}): ${why}`);
    }
    return data;
  }
}

/** A Firecrawl refusal with its HTTP status, so web_read can tell "site not supported" (403) from other failures. */
export class WebError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type SearchHit = { title: string; url: string; snippet: string };

/**
 * Firecrawl sometimes returns Google redirect links instead of the page. A plain `?q=`/`?url=` one is unwrapped.
 * An encoded one (google.com/goto?url=CAES...) hides its target and can't be read either, so it is dropped (null).
 */
export function unwrapLink(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return raw; }
  if (!/(^|\.)google\.[a-z.]+$/i.test(u.hostname) || !/^\/(url|goto)$/.test(u.pathname)) return raw;
  for (const k of ['q', 'url']) {
    const v = u.searchParams.get(k) ?? '';
    if (/^https?:\/\//i.test(v)) return v;
  }
  return null;
}

/** Search the web. `recent` limits results to the last day/week/month/year; `site` keeps them to one site. */
export async function webSearch(a: { query: string; limit?: number; recent?: string; site?: string }): Promise<SearchHit[]> {
  const q = String(a.query ?? '').trim();
  if (!q) throw new Error('Give a query.');
  const site = String(a.site ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const body: Record<string, unknown> = {
    query: site && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(site) ? `site:${site} ${q}` : q,
    limit: Math.min(Math.max(Math.round(Number(a.limit) || 8), 1), 20),
  };
  const tbs = RECENT[String(a.recent ?? '').toLowerCase()];
  if (tbs) body.tbs = tbs;
  const data = await call('/search', body, 60_000);
  const hits: SearchHit[] = [];
  for (const h of Array.isArray(data?.data) ? data.data : []) {
    const url = h?.url ? unwrapLink(String(h.url)) : null;
    if (url) hits.push({ title: String(h.title ?? ''), url, snippet: String(h.description ?? '').slice(0, 400) });
  }
  return hits;
}

/** Read one page as text (markdown), cut to a size an agent can use. */
export async function webRead(rawUrl: string): Promise<{ url: string; title: string; text: string; cut: boolean }> {
  let u: URL;
  try { u = new URL(String(rawUrl ?? '').trim()); } catch { throw new Error('Give a full http(s) link.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Give a full http(s) link.');
  if (isCraigslist(u)) return readCraigslist(u);
  if (onHost(u, UNREADABLE)) throw new Error(UNREADABLE_WHY);
  let data: any;
  try {
    data = await call('/scrape', { url: u.toString(), formats: ['markdown'], onlyMainContent: true }, 90_000);
  } catch (e) {
    if (e instanceof WebError && e.status === 403) throw new Error(`This site can't be read from here (the reader refuses it). Judge the post from its search snippet instead.`);
    throw e;
  }
  const md = String(data?.data?.markdown ?? '');
  return { url: u.toString(), title: String(data?.data?.metadata?.title ?? ''), text: md.slice(0, MAX_PAGE), cut: md.length > MAX_PAGE };
}

// ---------- sites the reader can't open ----------

const onHost = (u: URL, hosts: string[]) => hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));

/** Firecrawl refuses these, and they block this computer's own requests too (checked: Reddit answers 403). */
const UNREADABLE = ['reddit.com', 'redd.it', 'facebook.com', 'fb.com', 'fb.me'];
const UNREADABLE_WHY = 'Reddit and Facebook pages can\'t be opened from here. Judge the post from its web_search snippet (title, date and text shown there), and save it only if the snippet is clear enough.';

// ---------- Craigslist, read directly ----------

/**
 * Firecrawl refuses Craigslist, but Craigslist serves this computer plain HTML, so its pages are fetched directly.
 * Only https Craigslist addresses, also after redirects, so web_read can't be pointed at anything else from here.
 */
export const isCraigslist = (u: URL) => u.protocol === 'https:' && onHost(u, ['craigslist.org']);

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_HTML = 3 * 1024 * 1024;

async function readCraigslist(u: URL): Promise<{ url: string; title: string; text: string; cut: boolean }> {
  const res = await doFetch(u.toString(), { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  let landed: URL;
  try { landed = new URL(res.url || u.toString()); } catch { landed = u; }
  if (!isCraigslist(landed)) throw new Error('That Craigslist link redirects off Craigslist; not followed.');
  if (res.status === 404 || res.status === 410) throw new Error('That Craigslist post is gone (deleted or expired).');
  if (!res.ok) throw new Error(`Craigslist answered ${res.status}.`);
  const html = (await res.text()).slice(0, MAX_HTML);
  const page = parseCraigslist(html);
  const text = page.text || '(The page had no readable text.)';
  return { url: landed.toString(), title: page.title, text: text.slice(0, MAX_PAGE), cut: text.length > MAX_PAGE };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hearts: '♥' };
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const grab = (html: string, re: RegExp) => { const m = re.exec(html); return m ? htmlText(m[1]) : ''; };

/** A Craigslist search page becomes a list of posts with links; a post becomes its title, date, details and text. */
export function parseCraigslist(html: string): { title: string; text: string } {
  const pageTitle = grab(html, /<title>([\s\S]*?)<\/title>/i);
  if (html.includes('cl-static-search-result')) {
    const items: string[] = [];
    const re = /<li class="cl-static-search-result"[^>]*>([\s\S]*?)<\/li>/g;
    for (let m; (m = re.exec(html)) && items.length < 120;) {
      const li = m[1];
      const href = /<a href="(https:\/\/[^"]+)"/.exec(li)?.[1];
      if (!href) continue;
      const title = grab(li, /<div class="title">([\s\S]*?)<\/div>/);
      const price = grab(li, /<div class="price">([\s\S]*?)<\/div>/);
      const where = grab(li, /<div class="location">([\s\S]*?)<\/div>/);
      items.push(`- ${title}${price && price !== '$0' ? ` | ${price}` : ''}${where ? ` | ${where}` : ''}\n  ${href}`);
    }
    const head = `${items.length} posts on this page (newest first; open one with web_read for its date and text):`;
    return { title: pageTitle, text: items.length ? `${head}\n${items.join('\n')}` : 'No posts on this page.' };
  }
  const title = grab(html, /<span id="titletextonly">([\s\S]*?)<\/span>/) || pageTitle;
  const posted = /<time class="date timeago" datetime="([^"]+)"/.exec(html)?.[1] ?? '';
  const where = grab(html, /<span class="postingtitletext">[\s\S]*?<small>\s*\(([^)]*)\)/) || grab(html, /<div class="mapaddress">([\s\S]*?)<\/div>/);
  const attrs = [...html.matchAll(/<div class="attr[^"]*">([\s\S]*?)<\/div>/g)].map((m) => htmlText(m[1]).replace(/\s*\n\s*/g, ' ')).filter(Boolean);
  const body = grab(html, /<section id="postingbody">(?:\s*<div class="print-information[\s\S]*?<\/div>\s*<\/div>)?([\s\S]*?)<\/section>/);
  const head = [posted && `Posted: ${posted}`, where && `Where: ${where}`, ...attrs].filter(Boolean).join('\n');
  return { title, text: [head, body].filter(Boolean).join('\n\n') };
}
