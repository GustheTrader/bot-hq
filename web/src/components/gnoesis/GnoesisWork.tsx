import { useMemo, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import type { Bot } from '@shared/types';
import { useConfigUI, type WorkTab } from '../../configStore';
import { useStore } from '../../store';
import { relativeShort } from '../../lib/time';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { ChatView } from '../ChatView';
import { tierOf } from '../HqView';
import { AllWork } from '../config/TasksView';
import { LaunchPage } from '../work/LaunchPage';
import { NeedsAttention } from '../work/NeedsAttention';
import { ProjectsPanel } from '../work/ProjectsPanel';
import { useAttention } from '../work/attention';
import { WorktreesPanel } from './WorktreesPanel';
import { ArtifactsPanel } from './ArtifactsPanel';

/** Small stroke icons for the GnoesisWork sidebar (same 24px grid and 1.8 stroke throughout). */
const PATHS: Record<string, ReactNode> = {
  back: <path d="M15 18l-6-6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16.2v.3" /></>,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  branch: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10M18 10c0 4-6 3-11 7" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />,
};

export function GwIcon({ name, size = 16 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
      {PATHS[name]}
    </svg>
  );
}

const TITLES: Record<WorkTab, string> = {
  launch: '', attention: 'Needs attention', all: 'All work', projects: 'Projects', worktrees: 'Worktrees', artifacts: 'Artifacts', chat: '',
};

/** History: bots' conversations, most recent first, the way Claude lists recent chats. */
function Recents({ query, active, onOpen }: { query: string; active: string | null; onOpen: (b: Bot) => void }) {
  const bots = useStore((s) => s.bots);
  const live = useStore((s) => s.live);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...bots]
      .filter((b) => b.lastActivityAt > 0 || b.lastPreview)
      .filter((b) => !q || b.name.toLowerCase().includes(q) || (b.lastPreview ?? '').toLowerCase().includes(q) || b.label.toLowerCase().includes(q))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }, [bots, query]);

  if (list.length === 0) return <div className="gw-recents__empty">{query ? 'No conversation matches.' : 'No conversations yet.'}</div>;
  return (
    <div className="gw-recents" role="list">
      {list.map((b) => {
        const t = tierOf(live[b.id]);
        const state = t === 'needs' ? 'waiting' : t === 'working' ? 'working' : null;
        return (
          <button key={b.id} type="button" role="listitem" className={`gw-recent${active === b.id ? ' is-active' : ''}`} onClick={() => onOpen(b)} title={b.lastPreview ?? b.name}>
            <BotAvatarFor bot={b} size={18} />
            <span className="gw-recent__text">
              <span className="gw-recent__name">{b.name}{b.kind === 'team' ? ' · Team' : ''}</span>
              <span className="gw-recent__preview">{b.lastPreview ?? ''}</span>
            </span>
            {state ? <span className={`gw-recent__dot is-${state}`} aria-label={state === 'waiting' ? 'Waiting on you' : 'Working'} /> : <span className="gw-recent__when">{b.lastActivityAt ? relativeShort(b.lastActivityAt) : ''}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The bot that GnoesisWork itself works through, with its own screen (the "GnoesisWork computer"). */
export const isWorkBot = (b: Pick<Bot, 'name' | 'kind'>) => b.kind !== 'team' && b.name.trim().toLowerCase() === 'gnoesiswork';

/** Sidebar entry for GnoesisWork's own computer: opens its screen, or sets it up the first time. */
function ComputerEntry() {
  const bots = useStore((s) => s.bots);
  const computer = useStore((s) => s.computer);
  const bot = bots.find(isWorkBot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asleep = !!bot && !!computer?.screens.find((x) => x.botId === bot.id)?.asleep;

  const open = async () => {
    setError(null);
    let target = bot;
    if (!target) {
      setBusy(true);
      try {
        target = (await api.createBot({ name: 'GnoesisWork', avatarShape: 'sparkle', avatarColor: 'orange', avatarImage: null, mode: 'personal' })).bot;
        await useStore.getState().loadBots().catch(() => {});
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : 'Could not set up the computer');
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    useStore.getState().selectBot(target.id);
    useStore.setState({ viewerOpen: true }); // opening the screen also wakes it if it was asleep
  };

  return (
    <>
      <button type="button" className="gw-nav__item" onClick={open} disabled={busy} title={bot ? 'Open GnoesisWork’s own computer' : 'Give GnoesisWork its own computer (a bot with its own screen)'}>
        <GwIcon name="monitor" /> {busy ? 'Setting up…' : bot ? 'Computer' : 'Set up computer'}
        {bot && <span className={`gw-nav__state${asleep ? ' is-asleep' : ''}`}>{asleep ? 'asleep' : 'ready'}</span>}
      </button>
      {error && <div className="gw-nav__error" role="alert">{error}</div>}
    </>
  );
}

/**
 * GnoesisWork: the full-page Work view, laid out like the Claude desktop app. A sidebar (new work, search,
 * what needs you, all work, projects, worktrees, artifacts, and the history of conversations) and one main area:
 * the centred composer, a section, or a bot's chat opened in place. "Bot HQ" in the corner goes back.
 */
export function GnoesisWork() {
  const tab = useConfigUI((s) => s.workTab);
  const setTab = useConfigUI((s) => s.setWorkTab);
  const selected = useStore((s) => s.selectedBotId);
  const attention = useAttention();
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);

  const back = () => useConfigUI.getState().setView('chat');
  const open = (b: Bot) => {
    if (useStore.getState().selectedBotId === b.id) setTab('chat');
    else useStore.getState().selectBot(b.id); // configStore turns this into the in-place chat
  };

  const nav: { id: WorkTab; label: string; icon: keyof typeof PATHS; count?: number }[] = [
    { id: 'attention', label: 'Needs attention', icon: 'alert', count: attention.total },
    { id: 'all', label: 'All work', icon: 'list' },
    { id: 'projects', label: 'Projects', icon: 'folder' },
    { id: 'worktrees', label: 'Worktrees', icon: 'branch' },
    { id: 'artifacts', label: 'Artifacts', icon: 'file' },
  ];

  return (
    <div className="gw">
      <aside className="gw-side" aria-label="GnoesisWork">
        <button type="button" className="gw-back" onClick={back} title="Back to Bot HQ">
          <GwIcon name="back" size={14} /> Bot HQ
        </button>
        <div className="gw-brand"><GwIcon name="spark" size={16} /> GnoesisWork</div>

        <nav className="gw-nav">
          <button type="button" className={`gw-nav__item gw-nav__item--new${tab === 'launch' ? ' is-active' : ''}`} onClick={() => setTab('launch')}>
            <GwIcon name="plus" /> New
          </button>
          {searching ? (
            <label className="gw-search">
              <GwIcon name="search" />
              <input autoFocus value={query} placeholder="Search history" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); setSearching(false); } }} aria-label="Search history" />
            </label>
          ) : (
            <button type="button" className="gw-nav__item" onClick={() => setSearching(true)}><GwIcon name="search" /> Search</button>
          )}
          {nav.map((n) => (
            <button key={n.id} type="button" className={`gw-nav__item${tab === n.id ? ' is-active' : ''}`} onClick={() => setTab(n.id)} aria-current={tab === n.id ? 'page' : undefined}>
              <GwIcon name={n.icon} /> {n.label}
              {!!n.count && <span className="gw-nav__count">{n.count}</span>}
            </button>
          ))}
          <ComputerEntry />
        </nav>

        <div className="gw-side__label">Recents</div>
        <Recents query={query} active={tab === 'chat' ? selected : null} onOpen={open} />
      </aside>

      <main className={`gw-main${tab === 'chat' ? ' gw-main--chat' : ''}${tab === 'launch' ? ' gw-main--home' : ''}`}>
        {tab === 'chat' ? <ChatView /> : (
          <div className="gw-scroll">
            <div className="gw-page">
              {TITLES[tab] && <h1 className="gw-title">{TITLES[tab]}</h1>}
              {tab === 'launch' ? <LaunchPage stay /> : tab === 'attention' ? <NeedsAttention /> : tab === 'all' ? <AllWork /> : tab === 'projects' ? <ProjectsPanel /> : tab === 'worktrees' ? <WorktreesPanel /> : <ArtifactsPanel />}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
