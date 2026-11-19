import { useEffect, useState } from 'react';
import type { Bot, Project } from '@shared/types';
import { configApi } from '../../lib/configApi';
import { useStore } from '../../store';
import { Modal } from './Modal';

/** Launch the interactive OpenCode terminal on the selected bot's computer. */
export function OpenCodeModal({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    configApi.projects().then(({ projects }) => {
      if (active) setProjects(projects.filter((project) => project.folder));
    }).catch(() => {
      if (active) setError('Could not load projects. You can enter a folder below.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const launch = async () => {
    if (busy || !folder.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await configApi.openTerminal(bot.id, folder.trim());
      // Select the bot the request was made for, even if selection changed while launching.
      useStore.getState().selectBot(bot.id);
      useStore.setState({ viewerOpen: true, viewerMode: 'control', viewerHint: null });
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not open OpenCode.');
      setBusy(false);
    }
  };

  return (
    <Modal label="OpenCode terminal" className="create-modal" onClose={busy ? () => {} : onClose}>
      <form onSubmit={(event) => { event.preventDefault(); void launch(); }}>
        <div className="modal__header">
          <div className="modal__title">OpenCode · {bot.name}</div>
          <button type="button" className="link-btn" disabled={busy} onClick={onClose} aria-label="Close OpenCode launcher">Close</button>
        </div>
        <div className="create-modal__body">
          <p>Work interactively with OpenCode on this bot’s computer. Choose a project folder, then type directly in its terminal.</p>
          <label htmlFor="opencode-project">Project</label>
          <select id="opencode-project" className="text-input" disabled={busy || loading} value={projects.find((project) => project.folder === folder)?.id ?? ''} onChange={(event) => setFolder(projects.find((project) => project.id === event.target.value)?.folder ?? '')}>
            <option value="">{loading ? 'Loading projects…' : 'Enter a folder'}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <label htmlFor="opencode-folder">Folder on the computer</label>
          <input id="opencode-folder" className="text-input" value={folder} disabled={busy} placeholder="/home/workspace/Projects/my-project" onChange={(event) => setFolder(event.target.value)} required />
          <p>OpenCode uses its own sign-in and model selection. The terminal can edit files in this folder.</p>
          {error && <div className="card__error" role="alert">{error}</div>}
        </div>
        <div className="modal__footer">
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !folder.trim()}>{busy ? 'Opening…' : 'Open terminal'}</button>
        </div>
      </form>
    </Modal>
  );
}
