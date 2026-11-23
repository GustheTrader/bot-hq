import { useEffect, useState } from 'react';
import { api, type BuildflowJobSummary } from '../../lib/api';
import { useConfigUI } from '../../configStore';

/**
 * RevOpt ↔ Build-flow: a task can name a Build-flow job by number (JOB-1001, 1001). These show the job as you
 * type it, as a chip on the task card, and as a live summary in the task's details.
 */

export type JobRef = { number: string; id: string; name: string; client?: string };
export const jobOf = (payload: Record<string, unknown>) => (payload?.buildflowJob as JobRef | undefined) ?? null;
const money = (n: number) => `$${Math.round(Number(n) || 0).toLocaleString()}`;

/** Looks a job number up while it is typed (debounced). null = nothing typed. */
export function useJobLookup(number: string) {
  const [state, setState] = useState<{ loading: boolean; job: BuildflowJobSummary | null; error: string | null }>({ loading: false, job: null, error: null });
  useEffect(() => {
    const n = number.trim();
    if (!n) { setState({ loading: false, job: null, error: null }); return; }
    setState((s) => ({ ...s, loading: true }));
    let alive = true;
    const t = setTimeout(() => {
      api.revoptBuildflowJob(n)
        .then((job) => { if (alive) setState({ loading: false, job, error: null }); })
        .catch((e) => { if (alive) setState({ loading: false, job: null, error: e instanceof Error ? e.message : 'Not found' }); });
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [number]);
  return state;
}

/** One line under the job-number field: the job it found, or why not. */
export function JobPreview({ number }: { number: string }) {
  const { loading, job, error } = useJobLookup(number);
  if (!number.trim()) return null;
  if (loading) return <div className="bf-job-preview">Looking up {number.trim()}…</div>;
  if (error || !job) return <div className="bf-job-preview is-error" role="alert">{error ?? 'Not found'}</div>;
  return (
    <div className="bf-job-preview is-found">
      <span className="bf-job-chip">{job.job.number}</span> {job.job.name}{job.job.client ? ` · ${job.job.client}` : ''} · {money(job.contract.revised)} · {job.schedule.progress}% done
    </div>
  );
}

/** The job number on a task card; opens the job in Build-flow. */
export function JobChip({ job }: { job: JobRef }) {
  return (
    <button type="button" className="bf-job-chip is-link" title={`Open ${job.number} · ${job.name} in Build-flow`}
      onClick={(e) => { e.stopPropagation(); useConfigUI.getState().openBuildflow(`/projects/${job.id}`); }}>
      {job.number}
    </button>
  );
}

/** In a task's details: the linked job right now, and a way to change or clear the number. */
export function JobPanel({ job, onSet }: { job: JobRef | null; onSet: (number: string) => Promise<void> }) {
  const [summary, setSummary] = useState<BuildflowJobSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(job?.number ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSummary(null); setError(null);
    if (job) api.revoptBuildflowJob(job.number).then(setSummary).catch((e) => setError(e instanceof Error ? e.message : 'Could not load the job'));
  }, [job?.number]);

  const save = async (n: string) => {
    setBusy(true); setError(null);
    try { await onSet(n); setEditing(false); } catch (e) { setError(e instanceof Error ? e.message : 'Could not link the job'); } finally { setBusy(false); }
  };

  if (editing || !job) {
    return (
      <div className="bf-job-panel">
        <div className="bf-job-panel__label">Build-flow job</div>
        <div className="bf-job-panel__edit">
          <input className="text-input" placeholder="Job number, e.g. JOB-1001" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Build-flow job number" />
          <button type="button" className="btn btn--primary btn--sm" disabled={busy || !value.trim()} onClick={() => save(value)}>{busy ? '…' : 'Link'}</button>
          {job && <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>}
        </div>
        <JobPreview number={value} />
        {error && <div className="bf-job-preview is-error" role="alert">{error}</div>}
      </div>
    );
  }
  return (
    <div className="bf-job-panel">
      <div className="bf-job-panel__head">
        <span className="bf-job-panel__label">Build-flow job</span>
        <span className="bf-job-panel__actions">
          <button type="button" className="link-btn link-btn--small" onClick={() => useConfigUI.getState().openBuildflow(`/projects/${job.id}`)}>Open</button>
          <button type="button" className="link-btn link-btn--small" onClick={() => { setValue(job.number); setEditing(true); }}>Change</button>
          <button type="button" className="link-btn link-btn--small" disabled={busy} onClick={() => save('')}>Unlink</button>
        </span>
      </div>
      <div className="bf-job-panel__title"><span className="bf-job-chip">{job.number}</span> {job.name}{job.client ? <span className="bf-job-panel__muted"> · {job.client}</span> : null}</div>
      {error && <div className="bf-job-preview is-error" role="alert">{error}</div>}
      {!summary && !error && <div className="bf-job-panel__muted">Loading from Build-flow…</div>}
      {summary && (
        <>
          <div className="bf-job-panel__stats">
            <span><b>{money(summary.contract.revised)}</b> contract</span>
            <span><b>{summary.schedule.progress}%</b> scheduled work done</span>
            <span className={summary.schedule.late.length ? 'is-alert' : ''}><b>{summary.schedule.late.length}</b> late</span>
            <span><b>{summary.waitingOnClient.changeOrders.length + summary.waitingOnClient.selections.length}</b> waiting on client</span>
          </div>
          {summary.schedule.next.length > 0 && <div className="bf-job-panel__muted">Next: {summary.schedule.next.map((n) => `${n.title} (${n.startDate})`).join(', ')}</div>}
          {summary.lastDailyLog && <div className="bf-job-panel__muted">Last log {summary.lastDailyLog.date}: {summary.lastDailyLog.workPerformed.slice(0, 160)}</div>}
        </>
      )}
    </div>
  );
}
