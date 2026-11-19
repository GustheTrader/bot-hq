import { useCallback, useEffect, useState } from 'react';
import { configApi } from '../../lib/configApi';
import { GitHubConnect } from './GitHubConnect';
import { useGithubStatus } from './github';

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
type Repo = { nameWithOwner: string; isPrivate: boolean };

/**
 * The composer's GitHub field: once the computer is signed in to GitHub, a dropdown of your repositories (picking one
 * uses its checkout in Projects, cloning it the first time); before that, a button to connect GitHub right here.
 */
export function GitHubRepoField({ onReady }: { onReady: (folder: string) => void }) {
  const { status, refresh } = useGithubStatus();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const loadRepos = useCallback(() => {
    configApi.githubRepos().then((r) => setRepos(r.repos)).catch((e) => { setRepos([]); setNote(errText(e, 'Could not list your repositories')); });
  }, []);
  useEffect(() => { if (status?.signedIn) loadRepos(); }, [status?.signedIn, loadRepos]);

  const pick = async (repo: string) => {
    setValue(repo);
    if (!repo) return;
    setBusy(true); setNote(null);
    try {
      const r = await configApi.openRepo(repo);
      setNote(r.existing ? 'Using its folder in Projects.' : 'Cloned into Projects.');
      onReady(r.folder);
    } catch (e) { setNote(errText(e, 'Could not open that repository')); setValue(''); }
    finally { setBusy(false); }
  };

  return (
    <div className="proj-field gh-field">
      <span className="proj-field__label">GitHub repo</span>
      {!status ? (
        <span className="proj-hint">Checking GitHub…</span>
      ) : !status.installed ? (
        <span className="proj-hint">GitHub isn’t set up on the computer.</span>
      ) : status.signedIn ? (
        <select className="text-input" value={value} onChange={(e) => void pick(e.target.value)} disabled={busy || repos === null} aria-label="GitHub repository" title={status.account ? `Signed in as ${status.account}` : undefined}>
          <option value="">{repos === null ? 'Loading repositories…' : busy ? 'Opening…' : `Pick a repo (${status.account ?? 'GitHub'})`}</option>
          {(repos ?? []).map((r) => <option key={r.nameWithOwner} value={r.nameWithOwner}>{r.nameWithOwner}{r.isPrivate ? ' · private' : ''}</option>)}
        </select>
      ) : (
        <GitHubConnect onDone={() => { refresh(); }} />
      )}
      {note && <span className="gh-field__note" role="status">{note}</span>}
    </div>
  );
}
