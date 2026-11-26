import { useCallback, useEffect, useState } from 'react';
import type { Space, SpaceKind } from '@shared/types';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { SpaceTag } from '../Spaces';
import { Modal } from './Modal';

function SpaceRow({ space, onError }: { space: Space; onError: (e: string | null) => void }) {
  const [name, setName] = useState(space.name);
  const [confirming, setConfirming] = useState(false);
  const [description, setDescription] = useState(space.description);
  const described = description.trim() !== space.description;
  const describe = () => run(() => api.updateSpace(space.id, { description }));
  const empty = space.botCount === 0 && space.projectCount === 0;
  const run = async (fn: () => Promise<unknown>) => {
    onError(null);
    try { await fn(); await useStore.getState().loadSpaces(); } catch (e) { onError((e as Error).message); }
  };
  const renamed = !!name.trim() && name.trim() !== space.name;
  const rename = () => run(() => api.updateSpace(space.id, { name }));
  return (
    <li className="space-list__row">
      <div className="space-list__head">
        <SpaceTag spaceId={space.id} />
        <span className="space-list__meta">{space.kind === 'business' ? 'Business' : 'Project'} · Bots and teams: {space.botCount} · Projects: {space.projectCount}</span>
      </div>
      <div className="space-list__edit">
        <input
          className="text-input"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          // Enter here renames; it must not submit the dialog's "new workspace" form.
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (renamed) void rename(); } }}
          aria-label={`Name of ${space.name}`}
        />
        {renamed && <button type="button" className="btn btn--secondary btn--sm" onClick={rename}>Rename</button>}
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={!empty}
          title={empty ? undefined : 'Move or delete its bots, teams and projects first'}
          onClick={() => (confirming ? run(() => api.deleteSpace(space.id)) : setConfirming(true))}
        >
          {confirming ? `Delete ${space.name}` : 'Delete'}
        </button>
      </div>
      <div className="space-list__edit">
        <input
          className="text-input"
          placeholder="What it does, in one line (its bots read this)"
          value={description}
          maxLength={300}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (described) void describe(); } }}
          aria-label={`Description of ${space.name}`}
        />
        {described && <button type="button" className="btn btn--secondary btn--sm" onClick={describe}>Save</button>}
      </div>
    </li>
  );
}

/** Make, rename and remove workspaces: one per business or project. */
export function SpacesModal() {
  const setModal = useStore((s) => s.setModal);
  const spaces = useStore((s) => s.spaces);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SpaceKind>('business');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => setModal(null), [setModal]);
  // Counts may be stale: bots and projects can have moved since they were last read.
  useEffect(() => { useStore.getState().loadSpaces().catch((e) => setError((e as Error).message)); }, []);

  const create = async (thenAddBot: boolean) => {
    if (!name.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const { space } = await api.createSpace({ name, kind, description });
      const st = useStore.getState();
      await st.loadSpaces();
      st.set({ activeSpace: space.id });
      setName(''); setDescription('');
      if (thenAddBot) setModal('create');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={close} className="create-modal" label="Workspaces">
      <form onSubmit={(e) => { e.preventDefault(); void create(true); }}>
        <div className="modal__header">
          <div className="modal__title">Workspaces</div>
          <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={14} opacity={0.68} /></button>
        </div>
        <div className="create-modal__body" style={{ alignItems: 'stretch' }}>
          <p className="space-note">
            One workspace per business or project. Its bots, teams and projects stay together and share a memory of their own.
            Connected apps, Build-flow and the computer's files are still shared by all workspaces. Your main bot stays in General and can reach every workspace.
          </p>
          {spaces.length > 0 && <ul className="space-list">{spaces.map((s) => <SpaceRow key={s.id} space={s} onError={setError} />)}</ul>}
          <div className="section-label">New workspace</div>
          <input className="text-input" placeholder="Business or project name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="Workspace name" />
          <div className="mode-pick" role="radiogroup" aria-label="Workspace kind">
            {(['business', 'project'] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={`mode-pick__opt${kind === k ? ' is-active' : ''}`} onClick={() => setKind(k)}>
                <span className="mode-pick__title">{k === 'business' ? 'Business' : 'Project'}</span>
                <span className="mode-pick__sub">{k === 'business' ? 'A company you run or serve' : 'A piece of work of its own'}</span>
              </button>
            ))}
          </div>
          <input className="text-input" placeholder="What it does, in one line (its bots read this)" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} aria-label="Workspace description" />
          {error && <div className="card__error" role="alert">{error}</div>}
        </div>
        <div className="modal__footer">
          <button type="button" className="btn btn--secondary btn--sm" onClick={close}>Done</button>
          <button type="button" className="btn btn--secondary btn--sm" disabled={!name.trim() || busy} onClick={() => create(false)}>Create</button>
          <button type="submit" className="btn btn--primary btn--sm" disabled={!name.trim() || busy}>{busy ? 'Creating…' : 'Create and add a bot'}</button>
        </div>
      </form>
    </Modal>
  );
}
