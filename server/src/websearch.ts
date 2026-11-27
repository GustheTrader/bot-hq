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

export const webSearchEnabled = () => !!env.firecrawlKey;

async function call(path: string, body: unknown, timeoutMs: number): Promise<any> {
  if (!env.firecrawlKey) throw new Error('Web search is not set up (FIRECRAWL_API_KEY is empty).');
  const res = await doFetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.firecrawlKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || data?.success === false) {
    const why = data?.error ?? text.slice(0, 200);
    if (res.status === 402) throw new Error('Web search is out of Firecrawl credits.');
    if (res.status === 429) throw new Error('Web search is busy (rate limited); wait a minute and try again.');
    throw new Error(`Web search failed (${res.status}): ${why}`);
  }
  return data;
}

export type SearchHit = { title: string; url: string; snippet: string };

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
  return (Array.isArray(data?.data) ? data.data : []).map((h: any) => ({
    title: String(h.title ?? ''),
    url: String(h.url ?? ''),
    snippet: String(h.description ?? '').slice(0, 400),
  })).filter((h: SearchHit) => h.url);
}

/** Read one page as text (markdown), cut to a size an agent can use. */
export async function webRead(rawUrl: string): Promise<{ url: string; title: string; text: string; cut: boolean }> {
  let u: URL;
  try { u = new URL(String(rawUrl ?? '').trim()); } catch { throw new Error('Give a full http(s) link.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Give a full http(s) link.');
  const data = await call('/scrape', { url: u.toString(), formats: ['markdown'], onlyMainContent: true }, 90_000);
  const md = String(data?.data?.markdown ?? '');
  return { url: u.toString(), title: String(data?.data?.metadata?.title ?? ''), text: md.slice(0, MAX_PAGE), cut: md.length > MAX_PAGE };
}
