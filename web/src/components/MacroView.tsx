import { useCallback, useEffect, useMemo, useState } from 'react';
import { configApi, type GtmCompany, type GtmCompanyRow, type GtmContactRow, type GtmOverview, type GtmThread } from '../lib/configApi';
import { api } from '../lib/api';
import { relativeShort } from '../lib/time';
import { useStore } from '../store';
import { useConfigUI } from '../configStore';

/**
 * GTM: the Macro workspace inside Bot HQ, edge to edge. macro.com itself refuses to be framed (X-Frame-Options:
 * DENY), so this is a native view over Macro's own MCP server on the bots' shared sign-in (server/src/macro-gtm.ts).
 * Inbox, companies and contacts on the left; the selected thread, company or contact on the right, with a hand-off
 * to any bot. Companies and contacts come from Macro's CRM when the Macro account is in a team, else from email.
 */

type Tab = 'inbox' | 'companies' | 'contacts';
type Sel = { kind: 'thread'; id: string } | { kind: 'company'; row: GtmCompanyRow } | { kind: 'contact'; row: GtmContactRow } | null;

const MACRO_APP = 'https://macro.com/app';
const ago = (iso: string | null) => {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const r = relativeShort(t);
  return r === 'now' ? 'now' : /^\d/.test(r) ? `${r} ago` : r;
};
const who = (p: { name: string | null; email: string | null } | null) => (p ? p.name || p.email || 'Unknown' : 'Unknown');

export function MacroView() {
  const [data, setData] = useState<GtmOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('inbox');
  const [sel, setSel] = useState<Sel>(null);

  const load = useCallback((fresh = false) => {
    setLoading(true); setError(null);
    configApi.gtmOverview(query, fresh)
      .then((d) => { setData(d); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not reach Macro'))
      .finally(() => setLoading(false));
  }, [query]);
  useEffect(() => { load(); }, [load]);

  const list = data ? (tab === 'inbox' ? data.threads.length : tab === 'companies' ? data.companies.length : data.contacts.length) : 0;
  const notSignedIn = error && /not signed in|expired|not set up/i.test(error);

  return (
    <main className="chat gtm">
      <header className="gtm__bar">
        <div className="gtm__brand"><span className="gtm__title">GTM</span><span className="gtm__by">Macro</span></div>
        <form className="gtm__search" onSubmit={(e) => { e.preventDefault(); setSel(null); setQuery(q.trim()); }}>
          <input className="text-input" type="search" placeholder="Search Macro: people, companies, email…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search Macro" />
        </form>
        <div className="segmented" role="tablist" aria-label="What to list">
          {(['inbox', 'companies', 'contacts'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)}>
              {t === 'inbox' ? 'Inbox' : t === 'companies' ? 'Companies' : 'Contacts'}
              {data && <span className="gtm__count">{t === 'inbox' ? data.threads.length : t === 'companies' ? data.companies.length : data.contacts.length}</span>}
            </button>
          ))}
        </div>
        <button type="button" className="link-btn link-btn--small" onClick={() => load(true)} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        <a className="btn btn--secondary btn--sm" href={MACRO_APP} target="_blank" rel="noreferrer noopener">Open Macro</a>
      </header>

      {data && !data.crm && (
        <div className="gtm__banner" role="note">
          Macro’s CRM turns on when your Macro account is in a team (Macro → Settings → Team). Until then, companies and contacts here come from your Macro email.
        </div>
      )}

      {notSignedIn ? (
        <div className="gtm__empty">
          <div className="gtm__empty-title">Connect Macro</div>
          <div className="gtm__empty-sub">{error}</div>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => useConfigUI.getState().openAppSettings('apps')}>Open Connected apps</button>
        </div>
      ) : (
        <div className="gtm__body">
          <section className="gtm__list" aria-label="List">
            {error && <div className="card__error" role="alert">{error}</div>}
            {!data && !error && <div className="gtm__hint">Loading from Macro…</div>}
            {data && list === 0 && <div className="gtm__hint">{query ? `Nothing in Macro matches “${query}”.` : 'Nothing here yet.'}</div>}
            {data && tab === 'inbox' && data.threads.map((t) => (
              <button key={t.id} type="button" className={`gtm-row${sel?.kind === 'thread' && sel.id === t.id ? ' is-active' : ''}${t.read ? '' : ' is-unread'}`} onClick={() => setSel({ kind: 'thread', id: t.id })}>
                <span className="gtm-row__top"><span className="gtm-row__who">{who(t.from)}</span><span className="gtm-row__time">{ago(t.at)}</span></span>
                <span className="gtm-row__title">{t.subject || '(no subject)'}</span>
                {t.count > 1 && <span className="gtm-row__meta">{t.count} messages</span>}
              </button>
            ))}
            {data && tab === 'companies' && data.companies.map((c) => (
              <button key={c.id ?? c.domain ?? ''} type="button" className={`gtm-row${sel?.kind === 'company' && (sel.row.id ?? sel.row.domain) === (c.id ?? c.domain) ? ' is-active' : ''}`} onClick={() => setSel({ kind: 'company', row: c })}>
                <span className="gtm-row__top"><span className="gtm-row__who">{c.name || c.domain || 'Company'}</span><span className="gtm-row__time">{ago(c.lastAt)}</span></span>
                <span className="gtm-row__meta">{[c.name && c.domain, c.source === 'email' && `${c.threads} thread${c.threads === 1 ? '' : 's'} · ${c.people} ${c.people === 1 ? 'person' : 'people'}`].filter(Boolean).join(' · ')}</span>
              </button>
            ))}
            {data && tab === 'contacts' && data.contacts.map((p) => (
              <button key={p.id ?? p.email ?? ''} type="button" className={`gtm-row${sel?.kind === 'contact' && (sel.row.id ?? sel.row.email) === (p.id ?? p.email) ? ' is-active' : ''}`} onClick={() => setSel({ kind: 'contact', row: p })}>
                <span className="gtm-row__top"><span className="gtm-row__who">{p.name || p.email}</span><span className="gtm-row__time">{ago(p.lastAt)}</span></span>
                <span className="gtm-row__meta">{[p.name && p.email, p.company].filter(Boolean).join(' · ')}</span>
              </button>
            ))}
          </section>
          <section className="gtm__detail" aria-label="Details">
            {!sel && <div className="gtm__empty"><div className="gtm__empty-title">Pick something on the left</div><div className="gtm__empty-sub">Open an email thread, a company or a person to see the history and hand it to a bot.</div></div>}
            {sel?.kind === 'thread' && <ThreadDetail key={sel.id} id={sel.id} />}
            {sel?.kind === 'company' && <CompanyDetail key={sel.row.id ?? sel.row.domain} row={sel.row} onThread={(id) => setSel({ kind: 'thread', id })} />}
            {sel?.kind === 'contact' && data && <ContactDetail key={sel.row.id ?? sel.row.email} row={sel.row} threads={data.threads} onThread={(id) => setSel({ kind: 'thread', id })} />}
          </section>
        </div>
      )}
    </main>
  );
}

/** Send a short brief about the selected item to a bot, then open that bot's chat. */
function HandOff({ brief }: { brief: string }) {
  const bots = useStore((s) => s.bots);
  // Bots and team channels alike: a team hands the brief to its lead.
  const agents = useMemo(() => bots.filter((b) => !(b as { hidden?: boolean }).hidden), [bots]);
  const [botId, setBotId] = useState<string>(() => agents.find((b) => b.isPrimary)?.id ?? agents[0]?.id ?? '');
  const [ask, setAsk] = useState('Summarize this and suggest the next step.');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!agents.length) return null;
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      await api.send(botId, `${ask.trim()}\n\n[From GTM · Macro] ${brief}`);
      useStore.getState().selectBot(botId);
      useConfigUI.getState().setView('chat');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not send'); setBusy(false); }
  };
  return (
    <form className="gtm-handoff" onSubmit={(e) => { e.preventDefault(); if (ask.trim() && botId) send(); }}>
      <select className="text-input gtm-handoff__bot" value={botId} onChange={(e) => setBotId(e.target.value)} aria-label="Bot or team">
        {agents.map((b) => <option key={b.id} value={b.id}>{b.name}{(b.kind ?? 'agent') === 'team' ? ' (team)' : ''}</option>)}
      </select>
      <input className="text-input gtm-handoff__ask" value={ask} onChange={(e) => setAsk(e.target.value)} aria-label="What should the bot do?" />
      <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !ask.trim()}>{busy ? 'Sending…' : 'Hand to bot'}</button>
      {err && <span className="card__error">{err}</span>}
    </form>
  );
}

function ThreadDetail({ id }: { id: string }) {
  const [t, setT] = useState<Awaited<ReturnType<typeof configApi.gtmThread>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { configApi.gtmThread(id).then(setT).catch((e) => setError(e instanceof Error ? e.message : 'Could not open the thread')); }, [id]);
  if (error) return <div className="gtm__pad"><div className="card__error" role="alert">{error}</div></div>;
  if (!t) return <div className="gtm__hint">Opening…</div>;
  const subject = t.messages.find((m) => m.subject)?.subject || '(no subject)';
  const last = t.messages[t.messages.length - 1];
  return (
    <div className="gtm-detail">
      <div className="gtm-detail__head">
        <h2 className="gtm-detail__title">{subject}</h2>
        <div className="gtm-detail__sub">{t.messages.length} message{t.messages.length === 1 ? '' : 's'}{last ? ` · last from ${who(last.from)} ${ago(last.at)}` : ''}</div>
        <HandOff brief={`Email thread "${subject}"${last ? ` with ${who(last.from)}${last.from?.email ? ` <${last.from.email}>` : ''}` : ''} (Macro email thread id ${t.id}). Read it in Macro.`} />
      </div>
      <div className="gtm-detail__scroll">
        {t.messages.map((m) => (
          <article key={m.id} className="gtm-msg">
            <header className="gtm-msg__head"><span className="gtm-msg__from">{who(m.from)}</span>{m.from?.email && m.from.name && <span className="gtm-msg__addr">{m.from.email}</span>}<span className="gtm-msg__time">{ago(m.at)}</span></header>
            <div className="gtm-msg__body">{m.body || '(empty)'}</div>
          </article>
        ))}
      </div>
    </div>
  );
}

function ThreadList({ threads, onThread }: { threads: GtmThread[]; onThread: (id: string) => void }) {
  if (!threads.length) return <div className="gtm__hint">No email threads found.</div>;
  return (
    <div className="gtm-sublist">
      {threads.map((t) => (
        <button key={t.id} type="button" className="gtm-row" onClick={() => onThread(t.id)}>
          <span className="gtm-row__top"><span className="gtm-row__who">{who(t.from)}</span><span className="gtm-row__time">{ago(t.at)}</span></span>
          <span className="gtm-row__title">{t.subject || '(no subject)'}</span>
        </button>
      ))}
    </div>
  );
}

function CompanyDetail({ row, onThread }: { row: GtmCompanyRow; onThread: (id: string) => void }) {
  const [c, setC] = useState<GtmCompany | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { configApi.gtmCompany({ id: row.id, domain: row.domain }).then(setC).catch((e) => setError(e instanceof Error ? e.message : 'Could not open the company')); }, [row.id, row.domain]);
  const name = c?.name || row.name || row.domain || 'Company';
  return (
    <div className="gtm-detail">
      <div className="gtm-detail__head">
        <h2 className="gtm-detail__title">{name}</h2>
        <div className="gtm-detail__sub">{[c?.domain || row.domain, row.source === 'crm' ? 'Macro CRM' : 'From email'].filter(Boolean).join(' · ')}</div>
        {c?.description && <p className="gtm-detail__desc">{c.description}</p>}
        <HandOff brief={`Company ${name}${(c?.domain || row.domain) ? ` (${c?.domain || row.domain})` : ''}${row.id ? `, Macro CRM company id ${row.id}` : ''}. Look it up in Macro: its people and email history.`} />
      </div>
      <div className="gtm-detail__scroll">
        {error && <div className="card__error" role="alert">{error}</div>}
        {!c && !error && <div className="gtm__hint">Loading from Macro…</div>}
        {c && c.contacts.length > 0 && (
          <>
            <div className="gtm-detail__label">People</div>
            <div className="gtm-people">{c.contacts.map((p) => <div key={p.id} className="gtm-person"><span className="gtm-person__name">{p.name || p.email}</span>{p.name && <span className="gtm-person__mail">{p.email}</span>}<span className="gtm-row__time">{ago(p.lastAt)}</span></div>)}</div>
          </>
        )}
        {c && (<><div className="gtm-detail__label">Email</div><ThreadList threads={c.threads} onThread={onThread} /></>)}
      </div>
    </div>
  );
}

function ContactDetail({ row, threads, onThread }: { row: GtmContactRow; threads: GtmThread[]; onThread: (id: string) => void }) {
  const email = row.email?.toLowerCase();
  const mine = threads.filter((t) => email && t.participants.some((p) => p.email?.toLowerCase() === email));
  return (
    <div className="gtm-detail">
      <div className="gtm-detail__head">
        <h2 className="gtm-detail__title">{row.name || row.email}</h2>
        <div className="gtm-detail__sub">{[row.name && row.email, row.company, row.source === 'crm' ? 'Macro CRM' : 'From email'].filter(Boolean).join(' · ')}</div>
        <HandOff brief={`Contact ${row.name || ''}${row.email ? ` <${row.email}>` : ''}${row.company ? ` at ${row.company}` : ''}${row.id ? `, Macro CRM contact id ${row.id}` : ''}. Look them up in Macro: their email history.`} />
      </div>
      <div className="gtm-detail__scroll">
        <div className="gtm-detail__label">Recent email</div>
        <ThreadList threads={mine} onThread={onThread} />
      </div>
    </div>
  );
}
