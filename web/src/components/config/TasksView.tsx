import { useMemo, useState } from 'react';
import type { Bot, Task } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { relativeShort } from '../../lib/time';
import { useConfigUI, type WorkTab } from '../../configStore';
import { useStore } from '../../store';
import { useAttention, useTasks } from '../work/attention';
import { NeedsAttention } from '../work/NeedsAttention';
import { ProjectsPanel } from '../work/ProjectsPanel';
import { Glyph } from './glyphs';
import './ui';

type Filter = 'all' | 'open' | 'done';

const STATE_LABEL: Record<Task['state'], string> = { working: 'Working on it', needs_input: 'Waiting on you', done: 'Done' };

function when(t: Task): string {
  const r = relativeShort(t.updatedAt);
  const ago = r === 'now' ? 'just now' : r === 'Yesterday' ? 'yesterday' : `${r} ago`;
  return t.state === 'done' ? `Completed ${ago}` : t.state === 'needs_input' ? `Asked ${ago}` : `Updated ${ago}`;
}

function TaskRow({ t, bot, showBot }: { t: Task; bot?: Bot; showBot: boolean }) {
  const open = () => { if (bot) { useStore.getState().selectBot(bot.id); useConfigUI.getState().setView('chat'); } };
  return (
    <button type="button" className={`task-row is-${t.state}`} onClick={open} disabled={!bot} title={bot ? `Open ${bot.name}` : undefined}>
      <span className={`task-row__check is-${t.state}`} aria-hidden>{t.state === 'done' ? <Glyph name="check_circle" size={18} /> : <span className="task-row__ring" />}</span>
      <span className="task-row__text">
        <span className="task-row__title">{t.title}</span>
        {t.note && <span className="task-row__note">{t.note}</span>}
        <span className="task-row__meta">
          {showBot && bot && <><BotAvatarFor bot={bot} size={14} /><span>{bot.name}</span><span aria-hidden>·</span></>}
          <span>{when(t)}</span>
        </span>
      </span>
      <span className={`task-chip is-${t.state}`}>{STATE_LABEL[t.state]}</span>
    </button>
  );
}

function sortTasks(list: Task[]) {
  const rank = { needs_input: 0, working: 1, done: 2 } as const;
  return [...list].sort((a, b) => rank[a.state] - rank[b.state] || b.updatedAt - a.updatedAt);
}

/** Work → All work: every task from every bot, filtered by progress. */
function AllWork() {
  const bots = useStore((s) => s.bots);
  const tasks = useTasks();
  const [filter, setFilter] = useState<Filter>('open');
  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const counts = useMemo(() => ({ open: tasks?.filter((t) => t.state !== 'done').length ?? 0, done: tasks?.filter((t) => t.state === 'done').length ?? 0 }), [tasks]);
  const shown = useMemo(() => sortTasks((tasks ?? []).filter((t) => filter === 'all' || (filter === 'done' ? t.state === 'done' : t.state !== 'done'))), [tasks, filter]);

  return (
    <>
      <div className="segmented work-filter" role="tablist" aria-label="Filter tasks">
        {([['open', `In progress${counts.open ? ` ${counts.open}` : ''}`], ['done', 'Done'], ['all', 'All']] as [Filter, string][]).map(([f, label]) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? 'is-active' : ''} onClick={() => setFilter(f)}>{label}</button>
        ))}
      </div>
      {tasks === null ? <div className="cfg-empty">Loading…</div> : shown.length === 0 ? (
        <div className="tasks-empty">
          <Glyph name="tasks" size={28} opacity={0.35} />
          <div className="tasks-empty__title">{filter === 'done' ? 'Nothing finished yet' : 'Nothing in progress'}</div>
          <div className="tasks-empty__sub">Give a Bot a multi-part request and every piece gets its own row here, so progress is easy to follow.</div>
        </div>
      ) : (
        <div className="task-list">{shown.map((t) => <TaskRow key={t.id} t={t} bot={byId.get(t.botId)} showBot />)}</div>
      )}
    </>
  );
}

/** Full Work view in the main column (sidebar → Work): what needs you, all tasks, and projects. */
export function TasksView() {
  const tab = useConfigUI((s) => s.workTab);
  const setTab = useConfigUI((s) => s.setWorkTab);
  const attention = useAttention();
  const tabs: [WorkTab, string][] = [
    ['attention', `Needs attention${attention.total ? ` ${attention.total}` : ''}`],
    ['all', 'All work'],
    ['projects', 'Projects'],
  ];

  return (
    <main className="chat tasks-view">
      <header className="tasks-view__header">
        <div className="tasks-view__title">Work</div>
        <div className="segmented" role="tablist" aria-label="Work sections">
          {tabs.map(([t, label]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)}>{label}</button>
          ))}
        </div>
      </header>
      <div className="tasks-view__scroll">
        <div className="tasks-view__inner">
          {tab === 'attention' ? <NeedsAttention /> : tab === 'projects' ? <ProjectsPanel /> : <AllWork />}
        </div>
      </div>
    </main>
  );
}

/** Sidebar entry for the Work view, with a count of everything that needs the person. */
export function TasksIsland() {
  const view = useConfigUI((s) => s.view);
  const { total } = useAttention();
  return (
    <button type="button" className={`sidebar-island${view === 'tasks' ? ' is-active' : ''}`} onClick={() => useConfigUI.getState().setView(view === 'tasks' ? 'chat' : 'tasks')} title={total > 0 ? `Work: ${total} need${total === 1 ? 's' : ''} you` : 'Work'} aria-pressed={view === 'tasks'}>
      <span className="sidebar-island__icon"><Glyph name="tasks" size={18} /></span>
      <span className="sidebar-island__label">Work</span>
      {total > 0 && <span className="sidebar-island__count" aria-label={`${total} need attention`}>{total}</span>}
    </button>
  );
}

/** Tasks for one bot (details panel → Tasks tab). */
export function BotTasks({ bot }: { bot: Bot }) {
  const tasks = useTasks(bot.id);
  const sorted = useMemo(() => sortTasks(tasks ?? []), [tasks]);
  return (
    <div className="details__sections">
      <section>
        <div className="section-label section-label--row">
          <span>Tasks</span>
          <button type="button" className="link-btn link-btn--small" onClick={() => useConfigUI.getState().setView('tasks')}>See all</button>
        </div>
        {tasks === null ? <div className="panel-card"><div className="panel-empty">Loading…</div></div> : sorted.length === 0 ? (
          <div className="panel-card"><div className="panel-empty">No tasks yet. Ask {bot.name} for a few things at once and they’ll be tracked here.</div></div>
        ) : (
          <div className="panel-card task-list task-list--compact">{sorted.map((t) => <TaskRow key={t.id} t={t} bot={bot} showBot={false} />)}</div>
        )}
      </section>
    </div>
  );
}
