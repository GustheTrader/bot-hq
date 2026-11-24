import { useCallback, useEffect, useState } from 'react';
import { configApi, type RouterConnection, type RouterFeature, type RouterInfo, type RouterProviderDef, type RouterTest } from '../../lib/configApi';
import { ConfirmButton, Switch } from './ui';

/**
 * Settings > Models: 9Router on the Bots' computer. Connect free and cheap open-model providers
 * (plus Google) by pasting a key; the Bots pick them up through the hq-free / hq-smart / hq-google
 * model groups. Keys go straight to 9Router on the computer and are never shown again.
 */

const GROUPS: { id: RouterProviderDef['group']; label: string }[] = [
  { id: 'google', label: 'Google' },
  { id: 'free', label: 'Free tiers' },
  { id: 'paid', label: 'Cheap, pay as you go' },
];

const MODEL_NOTES: Record<string, string> = {
  'hq-free': 'Free models first: Gemma, Gemini Flash, then open models on NVIDIA, Cerebras, Groq, Cloudflare.',
  'hq-smart': 'The strongest first: Gemini 4 / 3.1 Pro, DeepSeek V4 Pro, Kimi, GLM, MiniMax, Nemotron, then hq-free.',
  'hq-google': 'Google only: Gemini 4, 3.x Pro and Flash, Gemma 4.',
};

export function ModelsSection() {
  const [info, setInfo] = useState<RouterInfo | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const load = useCallback(() => {
    setFailed(null);
    configApi.modelsRouter().then(setInfo).catch((e) => setFailed((e as Error).message || 'the server did not answer'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const s = info?.status;
  return (
    <>
      <div className="app-settings__head">
        <h1>Models</h1>
        <p>Free and cheap open models for your Bots, through 9Router on the Bots’ computer. Paste a provider key and the Bots can use it; keys stay on the computer.</p>
      </div>
      {failed ? (
        <section className="cfg-section"><div className="cfg-card"><div className="cfg-empty cfg-empty--flat">Couldn’t read 9Router: {failed}. <button type="button" className="link-btn link-btn--small" onClick={load}>Try again</button></div></div></section>
      ) : !info || !s ? (
        <section className="cfg-section"><div className="cfg-card"><div className="cfg-empty cfg-empty--flat">Loading…</div></div></section>
      ) : !s.configured ? (
        <section className="cfg-section"><div className="cfg-card"><div className="cfg-empty cfg-empty--flat">9Router isn’t set up for this server. It runs on the Bots’ computer; set NINEROUTER_URL there.</div></div></section>
      ) : (
        <>
          <ModelGroups info={info} />
          <Providers info={info} onChange={load} />
          <Features info={info} onChange={load} />
          <NotOffered info={info} />
        </>
      )}
    </>
  );
}

function ModelGroups({ info }: { info: RouterInfo }) {
  const s = info.status;
  const [tests, setTests] = useState<Record<string, RouterTest | 'running'>>({});
  const run = async (model: string) => {
    setTests((t) => ({ ...t, [model]: 'running' }));
    const r = await configApi.testRouterModel(model).catch((e) => ({ ok: false, detail: (e as Error).message }));
    setTests((t) => ({ ...t, [model]: r }));
  };
  const warn = [s.exposed.cloudSync && 'Cloud sync is on', s.exposed.tunnel && 'the public tunnel is on', !s.exposed.requireApiKey && 'it accepts calls without a key'].filter(Boolean);
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Model groups the Bots use</div>
      <div className="cfg-card">
        <div className="cfg-row">
          <span className={`computer-status-dot is-${s.up ? 'on' : 'off'}`} aria-hidden />
          <div className="cfg-row__text">
            <div className="cfg-row__title">9Router · {s.up ? 'running' : 'not answering'}</div>
            <div className="cfg-row__sub">{s.up ? `${s.connections.length} provider${s.connections.length === 1 ? '' : 's'} connected · pick “9Router” in a Bot’s Engine panel` : s.error ?? 'Not answering on the computer.'}</div>
          </div>
        </div>
        {info.models.map((m) => {
          const t = tests[m];
          return (
            <div key={m} className="cfg-row">
              <div className="cfg-row__text">
                <div className="cfg-row__title"><code className="cfg-code">{m}</code></div>
                <div className="cfg-row__sub">
                  {t === 'running' ? 'Testing…' : t ? `${t.ok ? 'Works' : 'Failed'}: ${t.detail}` : MODEL_NOTES[m] ?? ''}
                </div>
              </div>
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!s.up || t === 'running'} onClick={() => run(m)}>Test</button>
            </div>
          );
        })}
      </div>
      {warn.length > 0 && <div className="cfg-field__hint models__warn">Heads up: in 9Router’s own dashboard {warn.join(', ')}. This app keeps those off.</div>}
    </section>
  );
}

function Providers({ info, onChange }: { info: RouterInfo; onChange: () => void }) {
  const byProvider = new Map<string, RouterConnection[]>();
  for (const c of info.status.connections) byProvider.set(c.provider, [...(byProvider.get(c.provider) ?? []), c]);
  return (
    <>
      {GROUPS.map((g) => {
        const list = info.providers.filter((p) => p.group === g.id);
        if (!list.length) return null;
        return (
          <section key={g.id} className="cfg-section">
            <div className="cfg-section__label">{g.label}</div>
            <div className="cfg-card">
              {list.map((p) => <ProviderRow key={p.id} def={p} connections={byProvider.get(p.id) ?? []} disabled={!info.status.up} onChange={onChange} />)}
            </div>
          </section>
        );
      })}
    </>
  );
}

function ProviderRow({ def, connections, disabled, onChange }: { def: RouterProviderDef; connections: RouterConnection[]; disabled: boolean; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const connected = connections.length > 0;

  const save = async () => {
    if (busy || !key.trim()) return;
    setBusy(true); setNote(null);
    try {
      const r = await configApi.addRouterKey(def.id, key.trim(), def.extra ? extra.trim() : undefined);
      setKey(''); setExtra(''); setOpen(false);
      setNote(r.test.ok ? { ok: true, text: `Saved. Test call: ${r.test.detail}` } : { ok: false, text: `Saved, but the test call failed: ${r.test.detail}` });
      onChange();
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message || 'Couldn’t save the key.' });
    } finally { setBusy(false); }
  };

  const sub = note ? note.text
    : connected ? connections.map((c) => `${c.active ? 'Connected' : 'Paused'}${c.lastError ? ` · last error: ${c.lastError}` : ''}`).join(' · ')
    : def.note;

  return (
    <div className="models__provider">
      <div className="cfg-row">
        <span className={`computer-status-dot is-${connected ? 'on' : 'off'}`} aria-hidden />
        <div className="cfg-row__text">
          <div className="cfg-row__title">{def.name}</div>
          <div className={`cfg-row__sub${note && !note.ok ? ' models__error' : ''}`}>{sub}</div>
        </div>
        {connected ? (
          connections.map((c) => (
            <ConfirmButton key={c.id} className="cfg-btn cfg-btn--secondary" confirmLabel="Remove key" disabled={disabled}
              onConfirm={() => configApi.removeRouterKey(c.id).then(() => { setNote(null); onChange(); })}>Remove</ConfirmButton>
          ))
        ) : (
          <button type="button" className="cfg-btn cfg-btn--secondary" disabled={disabled} onClick={() => { setOpen((v) => !v); setNote(null); }}>{open ? 'Cancel' : 'Add key'}</button>
        )}
      </div>
      {open && !connected && (
        <form className="models__form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <input className="text-input" type="password" autoComplete="off" spellCheck={false} placeholder={`${def.name} API key`} aria-label={`${def.name} API key`} value={key} onChange={(e) => setKey(e.target.value)} />
          {def.extra && <input className="text-input" autoComplete="off" spellCheck={false} placeholder={def.extra.label} aria-label={def.extra.label} value={extra} onChange={(e) => setExtra(e.target.value)} />}
          <div className="models__form-actions">
            <a className="link-btn link-btn--small" href={def.keyUrl} target="_blank" rel="noreferrer noopener">Get a key</a>
            <button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy || !key.trim() || (!!def.extra && !extra.trim())}>{busy ? 'Checking…' : 'Save'}</button>
          </div>
        </form>
      )}
    </div>
  );
}

function Features({ info, onChange }: { info: RouterInfo; onChange: () => void }) {
  const [busy, setBusy] = useState<RouterFeature | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const flip = async (f: RouterFeature, on: boolean) => {
    setBusy(f); setErr(null);
    try { await configApi.setRouterFeature(f, on); onChange(); }
    catch (e) { setErr((e as Error).message || 'Couldn’t change it.'); }
    finally { setBusy(null); }
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Features</div>
      <div className="cfg-card">
        {(Object.keys(info.features) as RouterFeature[]).map((f) => (
          <div key={f} className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{info.features[f].name}</div>
              <div className="cfg-row__sub">{info.features[f].note}</div>
            </div>
            <Switch on={info.status.features[f]} label={info.features[f].name} disabled={!info.status.up || busy === f} onChange={(v) => flip(f, v)} />
          </div>
        ))}
      </div>
      {err && <div className="cfg-field__hint models__error">{err}</div>}
      <div className="cfg-field__hint">Fallback between providers (combos) is always on. Cloud sync, the public tunnel, Headroom and the IDE bridge stay off: they would send keys or traffic off the computer.</div>
    </section>
  );
}

function NotOffered({ info }: { info: RouterInfo }) {
  return (
    <section className="cfg-section">
      <details className="models__excluded">
        <summary className="cfg-section__label">Not offered here</summary>
        <div className="cfg-card">
          {info.excluded.map((x) => (
            <div key={x.name} className="cfg-row">
              <div className="cfg-row__text">
                <div className="cfg-row__title">{x.name}</div>
                <div className="cfg-row__sub">{x.why}</div>
              </div>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
