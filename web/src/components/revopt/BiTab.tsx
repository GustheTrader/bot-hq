import { useEffect, useRef, useState } from 'react';
import { embedDashboard } from '@superset-ui/embedded-sdk';
import { api, type BiDashboard } from '../../lib/api';

/**
 * RevOpt → BI: Apache Superset (self-hosted on the computer) embedded here. Pick a dashboard; Bot HQ's server hands
 * the page a short-lived view-only guest token for it. Building charts, dashboards and SQL happens in Superset
 * itself ("Open Superset"): SQL Lab there reads quant-lake (DuckDB) and Supabase read-only.
 */
export function BiTab() {
  const [state, setState] = useState<{ configured: boolean; publicUrl: string | null; dashboards: BiDashboard[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<BiDashboard | null>(null);
  const [busy, setBusy] = useState(false);
  const [embedError, setEmbedError] = useState<string | null>(null);
  const mount = useRef<HTMLDivElement>(null);

  const load = () => {
    setError(null);
    api.biStatus().then((r) => { setState(r); setCurrent((c) => r.dashboards.find((d) => d.id === c?.id) ?? r.dashboards.find((d) => d.embedId) ?? r.dashboards[0] ?? null); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not reach Superset'));
  };
  useEffect(load, []);

  // Mount the embedded dashboard whenever the chosen one (with an embed id) changes.
  useEffect(() => {
    const el = mount.current;
    if (!el || !current?.embedId || !state?.publicUrl) return;
    let cancelled = false;
    setEmbedError(null);
    el.innerHTML = '';
    embedDashboard({
      id: current.embedId,
      supersetDomain: state.publicUrl,
      mountPoint: el,
      fetchGuestToken: async () => (await api.biGuestToken(current.embedId!)).token,
      dashboardUiConfig: { hideTitle: false, filters: { expanded: false } },
    }).catch((e: unknown) => { if (!cancelled) setEmbedError(e instanceof Error ? e.message : 'Could not show the dashboard'); });
    return () => { cancelled = true; el.innerHTML = ''; };
  }, [current?.embedId, state?.publicUrl]);

  const enable = async (d: BiDashboard) => {
    setBusy(true); setEmbedError(null);
    try {
      const { embedId } = await api.biEnableEmbed(d.id);
      setState((s) => (s ? { ...s, dashboards: s.dashboards.map((x) => (x.id === d.id ? { ...x, embedId } : x)) } : s));
      setCurrent({ ...d, embedId });
    } catch (e) { setEmbedError(e instanceof Error ? e.message : 'Could not turn on embedding'); }
    finally { setBusy(false); }
  };

  if (error) return <div className="card__error" role="alert">{error}</div>;
  if (!state) return <div className="cfg-empty">Connecting to Superset…</div>;
  if (!state.configured) {
    return (
      <div className="bi-empty panel-card">
        <div className="bi-empty__title">Superset isn’t connected yet</div>
        <div className="bi-empty__sub">Bot HQ needs <code>SUPERSET_PUBLIC_URL</code>, <code>SUPERSET_USER</code> and <code>SUPERSET_PASSWORD_FILE</code> on the server.</div>
      </div>
    );
  }

  return (
    <div className="bi">
      <div className="viz-filters">
        <label className="mg-field">Dashboard
          <select className="text-input" value={current?.id ?? ''} onChange={(e) => setCurrent(state.dashboards.find((d) => d.id === Number(e.target.value)) ?? null)} disabled={state.dashboards.length === 0}>
            {state.dashboards.length === 0 && <option value="">No dashboards yet</option>}
            {state.dashboards.map((d) => <option key={d.id} value={d.id}>{d.title}{d.embedId ? '' : ' (not embedded)'}</option>)}
          </select>
        </label>
        <button type="button" className="link-btn link-btn--small" onClick={load}>Refresh list</button>
        <span className="bi-links">
          <a className="btn btn--secondary btn--sm" href={`${state.publicUrl}/sqllab/`} target="_blank" rel="noreferrer noopener">SQL Lab</a>
          <a className="btn btn--secondary btn--sm" href={`${state.publicUrl}/dashboard/list/`} target="_blank" rel="noreferrer noopener">Open Superset</a>
        </span>
      </div>

      {state.dashboards.length === 0 ? (
        <div className="bi-empty panel-card">
          <div className="bi-empty__title">No dashboards yet</div>
          <div className="bi-empty__sub">Build one in Superset (charts from quant-lake or Supabase, or a SQL Lab query), then press Refresh list.</div>
        </div>
      ) : current && !current.embedId ? (
        <div className="bi-empty panel-card">
          <div className="bi-empty__title">{current.title} isn’t embedded yet</div>
          <div className="bi-empty__sub">Turning on embedding lets Bot HQ show it here, view-only, and only from Bot HQ’s own address.</div>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => current && enable(current)} disabled={busy}>{busy ? 'Turning on…' : 'Show it here'}</button>
        </div>
      ) : null}
      {embedError && <div className="card__error" role="alert">{embedError}</div>}
      <div className={`bi-frame${current?.embedId ? '' : ' is-hidden'}`} ref={mount} />
    </div>
  );
}
