import { useCallback, useState } from 'react';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { api } from '../../lib/api';
import { newSpaceId, shownSpace, useStore } from '../../store';
import { SpaceSelect } from '../Spaces';
import { Icon } from '../Icon';
import { Modal } from './Modal';

interface Person { name: string; email: string }

/** New team: a name, at least one Bot, and any number of people. */
export function CreateGroupModal() {
  const setModal = useStore((s) => s.setModal);
  const allBots = useStore((s) => s.bots);
  const [spaceId, setSpaceId] = useState<string | null>(() => newSpaceId(shownSpace(useStore.getState())));
  // A team stays inside one workspace; the main bot can join any.
  const bots = allBots.filter((b) => b.kind !== 'team' && (b.isPrimary || (b.spaceId ?? null) === spaceId));
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [personName, setPersonName] = useState('');
  const [personEmail, setPersonEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => setModal(null), [setModal]);
  const canCreate = name.trim().length > 0 && picked.length >= 1 && !busy;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const addPerson = () => {
    const n = personName.trim();
    if (!n) return;
    setPeople((list) => [...list, { name: n, email: personEmail.trim() }]);
    setPersonName('');
    setPersonEmail('');
  };

  const create = async () => {
    if (!canCreate) return;
    setBusy(true); setError(null);
    try {
      const { id } = await api.createTeamWithPeople(name.trim(), picked, people.map((p) => ({ name: p.name, email: p.email || undefined })), spaceId);
      const { bots: all } = await api.bots();
      const st = useStore.getState();
      st.set({ bots: all });
      st.selectBot(id);
      close();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={close} className="create-modal" label="New team">
      <form onSubmit={(e) => { e.preventDefault(); create(); }}>
        <div className="modal__header">
          <div className="modal__title">New team</div>
          <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={14} opacity={0.68} /></button>
        </div>
        <div className="create-modal__body" style={{ alignItems: 'stretch' }}>
          <input className="text-input create-modal__name" placeholder="Name your team" value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Team name" />

          <div className="section-label" style={{ marginTop: 14 }}>Workspace</div>
          <SpaceSelect value={spaceId} onChange={(id) => { setSpaceId(id); setPicked((p) => p.filter((x) => allBots.some((b) => b.id === x && b.isPrimary))); }} />

          <div className="section-label" style={{ marginTop: 14 }}>Bots on this team</div>
          <div className="group-pick">
            {bots.map((b) => (
              <button key={b.id} type="button" role="checkbox" aria-checked={picked.includes(b.id)} className={`group-pick__opt${picked.includes(b.id) ? ' is-active' : ''}`} onClick={() => toggle(b.id)}>
                <BotAvatarFor bot={b} size={24} />
                <span className="group-pick__name">{b.name}{b.label ? ` · ${b.label}` : ''}</span>
                {picked.includes(b.id) && <Icon name="check" size={12} opacity={0.8} />}
              </button>
            ))}
          </div>

          <div className="section-label" style={{ marginTop: 14 }}>People on this team <span className="section-label__hint">optional</span></div>
          <div className="team-people">
            {people.map((p, i) => (
              <div key={`${p.name}-${i}`} className="team-people__row">
                <span className="team-people__avatar" aria-hidden><Icon name="person" size={14} opacity={0.7} /></span>
                <span className="team-people__text">
                  <span className="team-people__name">{p.name}</span>
                  {p.email && <span className="team-people__email">{p.email}</span>}
                </span>
                <button type="button" className="icon-btn members__remove" aria-label={`Remove ${p.name}`} onClick={() => setPeople((list) => list.filter((_, j) => j !== i))}>
                  <Icon name="close" size={10} opacity={0.56} />
                </button>
              </div>
            ))}
            <div className="team-people__add">
              <input className="text-input" placeholder="Name" value={personName} onChange={(e) => setPersonName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPerson(); } }} aria-label="Teammate name" />
              <input className="text-input" placeholder="Email (optional)" value={personEmail} onChange={(e) => setPersonEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPerson(); } }} aria-label="Teammate email" />
              <button type="button" className="btn btn--secondary btn--sm" onClick={addPerson} disabled={!personName.trim()}>Add</button>
            </div>
          </div>

          {error && <div className="card__error">{error}</div>}
        </div>
        <div className="modal__footer">
          <button type="button" className="btn btn--secondary btn--sm" onClick={close}>Cancel</button>
          <button type="submit" className="btn btn--primary btn--sm" disabled={!canCreate}>{busy ? 'Creating…' : 'Create team'}</button>
        </div>
      </form>
    </Modal>
  );
}
