import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type MemoryBank, type MemoryEntity, type MemoryGraph as Graph, type MemoryOntology, type ObsidianStatus } from '../../lib/api';

/**
 * RevOpt → Memory graph: what the bots remember (Hindsight, the shared memory store), drawn like Obsidian's graph.
 * Each entity is a node sized by how often it is mentioned; entities mentioned together are linked. Hover shows a
 * node's neighbours, click lists the facts behind it. Wheel zooms, drag pans. Read-only.
 *
 * Nodes are coloured by their ontology type (person, company, deal, …); the legend hides a type. The bank picker
 * covers the three memory layers (global, each team, each bot). When the server has an Obsidian vault set up, the
 * bar under the graph shows the last two-way sync and can start one.
 */

type P = { id: string; label: string; mentions: number; type?: string; x: number; y: number; vx: number; vy: number; r: number };
const W = 900, H = 620;

/** A plain force layout: springs on links, repulsion between nodes, a pull to the centre. Runs once per graph. */
function layout(g: Graph): P[] {
  const maxM = Math.max(1, ...g.nodes.map((n) => n.mentions));
  const pts: P[] = g.nodes.map((n, i) => {
    const a = (i / Math.max(1, g.nodes.length)) * Math.PI * 2 * 7.3;
    const rad = 60 + (i % 23) * 9;
    return { ...n, x: W / 2 + Math.cos(a) * rad, y: H / 2 + Math.sin(a) * rad, vx: 0, vy: 0, r: 3 + 13 * Math.sqrt(n.mentions / maxM) };
  });
  const idx = new Map(pts.map((p, i) => [p.id, i]));
  const links = g.edges.map((e) => ({ a: idx.get(e.source)!, b: idx.get(e.target)!, w: e.weight })).filter((l) => l.a !== undefined && l.b !== undefined);
  const maxW = Math.max(1, ...links.map((l) => l.w));
  for (let it = 0; it < 320; it++) {
    const cool = 1 - it / 320;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      for (let j = i + 1; j < pts.length; j++) {
        const q = pts[j];
        let dx = p.x - q.x, dy = p.y - q.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
        const f = 2600 / d2;
        const d = Math.sqrt(d2);
        p.vx += (dx / d) * f; p.vy += (dy / d) * f; q.vx -= (dx / d) * f; q.vy -= (dy / d) * f;
      }
    }
    for (const l of links) {
      const p = pts[l.a], q = pts[l.b];
      const dx = q.x - p.x, dy = q.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const k = 0.015 * (0.4 + l.w / maxW) * (d - 110);
      p.vx += (dx / d) * k; p.vy += (dy / d) * k; q.vx -= (dx / d) * k; q.vy -= (dy / d) * k;
    }
    for (const p of pts) {
      p.vx += (W / 2 - p.x) * 0.004; p.vy += (H / 2 - p.y) * 0.004;
      const sp = Math.min(12 * cool + 0.5, Math.sqrt(p.vx * p.vx + p.vy * p.vy));
      const n = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1;
      p.x += (p.vx / n) * sp; p.y += (p.vy / n) * sp;
      p.vx *= 0.5; p.vy *= 0.5;
    }
  }
  // Fit the result to the frame (keeping its shape) so it fills the space whatever the graph's size.
  if (pts.length > 1) {
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = 46;
    const s = Math.min((W - 2 * pad) / Math.max(1, maxX - minX), (H - 2 * pad) / Math.max(1, maxY - minY));
    const ox = (W - (maxX - minX) * s) / 2, oy = (H - (maxY - minY) * s) / 2;
    for (const p of pts) { p.x = ox + (p.x - minX) * s; p.y = oy + (p.y - minY) * s; }
  }
  return pts;
}

export function MemoryGraphView() {
  const [banks, setBanks] = useState<MemoryBank[]>([]);
  const [bank, setBank] = useState('shared');
  const [limit, setLimit] = useState(150);
  const [reload, setReload] = useState(0);
  const [g, setG] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [entity, setEntity] = useState<MemoryEntity | null>(null);
  const [entityError, setEntityError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [ontology, setOntology] = useState<MemoryOntology | null>(null);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [obsidian, setObsidian] = useState<ObsidianStatus | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    api.memoryOntology().then(setOntology).catch(() => {});
    api.obsidianStatus().then(setObsidian).catch(() => {});
  }, []);
  // While a sync runs, check on it every two seconds; reload the banks and graph once it ends.
  useEffect(() => {
    if (!obsidian?.running) return;
    const t = setInterval(() => api.obsidianStatus().then((s) => {
      setObsidian(s);
      if (!s.running) { api.memoryBanks().then((r) => setBanks(r.banks)).catch(() => {}); setReload((n) => n + 1); }
    }).catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [obsidian?.running]);
  const syncNow = () => { setSyncError(null); api.obsidianSync().then(setObsidian).catch((e) => setSyncError(e instanceof Error ? e.message : 'Could not start the sync')); };
  const colorOf = useMemo(() => new Map((ontology?.types ?? []).map((t) => [t.id, t.color])), [ontology]);

  useEffect(() => { api.memoryBanks().then((r) => setBanks(r.banks)).catch(() => {}); }, []);
  useEffect(() => {
    let alive = true;
    setG(null); setError(null); setPicked(null); setEntity(null);
    api.memoryGraph(bank, limit).then((r) => { if (alive) setG(r); }).catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Could not load the memory graph'); });
    return () => { alive = false; };
  }, [bank, limit, reload]);
  useEffect(() => {
    if (!picked) return;
    let alive = true;
    setEntity(null); setEntityError(null);
    api.memoryEntity(bank, picked).then((r) => { if (alive) setEntity(r); }).catch((e) => { if (alive) setEntityError(e instanceof Error ? e.message : 'Could not load the facts'); });
    return () => { alive = false; };
  }, [bank, picked]);

  const all = useMemo(() => (g ? layout(g) : []), [g]);
  const pts = useMemo(() => all.filter((p) => !hiddenTypes.has(p.type ?? 'entity')), [all, hiddenTypes]);
  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of all) m.set(p.type ?? 'entity', (m.get(p.type ?? 'entity') ?? 0) + 1);
    return m;
  }, [all]);
  const byId = useMemo(() => new Map(pts.map((p) => [p.id, p])), [pts]);
  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of g?.edges ?? []) {
      (m.get(e.source) ?? m.set(e.source, new Set()).get(e.source)!).add(e.target);
      (m.get(e.target) ?? m.set(e.target, new Set()).get(e.target)!).add(e.source);
    }
    return m;
  }, [g]);
  const focus = hover ?? picked;
  const near = focus ? neighbours.get(focus) ?? new Set<string>() : null;
  const match = query.trim().toLowerCase();
  const labelled = useMemo(() => new Set([...pts].sort((a, b) => b.mentions - a.mentions).slice(0, 18).map((p) => p.id)), [pts]);
  const maxW = Math.max(1, ...(g?.edges ?? []).map((e) => e.weight));

  const onWheel = (e: React.WheelEvent) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const k = Math.min(4, Math.max(0.4, view.k * (e.deltaY < 0 ? 1.12 : 0.89)));
    const mx = ((e.clientX - box.left) / box.width) * W, my = ((e.clientY - box.top) / box.height) * H;
    setView({ k, x: mx - ((mx - view.x) * k) / view.k, y: my - ((my - view.y) * k) / view.k });
  };
  const onDown = (e: React.PointerEvent) => { if ((e.target as Element).tagName !== 'circle') drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current, box = svgRef.current?.getBoundingClientRect();
    if (!d || !box) return;
    setView((v) => ({ ...v, x: d.vx + ((e.clientX - d.x) / box.width) * W, y: d.vy + ((e.clientY - d.y) / box.height) * H }));
  };

  if (error) return <div className="card__error" role="alert">{error}</div>;

  return (
    <div className="mg">
      <div className="viz-filters">
        <label className="mg-field">Bank
          <select className="text-input" value={bank} onChange={(e) => setBank(e.target.value)}>
            {banks.length ? (
              (['everyone', 'team', 'me'] as const).map((layer) => {
                const list = banks.filter((b) => b.layer === layer);
                return list.length ? (
                  <optgroup key={layer} label={layer === 'everyone' ? 'Global' : layer === 'team' ? 'Teams' : 'Bots'}>
                    {list.map((b) => <option key={b.id} value={b.id}>{b.label}{b.facts ? ` · ${b.facts} facts` : ' · empty'}</option>)}
                  </optgroup>
                ) : null;
              })
            ) : <option value="shared">Everyone (shared)</option>}
          </select>
        </label>
        <div className="segmented" role="tablist" aria-label="How many entities">
          {[80, 150, 250].map((n) => <button key={n} type="button" role="tab" aria-selected={limit === n} className={limit === n ? 'is-active' : ''} onClick={() => setLimit(n)}>{n}</button>)}
        </div>
        <input className="text-input mg-search" value={query} placeholder="Find an entity" onChange={(e) => setQuery(e.target.value)} aria-label="Find an entity" />
        <button type="button" className="link-btn link-btn--small" onClick={() => setView({ x: 0, y: 0, k: 1 })}>Reset view</button>
      </div>
      {g?.stats && <div className="mg-stats">{g.stats.facts} facts · {g.stats.links} links · {g.stats.documents} documents · showing {g.nodes.length} of {g.totalEntities} entities</div>}
      {ontology && typeCounts.size > 0 && (
        <div className="mg-legend" aria-label="Entity types">
          {ontology.types.filter((t) => typeCounts.has(t.id)).map((t) => {
            const off = hiddenTypes.has(t.id);
            return (
              <button key={t.id} type="button" className={`mg-legend__item${off ? ' is-off' : ''}`} aria-pressed={!off} title={t.about}
                onClick={() => setHiddenTypes((h) => { const n = new Set(h); if (off) n.delete(t.id); else n.add(t.id); return n; })}>
                <span className="mg-legend__dot" style={{ background: t.color }} />{t.plural} {typeCounts.get(t.id)}
              </button>
            );
          })}
        </div>
      )}

      <div className="mg-body">
        <div className="mg-canvas">
          {!g ? <div className="cfg-empty">Laying out the graph…</div> : g.nodes.length === 0 ? <div className="viz-empty">No entities in this bank yet.</div> : (
            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onPointerLeave={() => { drag.current = null; }} role="img" aria-label={`Memory graph of ${g.nodes.length} entities`}>
              <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                {g.edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e, i) => {
                  const a = byId.get(e.source), b = byId.get(e.target);
                  if (!a || !b) return null;
                  const on = focus && (e.source === focus || e.target === focus);
                  return <line key={i} className={`mg-edge${on ? ' is-on' : focus ? ' is-dim' : ''}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={(0.4 + 1.6 * (e.weight / maxW)) / view.k} />;
                })}
                {pts.map((p) => {
                  const dim = focus && p.id !== focus && !near?.has(p.id);
                  const hit = match && p.label.toLowerCase().includes(match);
                  const showLabel = p.id === focus || near?.has(p.id) || labelled.has(p.id) || hit;
                  return (
                    <g key={p.id} className={`mg-node${dim ? ' is-dim' : ''}${p.id === focus ? ' is-focus' : ''}${hit ? ' is-hit' : ''}`}>
                      <circle cx={p.x} cy={p.y} r={p.r} style={colorOf.get(p.type ?? 'entity') ? { fill: colorOf.get(p.type ?? 'entity') } : undefined} onPointerEnter={() => setHover(p.id)} onPointerLeave={() => setHover(null)} onClick={() => setPicked(p.id === picked ? null : p.id)}>
                        <title>{`${p.label} · ${ontology?.types.find((t) => t.id === (p.type ?? 'entity'))?.label ?? 'Entity'} · ${p.mentions} mentions`}</title>
                      </circle>
                      {showLabel && <text x={p.x} y={p.y - p.r - 4 / view.k} textAnchor="middle" style={{ fontSize: 11 / view.k }}>{p.label}</text>}
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
        </div>
        <aside className="mg-side">
          {!picked ? (
            <div className="mg-side__empty">Click an entity to see what the bots remember about it. Bigger means mentioned more; lines join things mentioned together.</div>
          ) : entityError ? <div className="card__error" role="alert">{entityError}</div> : !entity ? <div className="cfg-empty">Loading…</div> : (
            <>
              <div className="mg-side__name">{entity.entity.name}</div>
              <div className="mg-side__meta">{ontology?.types.find((t) => t.id === (all.find((p) => p.id === picked)?.type ?? 'entity'))?.label ?? 'Entity'} · {entity.entity.mentions} mentions · {neighbours.get(picked)?.size ?? 0} linked</div>
              <div className="mg-facts">
                {entity.facts.length === 0 ? <div className="mg-side__empty">No facts listed for it.</div> : entity.facts.map((f) => (
                  <div key={f.id} className="mg-fact">
                    <div className="mg-fact__text">{f.text}</div>
                    <div className="mg-fact__meta">{f.type}{f.date ? ` · ${new Date(f.date).toLocaleDateString()}` : ''}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </aside>
      </div>
      <div className="mg-obsidian" aria-live="polite">
        {!obsidian ? null : !obsidian.enabled ? (
          <span>Obsidian sync is off. Set OBSIDIAN_VAULT on the server to a vault folder to have bots learn from its notes and see their memory there.</span>
        ) : (
          <>
            <span>
              Obsidian · {obsidian.vault}
              {obsidian.running ? ' · syncing…' : obsidian.last ? (obsidian.last.error ? ` · last sync failed: ${obsidian.last.error}` : ` · synced ${new Date(obsidian.last.at).toLocaleString()}: ${obsidian.last.ingest?.saved.length ?? 0} notes learned, ${obsidian.last.ingest?.forgotten.length ?? 0} forgotten, ${obsidian.last.export?.banks.reduce((s, b) => s + b.entities, 0) ?? 0} entities written`) : ' · not synced yet'}
              {obsidian.everyMinutes ? ` · every ${obsidian.everyMinutes} min` : ''}
            </span>
            <button type="button" className="link-btn link-btn--small" disabled={obsidian.running} onClick={syncNow}>Sync now</button>
            {syncError && <span className="card__error" role="alert">{syncError}</span>}
          </>
        )}
      </div>
    </div>
  );
}
