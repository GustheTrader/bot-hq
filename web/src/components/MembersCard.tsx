import { useCallback, useEffect, useState } from 'react';
import type { Bot, TeamMember } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { useStore } from '../store';
import { Icon } from './Icon';

/**
 * A team's roster: Bots (agents with their own screen) and people (teammates with no agent).
 * Shown in the details panel for team channels. The first Bot is the lead and speaks first
 * on a team message when nobody is @mentioned.
 */
export function MembersCard({ team }: { team: Bot }) {
  const bots = useStore((s) => s.bots);
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [addingHuman, setAddingHuman] = useState(false);
  const [humanName, setHumanName] = useState('');
  const [humanEmail, setHumanEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.teamMembers(team.id).then((r) => setMembers(r.members)).catch((e) => setError((e as Error).message));
  }, [team.id]);
  useEffect(load, [load]);

  const botIds = members?.filter((m) => m.kind === 'bot').map((m) => m.id) ?? [];
  const humanIds = members?.filter((m) => m.kind === 'human').map((m) => m.id) ?? [];

  const save = async (nextBots: string[], nextHumans: string[]) => {
    setError(null);
    try { await api.setTeamRoster(team.id, nextBots, nextHumans); load(); } catch (e) { setError((e as Error).message); }
  };

  const setLead = async (memberId: string | null) => {
    setError(null);
    try { await api.setTeamLead(team.id, memberId); load(); } catch (e) { setError((e as Error).message); }
  };

  const addTeammate = async () => {
    if (!humanName.trim()) return;
    setError(null);
    try {
      const { id } = await api.addHuman(humanName.trim(), humanEmail.trim() || undefined);
      setHumanName(''); setHumanEmail(''); setAddingHuman(false);
      await save(botIds, [...humanIds, id]);
    } catch (e) { setError((e as Error).message); }
  };

  const candidates = bots.filter((b) => b.kind !== 'team' && !botIds.includes(b.id));
  const leadId = members?.find((m) => m.kind === 'bot' && m.role === 'lead')?.id ?? botIds[0];
  const leadName = (id?: string) => members?.find((m) => m.id === id)?.name ?? 'the first Bot';

  return (
    <div className="panel-card members">
      {members === null ? <div className="panel-empty">Loading…</div> : members.length === 0 ? (
        <div className="panel-empty">Nobody on this team yet.</div>
      ) : members.map((m) => {
        const bot = m.kind === 'bot' ? bots.find((b) => b.id === m.id) : undefined;
        const isLead = m.kind === 'bot' && m.role === 'lead';
        return (
          <div key={`${m.kind}:${m.id}`} className="panel-row members__row">
            {bot ? <BotAvatarFor bot={bot} size={24} /> : (
              <span className="members__person" aria-hidden><Icon name="person" size={14} opacity={0.7} /></span>
            )}
            <span className="members__text">
              <span className="members__name">
                {m.name}
                {m.kind !== 'bot' && <span className="members__badge">Person</span>}
              </span>
              <span className="members__label">{isLead ? 'Leads the team' : m.label || (m.kind === 'bot' ? 'Bot' : '')}</span>
            </span>
            {m.kind === 'bot' && !isLead && (
              <button
                type="button"
                className="icon-btn members__lead"
                aria-label={`Make ${m.name} lead`}
                title={`Make ${m.name} lead`}
                onClick={() => setLead(m.id)}
              >
                <Icon name="star" size={12} opacity={0.56} />
              </button>
            )}
            <button
              type="button"
              className="icon-btn members__remove"
              aria-label={`Remove ${m.name}`}
              title={`Remove ${m.name}`}
              onClick={() => m.kind === 'bot'
                ? save(botIds.filter((x) => x !== m.id), humanIds)
                : save(botIds, humanIds.filter((x) => x !== m.id))}
              disabled={m.kind === 'bot' && botIds.length <= 1}
            >
              <Icon name="close" size={10} opacity={0.56} />
            </button>
          </div>
        );
      })}

      {adding ? (
        <div className="members__add">
          {candidates.length ? candidates.map((b) => (
            <button key={b.id} type="button" className="panel-row panel-row--link" onClick={() => { setAdding(false); save([...botIds, b.id], humanIds); }}>
              <BotAvatarFor bot={b} size={20} />
              <span className="panel-row__title" style={{ flex: 1 }}>{b.name}</span>
            </button>
          )) : <div className="panel-empty">Every Bot is already here.</div>}
        </div>
      ) : (
        <button type="button" className="panel-row panel-row--action" onClick={() => setAdding(true)}>
          <Icon name="plus" size={12} opacity={0.56} /> Add a Bot
        </button>
      )}

      {addingHuman ? (
        <div className="members__add members__add--human">
          <input className="text-input" placeholder="Name" value={humanName} onChange={(e) => setHumanName(e.target.value)} aria-label="Teammate name" autoFocus />
          <input className="text-input" placeholder="Email (optional)" value={humanEmail} onChange={(e) => setHumanEmail(e.target.value)} aria-label="Teammate email" />
          <div className="members__add-actions">
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => { setAddingHuman(false); setHumanName(''); setHumanEmail(''); }}>Cancel</button>
            <button type="button" className="btn btn--primary btn--sm" onClick={addTeammate} disabled={!humanName.trim()}>Add</button>
          </div>
        </div>
      ) : (
        <button type="button" className="panel-row panel-row--action" onClick={() => setAddingHuman(true)}>
          <Icon name="plus" size={12} opacity={0.56} /> Add a person
        </button>
      )}

      {error && <div className="card__error">{error}</div>}
      <div className="members__hint">
        @mention a Bot to ask just them; with no mention, {leadName(leadId)} answers first and up to two others may chime in.
        People on the team read the channel but have no agent of their own.
      </div>
    </div>
  );
}
