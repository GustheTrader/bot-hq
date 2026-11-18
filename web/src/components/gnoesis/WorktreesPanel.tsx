import { useEffect, useState } from 'react';
import type { Project } from '@shared/types';
import { configApi, type Worktree } from '../../lib/configApi';
import { errText, t3Url } from '../work/shared';
import { GwIcon } from './GnoesisWork';

type Trees = { state: 'loading' } | { state: 'ok'; folder: string; repo: boolean; worktrees: Worktree[] } | { state: 'error'; error: string };

function ProjectTrees({ project }: { project: Project }) {
  const [trees, setTrees] = useState<Trees>({ state: 'loading' });
  const [opening, setOpening] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const code = t3Url();

  useEffect(() => {
    let alive = true;
    configApi.projectWorktrees(project.id)
      .then((r) => { if (alive) setTrees({ state: 'ok', ...r }); })
      .catch((e) => { if (alive) setTrees({ state: 'error', error: errText(e, 'Could not read the worktrees') }); });
    return () => { alive = false; };
  }, [project.id]);

  const openInCode = async () => {
    setOpening(true); setNote(null);
    try {
      const r = await configApi.openProjectInCode(project.id);
      setNote(r.already ? 'Already in Code.' : 'Added to Code.');
      if (code) window.open(code, '_blank', 'noopener');
    } catch (e) { setNote(errText(e, 'Could not open it in Code')); }
    finally { setOpening(false); }
  };

  return (
    <section className="gw-trees panel-card">
      <header className="gw-trees__head">
        <span className="gw-trees__name">{project.name}</span>
        <span className="gw-trees__folder">{project.folder}</span>
        <button type="button" className="btn btn--secondary btn--sm" onClick={openInCode} disabled={opening}>{opening ? 'Opening…' : 'Open in Code'}</button>
      </header>
      {note && <div className="gw-trees__note" role="status">{note}</div>}
      {trees.state === 'loading' ? <div className="gw-trees__empty">Reading worktrees…</div>
        : trees.state === 'error' ? <div className="gw-trees__empty" role="alert">{trees.error}</div>
        : !trees.repo ? <div className="gw-trees__empty">This folder is not a git repository.</div>
        : (
          <ul className="gw-trees__list">
            {trees.worktrees.map((w) => (
              <li key={w.path} className="gw-tree">
                <GwIcon name="branch" size={14} />
                <span className="gw-tree__branch">{w.branch ?? (w.detached ? `detached at ${w.head.slice(0, 7)}` : w.bare ? 'bare' : '—')}</span>
                {w.main && <span className="proj-chip">main</span>}
                <span className="gw-tree__path" title={w.path}>{w.path}</span>
                <span className="gw-tree__head">{w.head.slice(0, 7)}</span>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

/** GnoesisWork → Worktrees: the git worktrees in every project's folder, read-only, with a way into Code. */
export function WorktreesPanel() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    configApi.projects().then((r) => { if (alive) setProjects(r.projects); }).catch((e) => { if (alive) setError(errText(e, 'Could not load projects')); });
    return () => { alive = false; };
  }, []);

  if (error) return <div className="card__error" role="alert">{error}</div>;
  if (!projects) return <div className="cfg-empty">Loading…</div>;
  const withFolder = projects.filter((p) => p.folder.trim());
  return (
    <div className="gw-trees-wrap">
      <p className="gw-lede">Branches checked out side by side in each project&rsquo;s folder (git worktrees). Bots can work in one while you work in another.</p>
      {withFolder.length === 0 ? (
        <div className="gw-trees__empty panel-card">No project has a folder yet. Give one a folder in Projects and its worktrees show here.</div>
      ) : withFolder.map((p) => <ProjectTrees key={p.id} project={p} />)}
    </div>
  );
}
