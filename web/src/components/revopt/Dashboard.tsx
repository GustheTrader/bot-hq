import { useEffect, useMemo, useRef, useState } from 'react';
import type { RevOpsMetrics } from '@shared/revops-metrics';
import { api } from '../../lib/api';

/**
 * RevOpt → Dashboard: the queue as numbers. Stat tiles for the headline figures, daily throughput as a two-line
 * chart (created vs done, crosshair tooltip), and single-hue bar charts for status, priority, team load and bot
 * work. Colours come from the validated chart palette (styles/revopt.css `.viz` tokens), never from status.
 */

const RANGES = [7, 30, 90] as const;
const STATUS_LABEL: Record<string, string> = { todo: 'To do', running: 'Running', review: 'Review', blocked: 'Blocked', done: 'Done' };
const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

function Tile({ label, value, sub, alert }: { label: string; value: string; sub?: string; alert?: boolean }) {
  return (
    <div className={`viz-tile${alert ? ' is-alert' : ''}`}>
      <span className="viz-tile__label">{label}</span>
      <span className="viz-tile__value">{alert && <span className="viz-tile__icon" aria-hidden>!</span>}{value}</span>
      {sub && <span className="viz-tile__sub">{sub}</span>}
    </div>
  );
}

/** Created vs done per day. Two series (legend + direct end labels), one axis, crosshair tooltip. */
function Throughput({ data }: { data: RevOpsMetrics['throughput'] }) {
  const W = 640, H = 220, L = 34, R = 56, T = 14, B = 26;
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const max = Math.max(1, ...data.map((d) => Math.max(d.created, d.done)));
  const step = Math.max(1, Math.ceil(max / 4));
  const top = step * 4;
  const x = (i: number) => L + (data.length <= 1 ? 0 : (i / (data.length - 1)) * (W - L - R));
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const path = (k: 'created' | 'done') => data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join(' ');
  const last = data[data.length - 1];
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);
  const labelEvery = Math.ceil(data.length / 6);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || data.length === 0) return;
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round(((px - L) / (W - L - R)) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  };
  const h = hover !== null ? data[hover] : null;

  return (
    <figure className="viz-card">
      <figcaption className="viz-card__head">
        <span className="viz-card__title">Throughput per day</span>
        <span className="viz-legend">
          <span className="viz-legend__item"><span className="viz-swatch is-s1" />Created</span>
          <span className="viz-legend__item"><span className="viz-swatch is-s2" />Done</span>
        </span>
      </figcaption>
      <div className="viz-plot">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Tasks created and done per day; last day ${last?.created ?? 0} created, ${last?.done ?? 0} done`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="viz-grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
              <text className="viz-axis" x={L - 6} y={y(t) + 3} textAnchor="end">{t}</text>
            </g>
          ))}
          {data.map((d, i) => (i % labelEvery === 0 || i === data.length - 1) && (
            <text key={d.day} className="viz-axis" x={x(i)} y={H - 6} textAnchor="middle">{fmtDay(d.day)}</text>
          ))}
          <path className="viz-line is-s1" d={path('created')} />
          <path className="viz-line is-s2" d={path('done')} />
          {last && (
            <>
              <text className="viz-label" x={x(data.length - 1) + 8} y={y(last.created) + 4}>Created</text>
              <text className="viz-label" x={x(data.length - 1) + 8} y={y(last.done) + (Math.abs(y(last.done) - y(last.created)) < 12 ? 16 : 4)}>Done</text>
            </>
          )}
          {h && hover !== null && (
            <g>
              <line className="viz-crosshair" x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} />
              <circle className="viz-dot is-s1" cx={x(hover)} cy={y(h.created)} r={4.5} />
              <circle className="viz-dot is-s2" cx={x(hover)} cy={y(h.done)} r={4.5} />
            </g>
          )}
          <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
        {h && hover !== null && (
          <div className="viz-tooltip" style={{ left: `${(x(hover) / W) * 100}%` }} role="status">
            <b>{fmtDay(h.day)}</b>
            <span><span className="viz-swatch is-s1" />Created {h.created}</span>
            <span><span className="viz-swatch is-s2" />Done {h.done}</span>
          </div>
        )}
      </div>
    </figure>
  );
}

/** One series of horizontal bars (magnitude): rounded data-end, value label, hover title. */
function Bars({ title, rows, empty }: { title: string; rows: { key: string; label: string; value: number; note?: string }[]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <figure className="viz-card">
      <figcaption className="viz-card__head"><span className="viz-card__title">{title}</span></figcaption>
      {rows.length === 0 || rows.every((r) => r.value === 0) ? <div className="viz-empty">{empty}</div> : (
        <div className="viz-bars" role="list">
          {rows.map((r) => (
            <div key={r.key} className="viz-bar" role="listitem" title={`${r.label}: ${r.value}${r.note ? ` · ${r.note}` : ''}`}>
              <span className="viz-bar__label">{r.label}</span>
              <span className="viz-bar__track"><span className="viz-bar__fill" style={{ width: `${(r.value / max) * 100}%` }} /></span>
              <span className="viz-bar__value">{r.value}{r.note && <span className="viz-bar__note"> {r.note}</span>}</span>
            </div>
          ))}
        </div>
      )}
    </figure>
  );
}

export function RevOpsDashboard() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [m, setM] = useState<RevOpsMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState(false);

  useEffect(() => {
    let alive = true;
    setError(null);
    api.revoptMetrics(days).then((r) => { if (alive) setM(r); }).catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Could not load the dashboard'); });
    return () => { alive = false; };
  }, [days]);

  const status = useMemo(() => (m ? (['todo', 'running', 'review', 'blocked', 'done'] as const).map((k) => ({ key: k, label: STATUS_LABEL[k], value: m.byStatus[k] })) : []), [m]);

  if (error) return <div className="card__error" role="alert">{error}</div>;
  if (!m) return <div className="cfg-empty">Loading…</div>;
  const k = m.kpis;

  return (
    <div className="viz">
      <div className="viz-filters">
        <div className="segmented" role="tablist" aria-label="Time range">
          {RANGES.map((r) => <button key={r} type="button" role="tab" aria-selected={days === r} className={days === r ? 'is-active' : ''} onClick={() => setDays(r)}>{r} days</button>)}
        </div>
        <button type="button" className="link-btn link-btn--small" onClick={() => setTable(!table)}>{table ? 'Show charts' : 'Show as table'}</button>
      </div>

      <div className="viz-tiles">
        <Tile label="Open tasks" value={String(k.open)} sub={`${k.blocked} blocked`} />
        <Tile label={`Done in ${days} days`} value={String(k.doneInPeriod)} sub={`${k.createdInPeriod} created`} />
        <Tile label="Completion rate" value={k.completionRate === null ? '—' : `${k.completionRate}%`} sub="done ÷ created" />
        <Tile label="Avg time to done" value={k.avgCycleHours === null ? '—' : k.avgCycleHours < 48 ? `${k.avgCycleHours} h` : `${Math.round(k.avgCycleHours / 24)} d`} />
        <Tile label="Overdue" value={String(k.overdue)} sub={k.overdue ? 'past their due date' : 'none late'} alert={k.overdue > 0} />
        <Tile label="Bot tasks open" value={String(k.botTasksOpen)} sub={`${k.botTasksDone} done in ${days} days`} />
      </div>

      {table ? (
        <table className="viz-table">
          <thead><tr><th>Day</th><th>Created</th><th>Done</th></tr></thead>
          <tbody>{m.throughput.map((d) => <tr key={d.day}><td>{fmtDay(d.day)}</td><td>{d.created}</td><td>{d.done}</td></tr>)}</tbody>
        </table>
      ) : (
        <>
          <Throughput data={m.throughput} />
          <div className="viz-grid2">
            <Bars title="Queue by status" rows={status} empty="No tasks yet." />
            <Bars title="Open by priority" rows={(['urgent', 'high', 'normal', 'low'] as const).map((p) => ({ key: p, label: p[0].toUpperCase() + p.slice(1), value: m.byPriority[p] ?? 0 }))} empty="Nothing open." />
            <Bars title="Team load (open)" rows={m.byTeam.map((t) => ({ key: t.id, label: t.name, value: t.open, note: `${t.done} done${t.overdue ? ` · ${t.overdue} late` : ''}` }))} empty="No team has tasks yet." />
            <Bars title="Bot work in progress" rows={m.byBot.map((b) => ({ key: b.id, label: b.name, value: b.working + b.waiting, note: `${b.waiting ? `${b.waiting} waiting · ` : ''}${b.done} done` }))} empty="No bot is working on tracked tasks." />
          </div>
        </>
      )}
    </div>
  );
}
