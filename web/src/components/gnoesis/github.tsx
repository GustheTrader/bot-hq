import { useCallback, useEffect, useState } from 'react';
import type { Bot } from '@shared/types';
import { api, openPopup } from '../../lib/api';
import { configApi } from '../../lib/configApi';
import { useStore } from '../../store';
import { GitHubConnect } from './GitHubConnect';

/** The bot GnoesisWork works through (its own computer), else the primary bot, else any bot. */
export function workBot(bots: Bot[]): Bot | undefined {
  const agents = bots.filter((b) => b.kind !== 'team');
  return agents.find((b) => b.name.trim().toLowerCase() === 'gnoesiswork') ?? agents.find((b) => b.isPrimary) ?? agents[0];
}

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** Shows that bot's screen, where a terminal was just opened. */
export function showScreen(botId: string) {
  useStore.getState().selectBot(botId);
  useStore.setState({ viewerOpen: true });
}

/** Opens OpenCode (or a shell) in `folder` on GnoesisWork's computer and shows that screen. */
export async function openTerminalAgent(folder: string, agent: 'opencode' | 'shell' = 'opencode'): Promise<void> {
  const bot = workBot(useStore.getState().bots);
  if (!bot) throw new Error('Create a bot first.');
  await configApi.openTerminal(bot.id, folder, agent);
  showScreen(bot.id);
}

type Status = { installed: boolean; signedIn: boolean; account: string | null } | null;

export function useGithubStatus() {
  const [status, setStatus] = useState<Status>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    setError(null);
    configApi.githubStatus().then(setStatus).catch((e) => setError(errText(e, 'Could not check GitHub')));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { status, error, refresh };
}

/**
 * GitHub on the computer: whether git there is signed in (for cloning and pushing), with a button that opens
 * GitHub's sign-in in a terminal on GnoesisWork's screen. Also whether the bots' GitHub app (Composio) is connected.
 */
export function GitHubCard({ compact = false }: { compact?: boolean }) {
  const bots = useStore((s) => s.bots);
  const { status, error, refresh } = useGithubStatus();
  const [appConnected, setAppConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<'login' | 'app' | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const loadApp = useCallback(() => {
    configApi.connectedApps().then((r) => setAppConnected(r.connected.includes('github'))).catch(() => setAppConnected(null));
  }, []);
  useEffect(() => { loadApp(); }, [loadApp]);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => { if ((e.data as { type?: string })?.type === 'grokbot-connected') loadApp(); };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [loadApp]);

  const signIn = async () => {
    const bot = workBot(bots);
    if (!bot) { setNote('Create a bot first.'); return; }
    setBusy('login'); setNote(null);
    try {
      await configApi.githubLogin(bot.id);
      setNote(`GitHub's sign-in is open on ${bot.name}'s screen: copy the code it shows, confirm it on github.com, then press Check again.`);
      showScreen(bot.id);
    } catch (e) { setNote(errText(e, 'Could not open the sign-in')); }
    finally { setBusy(null); }
  };

  const connectApp = async () => {
    setBusy('app'); setNote(null);
    const popup = openPopup('about:blank');
    try {
      const { redirectUrl } = await api.connect('github');
      if (popup) popup.location.href = redirectUrl; else window.open(redirectUrl, '_blank');
    } catch (e) { popup?.close(); setNote(errText(e, 'Could not start the GitHub connection')); }
    finally { setBusy(null); }
  };

  return (
    <div className={`gh-card panel-card${compact ? ' gh-card--compact' : ''}`}>
      <div className="gh-card__row">
        <span className="gh-card__mark" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z" /></svg>
        </span>
        <span className="gh-card__text">
          <span className="gh-card__title">Git on the computer</span>
          <span className="gh-card__sub">
            {error ? error : !status ? 'Checking…' : !status.installed ? 'The GitHub command line (gh) is not installed there.' : status.signedIn ? `Signed in as ${status.account}. Cloning and pushing use this.` : 'Not signed in. Needed to clone private repositories and push.'}
          </span>
        </span>
        <span className="gh-card__actions">
          <button type="button" className="btn btn--secondary btn--sm" onClick={refresh}>Check again</button>
          {status?.installed && status.signedIn && (
            <button type="button" className="btn btn--secondary btn--sm" onClick={signIn} disabled={busy === 'login'} title="Opens GitHub's sign-in in a terminal on GnoesisWork's screen">{busy === 'login' ? 'Opening…' : 'Sign in again'}</button>
          )}
        </span>
      </div>
      {status?.installed && !status.signedIn && (
        <div className="gh-card__connect"><GitHubConnect onDone={refresh} label="Sign in to GitHub" /></div>
      )}
      <div className="gh-card__divider" aria-hidden>
      </div>
      <div className="gh-card__row">
        <span className="gh-card__mark gh-card__mark--app" aria-hidden>⇄</span>
        <span className="gh-card__text">
          <span className="gh-card__title">GitHub app for bots</span>
          <span className="gh-card__sub">{appConnected === null ? 'Checking…' : appConnected ? 'Connected. Bots can read issues and pull requests and react to GitHub events.' : 'Lets bots work with issues, pull requests and GitHub events (via Connections).'}</span>
        </span>
        <span className="gh-card__actions">
          {appConnected ? <span className="gh-card__ok">Connected</span> : <button type="button" className="btn btn--secondary btn--sm" onClick={connectApp} disabled={busy === 'app'}>{busy === 'app' ? 'Opening…' : 'Connect'}</button>}
        </span>
      </div>
      {note && <div className="gh-card__note" role="status">{note}</div>}
    </div>
  );
}
