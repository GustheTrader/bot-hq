import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RevOptKind, RevOptPriority, RevOptStatus, RevOptTask } from '@shared/types';
import { api, type RevOptConfig } from '../lib/api';
import { relativeShort } from '../lib/time';
import { useStore } from '../store';
import { useConfigUI } from '../configStore';
import { Icon } from './Icon';
import { Glyph } from './config/glyphs';
import './config/ui';
import { RevOpsDashboard } from './revopt/Dashboard';
import { MemoryGraphView } from './revopt/MemoryGraph';

/**
 * RevOpt Admin: the revenue-operations console. A team-scoped task catalog over the
 * same teams the rest of Bot HQ uses. Create a task, then Dispatch it — the task is
 * posted into the team channel and the lead picks it up, so the same roster that
 * answers a chat message works the task.
 */
const STATUS_LABEL: Record<RevOptStatus, string> = {
  todo: 'To do', running: 'Running', review: 'In review', done: 'Done', blocked: 'Blocked',
};
const KIND_LABEL: Record<RevOptKind, string> = { email: 'Email', crm: 'CRM', other: 'Other' };
const PRIORITY_LABEL: Record<RevOptPriority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
const OPEN_STATUSES: RevOptStatus[] = ['todo', 'running', 'review', 'blocked'];

function when(t: RevOptTask): string {
  const r = relativeShort(t.updatedAt);
  return r === 'now' ? 'just now' : `${r} ago`;
}

export function RevOptView() {
  const [config, setConfig] = useState<RevOptConfig | null>(null);
  const [tasks, setTasks] = useState<RevOptTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'open' | 'all' | RevOptStatus>('open');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tab, setTab] = useState<'queue' | 'dashboard' | 'graph'>('queue');

  const loadConfig = useCallback(() => {
    api.revoptConfig()
      .then((r) => { setConfig(r); setTeamId((cur) => (cur && r.teams.some((t) => t.id === cur) ? cur : r.teams[0]?.id ?? null)); })
      .catch((e) => setError((e as Error).message));
  }, []);

  const loadTasks = useCallback(() => {
    api.revoptTasks()
      .then((r) => { setTasks(r.tasks); setError(null); })
      .catch((e) => { setTasks([]); setError((e as Error).message); });
  }, []);

  useEffect(() => { loadConfig(); loadTasks(); }, [loadConfig, loadTasks]);

  const team = config?.teams.find((t) => t.id === teamId) ?? null;
  const teamTasks = useMemo(() => (tasks ?? []).filter((t) => t.teamId === teamId), [tasks, teamId]);
  const visible = useMemo(() => {
    if (statusFilter === 'all') return teamTasks;
    if (statusFilter === 'open') return teamTasks.filter((t) => OPEN_STATUSES.includes(t.status));
    return teamTasks.filter((t) => t.status === statusFilter);
  }, [teamTasks, statusFilter]);

  const refresh = () => { loadConfig(); loadTasks(); };

  const dispatch = async (id: string) => {
    setBusyId(id); setError(null);
    try { await api.dispatchRevoptTask(id); refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusyId(null); }
  };
  const setStatus = async (id: string, status: RevOptStatus) => {
    setBusyId(id); setError(null);
    try { await api.updateRevoptTask(id, { status }); refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusyId(null); }
  };
  const remove = async (id: string) => {
    setError(null);
    try { await api.deleteRevoptTask(id); refresh(); }
    catch (e) { setError((e as Error).message); }
  };

  return (
    <main className="chat revopt-view">
      <header className="revopt-view__header">
        <div className="revopt-view__heading">
          <div className="revopt-view__title">RevOpt Admin</div>
          <div className="revopt-view__sub">Revenue-operations queue · email &amp; CRM work routed to a team</div>
        </div>
        <div className="segmented revopt-tabs" role="tablist" aria-label="RevOpt sections">
          {([['queue', 'Queue'], ['dashboard', 'Dashboard'], ['graph', 'Memory graph']] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh" onClick={refresh}>
          <Icon name="refresh" size={16} opacity={0.6} />
        </button>
      </header>

      <div className="revopt-view__scroll">
        <div className={`revopt-view__inner${tab !== 'queue' ? ' revopt-view__inner--wide' : ''}`}>
          {tab === 'dashboard' ? <RevOpsDashboard /> : tab === 'graph' ? <MemoryGraphView /> : config === null ? (
            <div className="cfg-empty">Loading…</div>
          ) : config.teams.length === 0 ? (
            <div className="tasks-empty">
              <Glyph name="tasks" size={28} opacity={0.35} />
              <div className="tasks-empty__title">No teams yet</div>
              <div className="tasks-empty__sub">
                RevOpt routes work to a team. Create one on the Teams island, then come back and queue tasks for it.
              </div>
            </div>
          ) : (
            <>
              <div className="revopt-teams">
                {config.teams.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`revopt-team${t.id === teamId ? ' is-active' : ''}`}
                    onClick={() => setTeamId(t.id)}
                  >
                    <span className="revopt-team__name">{t.name}</span>
                    <span className="revopt-team__counts">
                      <span className="revopt-team__open">{t.counts.todo + t.counts.running + t.counts.review + t.counts.blocked}</span>
                      <span className="revopt-team__sep" aria-hidden>·</span>
                      <span className="revopt-team__members">{t.members} {t.members === 1 ? 'member' : 'members'}</span>
                    </span>
                  </button>
                ))}
              </div>

              {team && (
                <>
                  <NewTask teamId={team.id} onCreated={refresh} />
                  <div className="revopt-filters">
                    {(['open', 'all', 'todo', 'running', 'review', 'done', 'blocked'] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        className={`revopt-filter${f === statusFilter ? ' is-active' : ''}`}
                        onClick={() => setStatusFilter(f)}
                      >
                        {f === 'open' ? 'Open' : f === 'all' ? 'All' : STATUS_LABEL[f]}
                      </button>
                    ))}
                  </div>

                  {tasks === null ? (
                    <div className="cfg-empty">Loading…</div>
                  ) : visible.length === 0 ? (
                    <div className="tasks-empty">
                      <div className="tasks-empty__title">Nothing queued</div>
                      <div className="tasks-empty__sub">
                        {statusFilter === 'open' ? 'No open tasks for this team.' : 'No tasks match this filter.'}
                      </div>
                    </div>
                  ) : (
                    <div className="revopt-list">
                      {visible.map((t) => (
                        <TaskCard
                          key={t.id}
                          task={t}
                          busy={busyId === t.id}
                          onDispatch={() => dispatch(t.id)}
                          onStatus={(s) => setStatus(t.id, s)}
                          onDelete={() => remove(t.id)}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}

              <MacroPanel url={config.macroUrl} teamName={team?.name ?? null} />
            </>
          )}
          {error && <div className="card__error">{error}</div>}
        </div>
      </div>
    </main>
  );
}

function NewTask({ teamId, onCreated }: { teamId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [target, setTarget] = useState('');
  const [kind, setKind] = useState<RevOptKind>('email');
  const [priority, setPriority] = useState<RevOptPriority>('normal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setOpen(false); setTitle(''); setDetail(''); setTarget(''); setKind('email'); setPriority('normal'); setError(null); }, [teamId]);

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true); setError(null);
    try {
      await api.createRevoptTask({ teamId, title: title.trim(), detail: detail.trim(), target: target.trim(), kind, priority });
      setTitle(''); setDetail(''); setTarget('');
      onCreated();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button type="button" className="revopt-new-toggle" onClick={() => setOpen(true)}>
        <Icon name="plus" size={13} opacity={0.7} />
        <span>New task</span>
      </button>
    );
  }

  return (
    <section className="teams-panel teams-panel--new revopt-new">
      <div className="section-label">New task</div>
      <input className="text-input" placeholder="Title — what needs doing?" value={title} autoFocus
        onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }} aria-label="Task title" />
      <input className="text-input" placeholder="Target — email address, domain, or CRM record (optional)" value={target}
        onChange={(e) => setTarget(e.target.value)} aria-label="Task target" />
      <textarea className="text-input revopt-new__detail" placeholder="Details — context the team should have (optional)" value={detail}
        rows={2} onChange={(e) => setDetail(e.target.value)} aria-label="Task detail" />
      <div className="revopt-new__row">
        <label className="revopt-new__field">
          <span>Kind</span>
          <select className="text-input" value={kind} onChange={(e) => setKind(e.target.value as RevOptKind)}>
            <option value="email">Email</option>
            <option value="crm">CRM</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="revopt-new__field">
          <span>Priority</span>
          <select className="text-input" value={priority} onChange={(e) => setPriority(e.target.value as RevOptPriority)}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </label>
      </div>
      <div className="revopt-new__foot">
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className="btn btn--primary btn--sm" disabled={busy || !title.trim()} onClick={submit}>
          {busy ? 'Adding…' : 'Add task'}
        </button>
      </div>
      {error && <div className="card__error">{error}</div>}
    </section>
  );
}

function TaskCard({ task, busy, onDispatch, onStatus, onDelete }: {
  task: RevOptTask;
  busy: boolean;
  onDispatch: () => void;
  onStatus: (s: RevOptStatus) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const done = task.status === 'done';
  return (
    <div className={`revopt-card is-${task.status}`}>
      <div className="revopt-card__main">
        <span className={`revopt-chip revopt-chip--${task.kind}`}>{KIND_LABEL[task.kind]}</span>
        <span className="revopt-card__text">
          <span className={`revopt-card__title${done ? ' is-done' : ''}`}>{task.title}</span>
          <span className="revopt-card__meta">
            <span className={`revopt-pri revopt-pri--${task.priority}`}>{PRIORITY_LABEL[task.priority]}</span>
            {task.target && <><span aria-hidden>·</span><span className="revopt-card__target">{task.target}</span></>}
            <span aria-hidden>·</span>
            <span>{when(task)}</span>
          </span>
        </span>
        <span className={`revopt-status revopt-status--${task.status}`}>{STATUS_LABEL[task.status]}</span>
      </div>
      <div className="revopt-card__actions">
        <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={onDispatch} title="Post this task into the team channel and let the lead start on it">
          {busy ? '…' : 'Dispatch'}
        </button>
        {!done ? (
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => onStatus('done')}>Mark done</button>
        ) : (
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => onStatus('todo')}>Reopen</button>
        )}
        {task.status !== 'blocked' && !done && (
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => onStatus('blocked')}>Block</button>
        )}
        <button type="button" className="icon-btn" title={open ? 'Hide details' : 'Show details'} aria-label="Toggle details" onClick={() => setOpen(!open)}>
          <Icon name={open ? 'arrow_up' : 'arrow_down'} size={12} opacity={0.5} />
        </button>
        <button type="button" className="icon-btn" title="Delete" aria-label="Delete task" onClick={onDelete}>
          <Icon name="close" size={10} opacity={0.5} />
        </button>
      </div>
      {open && (
        <div className="revopt-card__detail">
          {task.detail ? <p>{task.detail}</p> : <p className="revopt-card__muted">No extra detail.</p>}
          <div className="revopt-card__kv">
            <span>Status</span><span>{STATUS_LABEL[task.status]}</span>
            <span>Kind</span><span>{KIND_LABEL[task.kind]}</span>
            <span>Target</span><span>{task.target || '—'}</span>
            <span>Updated</span><span>{new Date(task.updatedAt).toLocaleString()}</span>
          </div>
          {Object.keys(task.payload).length > 0 && (
            <pre className="revopt-card__payload">{JSON.stringify(task.payload, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

/** The Macro desktop console, embedded under Team when a reachable URL is configured. */
function MacroPanel({ url, teamName }: { url: string | null; teamName: string | null }) {
  if (!url) {
    return (
      <section className="revopt-macro">
        <div className="section-label">GTM Tools console</div>
        <div className="revopt-macro__empty">
          GTM Tools is not pointed at a reachable endpoint yet. Set <code>MACRO_TEAM_URL</code> on the server
          (or <code>VITE_MACRO_TEAM_URL</code> for the web build) once the Zen desktop frontend serves,
          and it appears here beside the queue.
        </div>
      </section>
    );
  }
  return (
    <section className="revopt-macro">
      <div className="revopt-macro__head">
        <div className="section-label" style={{ margin: 0 }}>GTM Tools console{teamName ? ` · ${teamName}` : ''}</div>
        <a href={url} target="_blank" rel="noopener noreferrer" className="revopt-macro__open">Open in new tab</a>
      </div>
      <iframe className="revopt-macro__frame" src={url} title="GTM Tools console" />
    </section>
  );
}

/** Sidebar entry for the RevOpt Admin console. */
export function RevOptIsland() {
  const view = useConfigUI((s) => s.view);
  void useStore;
  return (
    <button type="button" className={`sidebar-island${view === 'revopt' ? ' is-active' : ''}`} onClick={() => useConfigUI.getState().setView('revopt')} title="RevOpt Admin" aria-pressed={view === 'revopt'}>
      <span className="sidebar-island__icon"><Icon name="file" size={18} /></span>
      <span className="sidebar-island__label">RevOpt Admin</span>
    </button>
  );
}
