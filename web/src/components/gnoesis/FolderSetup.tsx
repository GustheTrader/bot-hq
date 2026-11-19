import { useEffect, useState } from 'react';
import type { Project } from '@shared/types';
import { configApi } from '../../lib/configApi';
import { useConfigUI } from '../../configStore';
import { useGithubStatus } from './github';

export type FolderKind = 'new' | 'clone' | 'worktree';
const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/**
 * Inside the composer: make the folder the work happens in. A new empty folder, a GitHub repository cloned into the
 * workspace, or a new git worktree (a second checkout on its own branch) beside an existing folder. `onReady` gets
 * the folder's path on the computer.
 */
export function FolderSetup({ kind, projects, onReady, onCancel }: { kind: FolderKind; projects: Project[]; onReady: (folder: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [source, setSource] = useState(projects.find((p) => p.folder.trim())?.folder ?? '');
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const gh = useGithubStatus();

  useEffect(() => {
    if (kind !== 'clone' || !gh.status?.signedIn) return;
    configApi.githubRepos().then((r) => setRepos(r.repos.map((x) => x.nameWithOwner))).catch(() => {});
  }, [kind, gh.status?.signedIn]);

  const go = async () => {
    setBusy(true); setError(null);
    try {
      const r = kind === 'new' ? await configApi.newFolder(name)
        : kind === 'clone' ? await configApi.cloneRepo(repo)
        : await configApi.newWorktree(source, branch, base.trim() || undefined);
      onReady(r.folder);
    } catch (e) { setError(errText(e, 'That did not work')); }
    finally { setBusy(false); }
  };

  const ready = kind === 'new' ? !!name.trim() : kind === 'clone' ? !!repo.trim() : !!source.trim() && !!branch.trim();
  const sources = projects.filter((p) => p.folder.trim());

  return (
    <div className="folder-setup">
      {kind === 'new' && (
        <label className="proj-field proj-field--wide">
          <span className="proj-field__label">New folder in Projects</span>
          <input className="text-input" autoFocus value={name} placeholder="pricing-experiment" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && ready) void go(); }} aria-label="New folder name" />
        </label>
      )}
      {kind === 'clone' && (
        <>
          <label className="proj-field proj-field--wide">
            <span className="proj-field__label">GitHub repository</span>
            <input className="text-input" autoFocus list="gw-repos" value={repo} placeholder="owner/name or a github.com link" onChange={(e) => setRepo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && ready) void go(); }} aria-label="GitHub repository" />
            <datalist id="gw-repos">{repos.map((r) => <option key={r} value={r} />)}</datalist>
          </label>
          {gh.status && !gh.status.signedIn && (
            <span className="folder-setup__hint">Git on the computer is not signed in to GitHub, so only public repositories will clone. <button type="button" className="link-btn link-btn--small" onClick={() => useConfigUI.getState().setWorkTab('github')}>Sign in</button></span>
          )}
        </>
      )}
      {kind === 'worktree' && (
        <>
          <label className="proj-field proj-field--wide">
            <span className="proj-field__label">From the checkout in</span>
            <input className="text-input" list="gw-sources" value={source} placeholder="/home/workspace/Projects/…" onChange={(e) => setSource(e.target.value)} aria-label="Folder to branch from" />
            <datalist id="gw-sources">{sources.map((p) => <option key={p.id} value={p.folder}>{p.name}</option>)}</datalist>
          </label>
          <label className="proj-field">
            <span className="proj-field__label">New branch</span>
            <input className="text-input" autoFocus value={branch} placeholder="feature/login" onChange={(e) => setBranch(e.target.value)} aria-label="Branch name" />
          </label>
          <label className="proj-field">
            <span className="proj-field__label">Based on (optional)</span>
            <input className="text-input" value={base} placeholder="main" onChange={(e) => setBase(e.target.value)} aria-label="Base branch" />
          </label>
        </>
      )}
      <span className="folder-setup__buttons">
        <button type="button" className="btn btn--secondary btn--sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn--primary btn--sm" onClick={go} disabled={!ready || busy}>
          {busy ? (kind === 'clone' ? 'Cloning…' : 'Making…') : kind === 'new' ? 'Create folder' : kind === 'clone' ? 'Clone' : 'Create worktree'}
        </button>
      </span>
      {error && <div className="card__error folder-setup__error" role="alert">{error}</div>}
    </div>
  );
}
