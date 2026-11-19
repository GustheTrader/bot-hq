import { useEffect, useMemo, useState } from 'react';
import { configApi } from '../../lib/configApi';
import { useConfigUI } from '../../configStore';
import { relativeShort } from '../../lib/time';
import { GitHubCard, openTerminalAgent, useGithubStatus } from './github';

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
type Repo = { nameWithOwner: string; description: string; isPrivate: boolean; updatedAt: string };

/** What to do with a folder that is ready: start work there, or open a terminal agent in it. */
export function FolderReady({ folder, onDone }: { folder: string; onDone?: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const start = () => { useConfigUI.getState().setLaunchFolder(folder); useConfigUI.getState().setWorkTab('launch'); onDone?.(); };
  const term = () => { setError(null); openTerminalAgent(folder).catch((e) => setError(errText(e, 'Could not open OpenCode'))); };
  return (
    <div className="folder-ready" role="status">
      <span className="folder-ready__path" title={folder}>Ready: {folder}</span>
      <button type="button" className="btn btn--primary btn--sm" onClick={start}>Start work here</button>
      <button type="button" className="btn btn--secondary btn--sm" onClick={term} title="Open OpenCode, a terminal agent, in this folder on GnoesisWork's computer">OpenCode here</button>
      {error && <span className="folder-ready__error" role="alert">{error}</span>}
    </div>
  );
}

/** GnoesisWork → GitHub: sign-in status, the account's repositories, and cloning one into the workspace. */
export function GitHubPanel() {
  const { status } = useGithubStatus();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [typed, setTyped] = useState('');
  const [cloning, setCloning] = useState<string | null>(null);
  const [cloned, setCloned] = useState<{ repo: string; folder: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!status?.signedIn) return;
    let alive = true;
    configApi.githubRepos().then((r) => { if (alive) setRepos(r.repos); }).catch((e) => { if (alive) setListError(errText(e, 'Could not list repositories')); });
    return () => { alive = false; };
  }, [status?.signedIn]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (repos ?? []).filter((r) => !q || r.nameWithOwner.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
  }, [repos, filter]);

  const clone = async (repo: string) => {
    if (!repo.trim() || cloning) return;
    setCloning(repo); setError(null); setCloned(null);
    try { setCloned({ repo, folder: (await configApi.cloneRepo(repo.trim())).folder }); }
    catch (e) { setError(errText(e, 'Could not clone it')); }
    finally { setCloning(null); }
  };

  return (
    <div className="gh-panel">
      <GitHubCard />

      <div className="section-label">Clone a repository</div>
      <div className="gh-clone panel-card">
        <input className="text-input" value={typed} placeholder="owner/name or a github.com link" onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void clone(typed); }} aria-label="Repository" />
        <button type="button" className="btn btn--primary btn--sm" onClick={() => clone(typed)} disabled={!typed.trim() || !!cloning}>{cloning === typed ? 'Cloning…' : 'Clone'}</button>
      </div>
      {error && <div className="card__error" role="alert">{error}</div>}
      {cloned && <FolderReady folder={cloned.folder} />}

      {status?.signedIn && (
        <>
          <div className="section-label section-label--row">
            <span>Your repositories</span>
            <input className="text-input gh-filter" value={filter} placeholder="Filter" onChange={(e) => setFilter(e.target.value)} aria-label="Filter repositories" />
          </div>
          {listError ? <div className="card__error" role="alert">{listError}</div> : repos === null ? <div className="cfg-empty">Loading…</div> : (
            <div className="gh-repos panel-card">
              {shown.length === 0 ? <div className="gh-repos__empty">No repository matches.</div> : shown.map((r) => (
                <div key={r.nameWithOwner} className="gh-repo">
                  <span className="gh-repo__text">
                    <span className="gh-repo__name">{r.nameWithOwner}{r.isPrivate && <span className="proj-chip">private</span>}</span>
                    {r.description && <span className="gh-repo__desc">{r.description}</span>}
                  </span>
                  <span className="gh-repo__when">{relativeShort(Date.parse(r.updatedAt))}</span>
                  <button type="button" className="btn btn--secondary btn--sm" onClick={() => clone(r.nameWithOwner)} disabled={!!cloning}>{cloning === r.nameWithOwner ? 'Cloning…' : 'Clone'}</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
