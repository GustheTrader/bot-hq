import { MacroError, runMacroProgram } from './macro-client.js';

/**
 * GTM view data from Macro. Each read is one fixed program (written here, never from the browser) run with
 * Macro's ExecuteCode on the shared sign-in. Inputs are validated and embedded as JSON literals.
 *
 * Macro turns its CRM on only for accounts that are in a Macro team. Without one, the view still works from
 * email: threads are grouped by the other side's domain into "companies" and their people into "contacts".
 */

export interface Person { name: string | null; email: string }
export interface ThreadRow { id: string; subject: string; from: Person | null; participants: Person[]; at: string | null; read: boolean; count: number }
export interface CompanyRow { id: string | null; name: string | null; domain: string | null; threads: number; people: number; lastAt: string | null; source: 'crm' | 'email' }
export interface ContactRow { id: string | null; name: string | null; email: string | null; company: string | null; lastAt: string | null; source: 'crm' | 'email' }
export interface Overview { crm: boolean; me: string | null; companies: CompanyRow[]; contacts: ContactRow[]; threads: ThreadRow[] }

const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'msn.com']);
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export function checkQuery(raw: unknown): string {
  const q = typeof raw === 'string' ? raw.trim() : '';
  if (q.length > 200) throw new MacroError('Search is too long.', 400);
  return q;
}
export function checkId(raw: unknown): string {
  if (typeof raw !== 'string' || !ID_RE.test(raw)) throw new MacroError('Unknown item.', 400);
  return raw;
}
export function checkDomain(raw: unknown): string {
  if (typeof raw !== 'string' || !DOMAIN_RE.test(raw)) throw new MacroError('Unknown domain.', 400);
  return raw.toLowerCase();
}

const domainOf = (email: string | null | undefined) => (email && email.includes('@') ? email.split('@').pop()!.toLowerCase() : null);

const THREAD_ROW = `async (t: any) => {
    const [msgs, parts, at, read] = await Promise.all([t.messages(), t.participants(), t.latestNonSpamAt(), t.isRead()]);
    const last = msgs[msgs.length - 1];
    const from = last ? await last.from() : undefined;
    return { id: t.id, subject: last ? ((await last.subject()) ?? '') : '', from: from ? { name: from.name ?? null, email: from.email } : null,
      participants: parts.slice(0, 10).map((p: any) => ({ name: p.name ?? null, email: p.email })), at: at ?? null, read, count: msgs.length };
  }`;

export const overviewProgram = (q: string) => `// Bot HQ GTM overview: CRM companies and contacts (when CRM is on) and recent email threads, compact.
export async function main({ macro }: any) {
  const q: string = ${JSON.stringify(q)};
  const row = ${THREAD_ROW};
  const out: any = { crm: false, me: null, companies: [], contacts: [], threads: [] };
  const access = await macro.crm.access();
  out.crm = !!access.allowed;
  if (out.crm) {
    const contacts: any[] = await macro.crm.searchContacts(q, { limit: 40 });
    const cos: any[] = await Promise.all(contacts.map((p: any) => p.company()));
    out.contacts = await Promise.all(contacts.map(async (p: any, i: number) => ({ id: p.id, name: (await p.name()) ?? null, email: (await p.email()) ?? null,
      company: cos[i] ? ((await cos[i].name()) ?? null) : null, lastAt: (await p.lastInteraction()) ?? null })));
    const seen = new Map<string, any>();
    if (q) { for await (const c of macro.crm.searchCompanies(q, { maxItems: 30 })) seen.set(c.id, c); }
    else { for (const c of cos) if (c) seen.set(c.id, c); }
    out.companies = await Promise.all([...seen.values()].slice(0, 40).map(async (c: any) => ({ id: c.id, name: (await c.name()) ?? null, domain: (await c.domain()) ?? null, lastAt: await c.updatedAt() })));
  }
  const it = q ? macro.email.search(q, { maxItems: 30 }) : macro.email.inbox({ maxItems: 30 });
  for await (const t of it) {
    out.threads.push(await row(t));
    if (!out.me) out.me = await (await t.link()).emailAddress();
  }
  return { data: out };
}
`;

export const threadProgram = (id: string) => `// Bot HQ GTM: one email thread's messages (sender, time, subject, body), newest last.
export async function main({ macro }: any) {
  const t = macro.email.byId(${JSON.stringify(id)});
  const msgs: any[] = await t.messages();
  const out = await Promise.all(msgs.slice(-12).map(async (m: any) => {
    const from = await m.from();
    return { id: m.id, from: from ? { name: from.name ?? null, email: from.email } : null, at: (await m.sentAt()) ?? null, subject: (await m.subject()) ?? '', body: ((await m.body()) ?? '').slice(0, 60000) };
  }));
  return { data: { id: t.id, messages: out } };
}
`;

export const companyProgram = (id: string | null, domain: string | null) => `// Bot HQ GTM: one company (CRM record when there is one) with its people and recent email threads.
export async function main({ macro }: any) {
  const id: string | null = ${JSON.stringify(id)};
  let domain: string | null = ${JSON.stringify(domain)};
  const row = ${THREAD_ROW};
  const out: any = { id, name: null, domain, domains: [], description: null, contacts: [], threads: [] };
  if (id) {
    const c = macro.crm.companyById(id);
    const [name, d, ds, desc, people] = await Promise.all([c.name(), c.domain(), c.domains(), c.description(), c.contacts()]);
    out.name = name ?? null; out.domain = d ?? domain; out.domains = ds; out.description = desc ?? null;
    out.contacts = await Promise.all(people.slice(0, 50).map(async (p: any) => ({ id: p.id, name: (await p.name()) ?? null, email: (await p.email()) ?? null, lastAt: (await p.lastInteraction()) ?? null })));
    domain = out.domain;
  }
  if (domain) { for await (const t of macro.email.search(domain, { maxItems: 20 })) out.threads.push(await row(t)); }
  return { data: out };
}
`;

/** Without CRM: companies and contacts derived from the threads' other participants. */
export function fromEmail(threads: ThreadRow[], me: string | null): { companies: CompanyRow[]; contacts: ContactRow[] } {
  const mine = domainOf(me);
  const people = new Map<string, ContactRow & { n: number }>();
  const orgs = new Map<string, CompanyRow & { emails: Set<string> }>();
  for (const t of threads) {
    for (const p of t.participants) {
      const email = p.email?.toLowerCase();
      if (!email || email === me?.toLowerCase()) continue;
      const d = domainOf(email);
      const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
      const prev = people.get(email);
      people.set(email, { id: null, name: prev?.name ?? p.name ?? null, email, company: d && !FREE_MAIL.has(d) ? d : null, lastAt: later(prev?.lastAt ?? null, t.at), source: 'email', n: (prev?.n ?? 0) + 1 });
      if (!d || d === mine || FREE_MAIL.has(d)) continue;
      const o = orgs.get(d) ?? { id: null, name: null, domain: d, threads: 0, people: 0, lastAt: null, source: 'email' as const, emails: new Set<string>() };
      if (!o.emails.has(`${t.id}`)) { o.threads++; o.emails.add(`${t.id}`); }
      o.lastAt = later(o.lastAt, t.at);
      orgs.set(d, o);
    }
  }
  for (const [email, p] of people) { const d = domainOf(email); const o = d ? orgs.get(d) : undefined; if (o) o.people++; void p; }
  const byRecent = (a: { lastAt: string | null }, b: { lastAt: string | null }) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? ''));
  return {
    companies: [...orgs.values()].map(({ emails: _e, ...o }) => o).sort(byRecent),
    contacts: [...people.values()].map(({ n: _n, ...p }) => p).sort(byRecent),
  };
}

const cache = new Map<string, { at: number; data: Overview }>();
const CACHE_MS = 60_000;

export async function gtmOverview(qRaw: unknown, fresh = false): Promise<Overview> {
  const q = checkQuery(qRaw);
  const hit = cache.get(q);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const raw = await runMacroProgram<any>(overviewProgram(q));
  const threads: ThreadRow[] = raw?.threads ?? [];
  let data: Overview;
  if (raw?.crm) {
    data = {
      crm: true, me: raw.me ?? null, threads,
      companies: (raw.companies ?? []).map((c: any) => ({ id: c.id, name: c.name, domain: c.domain, threads: 0, people: 0, lastAt: c.lastAt ?? null, source: 'crm' })),
      contacts: (raw.contacts ?? []).map((p: any) => ({ id: p.id, name: p.name, email: p.email, company: p.company, lastAt: p.lastAt ?? null, source: 'crm' })),
    };
  } else {
    data = { crm: false, me: raw?.me ?? null, threads, ...fromEmail(threads, raw?.me ?? null) };
  }
  cache.set(q, { at: Date.now(), data });
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  return data;
}

/** HTML email bodies as readable plain text (no markup reaches the page). */
export function toPlainText(body: string): string {
  if (!/<[a-z!/][\s\S]*>/i.test(body)) return body.trim();
  return body
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function gtmThread(idRaw: unknown) {
  const id = checkId(idRaw);
  const raw = await runMacroProgram<any>(threadProgram(id));
  return { id: raw.id, messages: (raw.messages ?? []).map((m: any) => ({ ...m, body: toPlainText(String(m.body ?? '')).slice(0, 20000) })) };
}

export async function gtmCompany(idRaw: unknown, domainRaw: unknown) {
  const id = idRaw ? checkId(idRaw) : null;
  const domain = domainRaw ? checkDomain(domainRaw) : null;
  if (!id && !domain) throw new MacroError('Pick a company.', 400);
  return runMacroProgram<any>(companyProgram(id, domain));
}
