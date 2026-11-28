import { db, now } from './db.js';
import { executeComposio } from './composio.js';

/**
 * Leads CRM: a Notion database the bots fill with the leads they find (Sam, the Sierra Home Pro
 * lead scout, first), mirrored into the Google Sheet tabs the team already works from.
 *
 * Writes go through the user's own Composio connections (Notion, Google Sheets), so no token is
 * stored here. The rules live in code, not in a prompt: one row per lead (matched on a key built
 * from its link, or name + area when there is none), Tier comes from Score, and a lead's Status is
 * never moved backwards by a re-scrape, because people change it in Notion.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS leads_crm (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notion_database_id TEXT NOT NULL,
  notion_url TEXT,
  sheet_id TEXT,
  updated_at INTEGER NOT NULL
);
`);

export type Tier = 'Hot' | 'Warm' | 'Cold';
export type Category = 'Handyman' | 'Outdoor';
export const STATUSES = ['New', 'Contacted', 'Quoted', 'Won', 'Lost'] as const;

/** Score 0–100 → tier. One rule for every bot and every run. */
export function tierFor(score: number): Tier {
  return score >= 70 ? 'Hot' : score >= 40 ? 'Warm' : 'Cold';
}

export interface LeadIn {
  name: string;
  category: Category;
  service: string;
  score: number;
  area?: string;
  source?: string;
  url?: string;
  phone?: string;
  email?: string;
  posted?: string;
  reason?: string;
  reply_draft?: string;
  budget?: string;
}

/** The Notion columns, in the order the database is created with. */
const COLUMNS: { name: string; type: string }[] = [
  { name: 'Lead', type: 'title' },
  { name: 'Tier', type: 'select' },
  { name: 'Score', type: 'number' },
  { name: 'Category', type: 'select' },
  { name: 'Service', type: 'rich_text' },
  { name: 'Status', type: 'select' },
  { name: 'Area', type: 'rich_text' },
  { name: 'Source', type: 'select' },
  { name: 'URL', type: 'url' },
  { name: 'Phone', type: 'phone_number' },
  { name: 'Email', type: 'email' },
  { name: 'Posted', type: 'date' },
  { name: 'Found', type: 'date' },
  { name: 'Reason', type: 'rich_text' },
  { name: 'Reply draft', type: 'rich_text' },
  { name: 'Budget', type: 'rich_text' },
  { name: 'Key', type: 'rich_text' },
];

// ---------- the Composio calls (swappable in tests) ----------

type Runner = (userId: string, slug: string, args: Record<string, unknown>) => Promise<any>;
let run: Runner = async (userId, slug, args) => {
  const r = await executeComposio(userId, slug, args);
  const err = (r as any)?.error ?? ((r as any)?.successful === false ? 'the action failed' : null);
  if (err) throw new Error(`${slug}: ${typeof err === 'string' ? err : JSON.stringify(err)}`.slice(0, 300));
  return (r as any)?.data ?? r;
};
export function setRunnerForTests(fn: Runner) { run = fn; }

/** Composio sometimes wraps the API answer once more. */
const unwrap = (d: any) => d?.response_data ?? d?.data ?? d;

// ---------- config ----------

export interface CrmConfig { notionDatabaseId: string; notionUrl: string | null; sheetId: string | null }
export function crmConfig(userId: string): CrmConfig | null {
  const r = db.prepare('SELECT * FROM leads_crm WHERE user_id=?').get(userId) as any;
  return r ? { notionDatabaseId: r.notion_database_id, notionUrl: r.notion_url ?? null, sheetId: r.sheet_id ?? null } : null;
}

/** A Notion page or database id from a URL or a bare id (32 hex, with or without dashes). */
export function notionId(s: string): string | null {
  const m = /([0-9a-f]{32})(?:[?#].*)?$/i.exec(s.replace(/-/g, '')) ?? /([0-9a-f]{32})/i.exec(s.replace(/-/g, ''));
  return m ? m[1].toLowerCase() : null;
}
export function sheetId(s: string): string | null {
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(s) ?? /^([A-Za-z0-9_-]{30,})$/.exec(s.trim());
  return m ? m[1] : null;
}

/**
 * Create the leads database under a Notion page (or adopt an existing database) and remember it,
 * with the Google Sheet to mirror into. Calling it again only changes what was given.
 */
export async function setupCrm(userId: string, opts: { parentPage?: string; database?: string; sheet?: string; title?: string }): Promise<CrmConfig> {
  const have = crmConfig(userId);
  let dbId = have?.notionDatabaseId ?? null;
  let url = have?.notionUrl ?? null;
  if (opts.database) {
    dbId = notionId(opts.database);
    if (!dbId) throw new Error('That isn’t a Notion database link or id.');
    url = opts.database.startsWith('http') ? opts.database : url;
  } else if (opts.parentPage) {
    const parent = notionId(opts.parentPage);
    if (!parent) throw new Error('That isn’t a Notion page link or id.');
    const made = unwrap(await run(userId, 'NOTION_CREATE_DATABASE', { parent_id: parent, title: opts.title?.trim() || 'Leads', properties: COLUMNS }));
    dbId = notionId(String(made?.id ?? '')) ;
    url = typeof made?.url === 'string' ? made.url : null;
    if (!dbId) throw new Error('Notion did not return the new database.');
  }
  if (!dbId) throw new Error('Give a Notion page to create the database under, or an existing database.');
  const sheet = opts.sheet ? sheetId(opts.sheet) : have?.sheetId ?? null;
  if (opts.sheet && !sheet) throw new Error('That isn’t a Google Sheets link.');
  db.prepare(`INSERT INTO leads_crm(user_id, notion_database_id, notion_url, sheet_id, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET notion_database_id=excluded.notion_database_id, notion_url=excluded.notion_url, sheet_id=excluded.sheet_id, updated_at=excluded.updated_at`)
    .run(userId, dbId, url, sheet, now());
  return crmConfig(userId)!;
}

// ---------- leads ----------

/** The duplicate key: the link without tracking bits, else name + area. */
export function leadKey(l: Pick<LeadIn, 'url' | 'name' | 'area'>): string {
  if (l.url) {
    try {
      const u = new URL(l.url.trim());
      for (const p of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref|mibextid|s$|si$)/i.test(p)) u.searchParams.delete(p);
      u.hash = '';
      return `${u.host.replace(/^(www|m)\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
    } catch { /* not a URL: fall through */ }
  }
  const part = (s?: string) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${part(l.name)}|${part(l.area)}`;
}

const clip = (s: unknown, n = 1900) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const isoDate = (s?: string) => {
  if (!s) return '';
  // A date written as YYYY-MM-DD (with or without a time) is kept as written: converting it to UTC
  // would move an evening post in Reno to the next day.
  const lit = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(s.trim());
  if (lit && !Number.isNaN(new Date(`${lit[1]}T00:00:00Z`).getTime())) return lit[1];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

export function validateLead(l: any): LeadIn | string {
  if (!l || typeof l !== 'object') return 'not an object';
  const name = clip(l.name, 200);
  if (!name) return 'name is required';
  const category = /^outdoor/i.test(String(l.category ?? '')) ? 'Outdoor' : /^handy/i.test(String(l.category ?? '')) ? 'Handyman' : null;
  if (!category) return 'category must be Handyman or Outdoor';
  const score = Number(l.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) return 'score must be 0–100';
  const service = clip(l.service, 500);
  if (!service) return 'service is required';
  const url = clip(l.url, 600);
  if (url && !/^https?:\/\//i.test(url)) return 'url must start with http(s)://';
  return { name, category, service, score: Math.round(score), area: clip(l.area, 200), source: clip(l.source, 80), url, phone: clip(l.phone, 40), email: clip(l.email, 200), posted: clip(l.posted, 40), reason: clip(l.reason), reply_draft: clip(l.reply_draft), budget: clip(l.budget, 100) };
}

function props(l: LeadIn, key: string, isNew: boolean) {
  const p: { name: string; type: string; value: string }[] = [
    { name: 'Lead', type: 'title', value: l.name },
    { name: 'Tier', type: 'select', value: tierFor(l.score) },
    { name: 'Score', type: 'number', value: String(l.score) },
    { name: 'Category', type: 'select', value: l.category },
    { name: 'Service', type: 'rich_text', value: l.service },
    { name: 'Key', type: 'rich_text', value: key },
  ];
  const opt = (name: string, type: string, value?: string) => { if (value) p.push({ name, type, value }); };
  opt('Area', 'rich_text', l.area);
  opt('Source', 'select', l.source?.replace(/,/g, ' '));
  opt('URL', 'url', l.url);
  opt('Phone', 'phone_number', l.phone);
  opt('Email', 'email', l.email);
  opt('Posted', 'date', isoDate(l.posted));
  opt('Reason', 'rich_text', l.reason);
  opt('Reply draft', 'rich_text', l.reply_draft);
  opt('Budget', 'rich_text', l.budget);
  if (isNew) { p.push({ name: 'Status', type: 'select', value: 'New' }, { name: 'Found', type: 'date', value: new Date().toISOString().slice(0, 10) }); }
  return p;
}

async function findByKey(userId: string, dbId: string, key: string): Promise<{ id: string; score: number | null } | null> {
  const r = unwrap(await run(userId, 'NOTION_QUERY_DATABASE_WITH_FILTER', { database_id: dbId, page_size: 1, filter: { property: 'Key', rich_text: { equals: key } } }));
  const row = (Array.isArray(r?.results) ? r.results : [])[0];
  if (!row?.id) return null;
  const score = row?.properties?.Score?.number;
  return { id: String(row.id), score: typeof score === 'number' ? score : null };
}

/** The Sheet tab row, in the order of the Handyman / Outdoor Jobs columns. */
function sheetRow(l: LeadIn, key: string): string[] {
  const today = new Date().toISOString().slice(0, 10);
  return [key, l.name, l.area ?? '', l.service, 'Lead', tierFor(l.score), l.phone ?? '', l.source ?? '', l.url ?? '', l.reason ?? '', l.reply_draft ? 'Reply draft ready' : 'Review', l.budget ?? '', 'New', l.posted ?? '', '', today];
}

export interface UpsertResult { added: number; updated: number; unchanged: number; failed: { name: string; error: string }[]; mirrored: number; mirrorError: string | null; hot: string[] }

/** Add or update leads (max 25 per call). New leads are also appended to the Sheet tab for their category. */
export async function upsertLeads(userId: string, raw: unknown[]): Promise<UpsertResult> {
  const cfg = crmConfig(userId);
  if (!cfg) throw new Error('The leads CRM isn’t set up yet. Ask the user to connect Notion, then run leads_crm_setup with a Notion page.');
  const out: UpsertResult = { added: 0, updated: 0, unchanged: 0, failed: [], mirrored: 0, mirrorError: null, hot: [] };
  const fresh: { lead: LeadIn; key: string }[] = [];
  const seen = new Set<string>();
  // Over the limit: reported back so the bot sends the rest in another call, never silently dropped.
  for (const r of raw.slice(25)) out.failed.push({ name: String((r as any)?.name ?? '?').slice(0, 80), error: 'over the 25-per-call limit: send it again in another call' });
  for (const r of raw.slice(0, 25)) {
    const lead = validateLead(r);
    if (typeof lead === 'string') { out.failed.push({ name: String((r as any)?.name ?? '?').slice(0, 80), error: lead }); continue; }
    const key = leadKey(lead);
    if (seen.has(key)) { out.unchanged++; continue; }
    seen.add(key);
    try {
      const have = await findByKey(userId, cfg.notionDatabaseId, key);
      if (have) {
        if (have.score === lead.score) { out.unchanged++; continue; }
        // Status and Found belong to whoever works the lead in Notion: never touched on an update.
        await run(userId, 'NOTION_UPDATE_ROW_DATABASE', { row_id: have.id, properties: props(lead, key, false) });
        out.updated++;
      } else {
        await run(userId, 'NOTION_INSERT_ROW_DATABASE', { database_id: cfg.notionDatabaseId, properties: props(lead, key, true) });
        out.added++;
        fresh.push({ lead, key });
      }
      if (tierFor(lead.score) === 'Hot') out.hot.push(lead.name);
    } catch (e: any) {
      out.failed.push({ name: lead.name, error: String(e?.message ?? e).slice(0, 200) });
    }
  }
  if (cfg.sheetId && fresh.length) {
    for (const [tab, cat] of [['Handyman', 'Handyman'], ['Outdoor Jobs', 'Outdoor']] as const) {
      const rows = fresh.filter((f) => f.lead.category === cat).map((f) => sheetRow(f.lead, f.key));
      if (!rows.length) continue;
      try {
        // RAW, not USER_ENTERED: lead text comes from strangers' posts, and a cell starting with "=" must
        // stay text in the Sheet, never run as a formula (e.g. =IMPORTXML or =HYPERLINK).
        await run(userId, 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND', { spreadsheetId: cfg.sheetId, range: `'${tab}'!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', values: rows });
        out.mirrored += rows.length;
      } catch (e: any) {
        // Notion is the record; a Sheet hiccup (they time out) never undoes it.
        out.mirrorError = String(e?.message ?? e).slice(0, 200);
      }
    }
  }
  return out;
}

export interface LeadOut { name: string; tier: string; score: number | null; category: string; service: string; status: string; area: string; url: string | null }

/** The top leads, best score first, optionally only one tier or status. */
export async function listLeads(userId: string, opts: { tier?: string; status?: string; limit?: number }): Promise<LeadOut[]> {
  const cfg = crmConfig(userId);
  if (!cfg) throw new Error('The leads CRM isn’t set up yet.');
  const and: any[] = [];
  if (opts.tier) and.push({ property: 'Tier', select: { equals: opts.tier } });
  if (opts.status) and.push({ property: 'Status', select: { equals: opts.status } });
  const r = unwrap(await run(userId, 'NOTION_QUERY_DATABASE_WITH_FILTER', {
    database_id: cfg.notionDatabaseId, page_size: Math.min(Math.max(opts.limit ?? 20, 1), 50),
    sorts: [{ property: 'Score', direction: 'descending' }],
    ...(and.length ? { filter: and.length === 1 ? and[0] : { and } } : {}),
  }));
  const text = (p: any) => (p?.title ?? p?.rich_text ?? []).map((t: any) => t?.plain_text ?? '').join('');
  return (Array.isArray(r?.results) ? r.results : []).map((row: any) => {
    const p = row?.properties ?? {};
    return { name: text(p.Lead), tier: p.Tier?.select?.name ?? '', score: p.Score?.number ?? null, category: p.Category?.select?.name ?? '', service: text(p.Service), status: p.Status?.select?.name ?? '', area: text(p.Area), url: p.URL?.url ?? null };
  });
}
