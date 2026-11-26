import { useCallback, useEffect, useState } from 'react';
import type { Bot, TeamMember } from '@shared/types';
import { api, type Human, type TeamsResponse } from '../lib/api';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { relativeShort } from '../lib/time';
import { displayName, inSpace, shownSpace, useStore } from '../store';
import { SpaceSwitcher, SpaceTag } from './Spaces';
import { useConfigUI } from '../configStore';
import { Icon } from './Icon';
import { LiveSignal } from './LiveSignal';
import { Glyph } from './config/glyphs';
import './config/ui';

/**
 * Team view: one roster mixing Bots (agents) and people. A team is a channel
 * (bots row with kind='team') whose members live in team_members. Bots answer
 * messages posted here; people are notified by @mention.
 */
export function TeamsView() {
  const bots = useStore((s) => s.bots);
  const [data, setData] = useState<TeamsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [newBots, setNewBots] = useState<string[]>([]);

  const load = useCallback(() => {
    api.teams()
      .then((r) => {
        setData(r);
        setSelected((cur) => (cur && r.teams.some((t) => t.id === cur) ? cur : r.teams[0]?.id ?? null));
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(load, [load]);

  const activeSpace = useStore(shownSpace);
  const spaceOf = (id: string) => bots.find((b) => b.id === id)?.spaceId ?? null;
  // A team stays inside one workspace, so the first bot picked narrows the rest to its workspace.
  const pickedSpace = newBots.length ? spaceOf(newBots[0]) : undefined;
  const candidateBots = bots.filter((b) => b.kind !== 'team' && !b.isPrimary && inSpace(b, activeSpace) && (pickedSpace === undefined || (b.spaceId ?? null) === pickedSpace));
  const shown = data?.teams.filter((t) => inSpace({ spaceId: spaceOf(t.id) }, activeSpace)) ?? [];
  const team = shown.find((t) => t.id === selected) ?? shown[0] ?? null;
  // A pick made under another filter would be hidden but still sent.
  useEffect(() => { setNewBots([]); }, [activeSpace]);

  const createTeam = async () => {
    if (!newName.trim() || newBots.length === 0) return;
    setBusy(true); setError(null);
    try {
      const { id } = await api.createTeam(newName.trim(), newBots);
      setNewName(''); setNewBots([]);
      await useStore.getState().loadBots();
      setSelected(id);
      load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const openTeamChat = (id: string) => {
    useStore.getState().selectBot(id);
    useConfigUI.getState().setView('chat');
  };

  if (error && !data) return <main className="chat teams-view"><div className="cfg-empty">{error}</div></main>;

  return (
    <main className="chat teams-view">
      <header className="teams-view__header">
        <div className="teams-view__title">Teams</div>
        <div className="teams-view__sub">Bots and people working the same roster</div>
        <SpaceSwitcher />
      </header>
      <div className="teams-view__scroll">
        <div className="teams-view__inner">
          <section className="teams-panel teams-panel--new">
            <div className="section-label">New team</div>
            <div className="teams-new">
              <input
                className="text-input"
                placeholder="Team name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                aria-label="Team name"
              />
              <div className="teams-new__pick">
                {candidateBots.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    role="checkbox"
                    aria-checked={newBots.includes(b.id)}
                    className={`teams-chip${newBots.includes(b.id) ? ' is-on' : ''}`}
                    onClick={() => setNewBots((p) => (p.includes(b.id) ? p.filter((x) => x !== b.id) : [...p, b.id]))}
                  >
                    <BotAvatarFor bot={b} size={18} />
                    <span>{b.name}</span>
                    {activeSpace === 'all' && <SpaceTag spaceId={b.spaceId} />}
                  </button>
                ))}
                {candidateBots.length === 0 && <div className="teams-new__empty">Create a Bot first — a team needs at least one.</div>}
              </div>
              <button type="button" className="btn btn--primary btn--sm" disabled={busy || !newName.trim() || newBots.length === 0} onClick={createTeam}>
                {busy ? 'Creating…' : 'Create team'}
              </button>
            </div>
          </section>

          {data === null ? (
            <div className="cfg-empty">Loading…</div>
          ) : shown.length === 0 ? (
            <div className="tasks-empty">
              <Glyph name="tasks" size={28} opacity={0.35} />
              <div className="tasks-empty__title">No teams yet</div>
              <div className="tasks-empty__sub">Name a team above and pick the Bots on it. You can add people and set a lead once it exists.</div>
            </div>
          ) : (
            <>
              <div className="teams-tabs">
                {shown.map((t) => (
                  <button key={t.id} type="button" className={`teams-tab${t.id === team?.id ? ' is-active' : ''}`} onClick={() => setSelected(t.id)}>
                    {t.name}
                    {activeSpace === 'all' && <SpaceTag spaceId={spaceOf(t.id)} />}
                    <span className="teams-tab__count">{t.members.length}</span>
                  </button>
                ))}
              </div>
              {team && (
                <TeamDetail
                  key={team.id}
                  team={team}
                  bots={bots.filter((b) => b.isPrimary || (b.spaceId ?? null) === spaceOf(team.id))}
                  humans={data.humans}
                  onOpenChat={() => openTeamChat(team.id)}
                  onChanged={load}
                />
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function TeamDetail({
  team,
  bots,
  humans,
  onOpenChat,
  onChanged,
}: {
  team: TeamsResponse['teams'][number];
  bots: Bot[];
  humans: Human[];
  onOpenChat: () => void;
  onChanged: () => void;
}) {
  const [members, setMembers] = useState<TeamMember[]>(team.members);
  const [error, setError] = useState<string | null>(null);
  const [addName, setAddName] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [brief, setBrief] = useState(team.brief.text);
  const [savingBrief, setSavingBrief] = useState(false);

  useEffect(() => setMembers(team.members), [team.members]);
  useEffect(() => setBrief(team.brief.text), [team.id, team.brief.text]);

  const reload = useCallback(() => {
    api.teamMembers(team.id).then((r) => setMembers(r.members)).catch((e) => setError((e as Error).message));
  }, [team.id]);

  const botIds = members.filter((m) => m.kind === 'bot').map((m) => m.id);
  const humanIds = members.filter((m) => m.kind === 'human').map((m) => m.id);

  const save = async (nextBots: string[], nextHumans: string[]) => {
    setError(null);
    try { await api.setTeamRoster(team.id, nextBots, nextHumans); reload(); onChanged(); useStore.getState().loadBots(); }
    catch (e) { setError((e as Error).message); }
  };

  const setLead = async (memberId: string | null) => {
    setError(null);
    try { await api.setTeamLead(team.id, memberId); reload(); }
    catch (e) { setError((e as Error).message); }
  };
  /** Flip a bot between observer (silent unless @mentioned) and a normal responder. */
  const setObserver = async (memberId: string, on: boolean) => {
    setError(null);
    try { await api.setTeamRole(team.id, 'bot', memberId, on ? 'observer' : 'member'); reload(); }
    catch (e) { setError((e as Error).message); }
  };

  const saveBrief = async () => {
    setSavingBrief(true); setError(null);
    try {
      const r = await api.setTeamBrief(team.id, brief);
      setBrief(r.text);
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setSavingBrief(false); }
  };

  const addPerson = async () => {
    if (!addName.trim()) return;
    setError(null);
    try {
      const { id } = await api.addHuman(addName.trim(), addEmail.trim() || undefined);
      setAddName(''); setAddEmail('');
      await save(botIds, [...humanIds, id]);
    } catch (e) { setError((e as Error).message); }
  };

  const candidates = bots.filter((b) => b.kind !== 'team' && !b.isPrimary && !botIds.includes(b.id));
  const leadId = members.find((m) => m.kind === 'bot' && m.role === 'lead')?.id ?? botIds[0];

  return (
    <section className="teams-panel">
      <div className="teams-panel__head">
        <div className="teams-panel__name">{team.name}</div>
        <button type="button" className="btn btn--secondary btn--sm" onClick={onOpenChat}>Open team chat</button>
      </div>

      <div className="section-label">Team brief</div>
      <div className="panel-card team-brief">
        <textarea
          className="team-brief__text"
          placeholder="What is this team for? The mission, the current objective, the rules — every member reads this before it answers."
          value={brief}
          rows={4}
          onChange={(e) => setBrief(e.target.value)}
          aria-label="Team brief"
        />
        <div className="team-brief__foot">
          <span className="team-brief__meta">
            {team.brief.updatedAt && brief === team.brief.text
              ? `Saved ${relativeShort(team.brief.updatedAt)}`
              : brief.trim() === team.brief.text
                ? 'Standing context for every member'
                : 'Unsaved changes'}
          </span>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={savingBrief || brief.trim() === team.brief.text}
            onClick={saveBrief}
          >
            {savingBrief ? 'Saving…' : 'Save brief'}
          </button>
        </div>
      </div>

      <div className="section-label">Bots on this team</div>
      <div className="panel-card members">
        {members.filter((m) => m.kind === 'bot').length === 0 ? (
          <div className="panel-empty">No Bots on this team yet.</div>
        ) : members.filter((m) => m.kind === 'bot').map((m) => {
          const bot = bots.find((b) => b.id === m.id);
          const isLead = m.id === leadId;          const isObserver = m.role === 'observer';
          return (
            <div key={`bot:${m.id}`} className="panel-row members__row">
              {bot ? <BotAvatarFor bot={bot} size={24} /> : <span className="members__dot" />}
              <span className="members__text">
                <span className="members__name">
                  {bot ? displayName(bot) : m.name}
                  {isLead && <span className="members__badge">Speaks first</span>}
                  {isObserver && <span className="members__badge members__badge--obs">Observer</span>}
                </span>
                {bot && <LiveSignal botId={bot.id} />}
              </span>
              {!isLead && (
                <button type="button" className="icon-btn members__remove" title="Make this Bot speak first" aria-label={`Make ${m.name} speak first`} onClick={() => setLead(m.id)}>
                  <Icon name="star" size={12} opacity={0.5} />
                </button>
              )}
              <button type="button" className="icon-btn members__obs" title={isObserver ? 'Observer: silent unless @mentioned' : 'Make an observer (silent unless @mentioned)'} aria-label={`Toggle observer for ${m.name}`} aria-pressed={isObserver} disabled={isLead} onClick={() => setObserver(m.id, !isObserver)}>
                <Icon name="eye" size={12} opacity={isObserver ? 0.95 : 0.4} />
              </button>
              <button type="button" className="icon-btn members__remove" title="Remove from team" aria-label={`Remove ${m.name}`} disabled={botIds.length <= 1} onClick={() => save(botIds.filter((x) => x !== m.id), humanIds)}>
                <Icon name="close" size={10} opacity={0.56} />
              </button>
            </div>
          );
        })}
      </div>
      {candidates.length > 0 && (
        <div className="members__add">
          <div className="members__hint">Add a Bot</div>
          <div className="teams-new__pick">
            {candidates.map((b) => (
              <button key={b.id} type="button" className="teams-chip" onClick={() => save([...botIds, b.id], humanIds)}>
                <Icon name="plus" size={10} opacity={0.6} />
                <span>{b.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="section-label" style={{ marginTop: 16 }}>People on this team</div>
      <div className="panel-card members">
        {members.filter((m) => m.kind === 'human').length === 0 ? (
          <div className="panel-empty">No people yet. Add teammates below — they are notified when @mentioned.</div>
        ) : members.filter((m) => m.kind === 'human').map((m) => (
          <div key={`human:${m.id}`} className="panel-row members__row">
            <span className="members__person" aria-hidden><Icon name="person" size={14} opacity={0.7} /></span>
            <span className="members__text">
              <span className="members__name">{m.name}</span>
              {m.label && <span className="members__label">{m.label}</span>}
            </span>
            <button type="button" className="icon-btn members__remove" title="Remove from team" aria-label={`Remove ${m.name}`} onClick={() => save(botIds, humanIds.filter((x) => x !== m.id))}>
              <Icon name="close" size={10} opacity={0.56} />
            </button>
          </div>
        ))}
        <div className="team-people__add">
          <input className="text-input" placeholder="Name" value={addName} onChange={(e) => setAddName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPerson(); } }} aria-label="Teammate name" />
          <input className="text-input" placeholder="Email (optional)" value={addEmail} onChange={(e) => setAddEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPerson(); } }} aria-label="Teammate email" />
          <button type="button" className="btn btn--secondary btn--sm" onClick={addPerson} disabled={!addName.trim()}>Add</button>
        </div>
      </div>

      {humans.length > 0 && (
        <div className="teams-known">
          <div className="members__hint">People you have added before</div>
          <div className="teams-new__pick">
            {humans.filter((h) => !humanIds.includes(h.id)).map((h) => (
              <button key={h.id} type="button" className="teams-chip" onClick={() => save(botIds, [...humanIds, h.id])}>
                <Icon name="plus" size={10} opacity={0.6} />
                <span>{h.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <div className="card__error">{error}</div>}
    </section>
  );
}

/** Sidebar entry for the Team view, with the number of teams. */
export function TeamsIsland() {
  const view = useConfigUI((s) => s.view);
  const setView = useConfigUI((s) => s.setView);
  const bots = useStore((s) => s.bots);
  const teams = bots.filter((b) => b.kind === 'team');
  void relativeShort;
  return (
    <button type="button" className={`sidebar-island${view === 'teams' ? ' is-active' : ''}`} onClick={() => setView('teams')} title="Teams" aria-pressed={view === 'teams'}>
      <span className="sidebar-island__icon"><Icon name="users" size={18} /></span>
      <span className="sidebar-island__label">Teams</span>
      {teams.length > 0 && <span className="sidebar-island__count">{teams.length}</span>}
    </button>
  );
}
