import { Hono, type Context } from 'hono';
import { requireUser, type AuthVars } from './lib/auth.js';
import { getBotRow } from './store.js';
import { cdpUrlFor, readyScreen } from './computer.js';
import { openTerminal } from './desk.js';
import { box } from './box.js';
import { ProjectError } from './projects.js';
import { resolveProjectFolder } from './code-workspace.js';
import { resolveShowPath, GITHUB_LOGIN_COMMAND, addWorktree, cloneRepo, createFolder, githubStatus, listRepos, openOrCloneRepo, terminalCommand } from './workspace.js';
import { cancelDeviceLogin, deviceStatus, startDeviceLogin } from './github-device.js';

/**
 * GnoesisWork's workspace: make a folder, clone from GitHub, add a worktree, see whether the computer is signed in to
 * GitHub (and sign it in), and open a terminal agent (OpenCode) or a shell in a folder on a bot's screen.
 */
export const workspaceApi = new Hono<AuthVars>();
workspaceApi.use('*', requireUser);

const body = async (c: Context<AuthVars>) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;

async function guard(c: Context<AuthVars>, fn: () => Promise<Response>): Promise<Response> {
  try { return await fn(); } catch (e) {
    if (e instanceof ProjectError) return c.json({ error: e.message }, e.status);
    throw e;
  }
}

/** The bot whose screen gets the terminal; it must belong to this person and be a bot, not a team channel. */
function ownBot(userId: string, id: unknown) {
  const b = typeof id === 'string' ? getBotRow(id) : null;
  if (!b || b.user_id !== userId || b.kind === 'team') throw new ProjectError('Bot not found.', 404);
  return b;
}

function needLocal() {
  if (!box.local) throw new ProjectError('This opens a terminal on the computer, which works once the app runs on that computer.', 409);
}

workspaceApi.get('/github', (c) => guard(c, async () => c.json(await githubStatus())));
workspaceApi.get('/github/repos', (c) => guard(c, async () => c.json({ repos: await listRepos() })));

/** Opens GitHub's sign-in (a code you confirm on github.com) in a terminal on the bot's screen. */
workspaceApi.post('/github/login', (c) => guard(c, async () => {
  needLocal();
  const b = ownBot(c.get('user').id, (await body(c)).botId);
  const s = await readyScreen(c.get('user').id, b.id);
  await openTerminal(s.screenId, GITHUB_LOGIN_COMMAND, 'Sign in to GitHub');
  return c.json({ ok: true });
}));

workspaceApi.post('/folder', (c) => guard(c, async () => c.json({ folder: createFolder((await body(c)).name) }, 201)));

/** Sign the computer in to GitHub from the app: returns the one-time code to confirm on github.com. */
workspaceApi.post('/github/device', (c) => guard(c, async () => {
  needLocal();
  try { return c.json(await startDeviceLogin()); }
  catch (e: any) { throw new ProjectError(String(e?.message ?? e).slice(0, 240), 409); }
}));
workspaceApi.get('/github/device', (c) => c.json(deviceStatus()));
workspaceApi.delete('/github/device', (c) => { cancelDeviceLogin(); return c.json({ ok: true }); });

/** A repository's folder: the existing checkout in Projects, or a fresh clone. */
workspaceApi.post('/github/open', (c) => guard(c, async () => c.json(await openOrCloneRepo((await body(c)).repo))));

workspaceApi.post('/clone', (c) => guard(c, async () => {
  const b = await body(c);
  return c.json({ folder: await cloneRepo(b.repo, b.name) }, 201);
}));

workspaceApi.post('/worktree', (c) => guard(c, async () => {
  const b = await body(c);
  return c.json({ folder: await addWorktree(b.folder, b.branch, b.base) }, 201);
}));

/** A terminal agent (OpenCode) or a shell, in the folder, on the bot's screen. */
workspaceApi.post('/terminal', (c) => guard(c, async () => {
  needLocal();
  const b = await body(c);
  const bot = ownBot(c.get('user').id, b.botId);
  const agent = b.agent === 'shell' ? 'shell' : 'opencode';
  const folder = resolveProjectFolder(typeof b.folder === 'string' ? b.folder : '');
  if (agent === 'opencode' && (await box.bash('command -v opencode >/dev/null 2>&1', 10)).exit_code !== 0) {
    throw new ProjectError('OpenCode is not installed on this computer. Install it on the Bot HQ server, then try again.', 409);
  }
  const s = await readyScreen(c.get('user').id, bot.id);
  await openTerminal(s.screenId, terminalCommand(folder, agent, box.quote), agent === 'opencode' ? `OpenCode: ${folder.split('/').pop()}` : `Terminal: ${folder.split('/').pop()}`);
  return c.json({ ok: true, folder });
}));

/**
 * Shows a file a bot linked to on that bot's own screen: a new tab in the bot's Chrome (file://), or, when that
 * Chrome does not answer, a pager in a terminal. The app then shows the screen (details panel or large view).
 */
workspaceApi.post('/show', (c) => guard(c, async () => {
  needLocal();
  const b = await body(c);
  const bot = ownBot(c.get('user').id, b.botId);
  const { real, isDir } = resolveShowPath(b.path, bot.id);
  const s = await readyScreen(c.get('user').id, bot.id);
  const url = 'file://' + real.split('/').map(encodeURIComponent).join('/');
  try {
    const r = await fetch(`${cdpUrlFor(bot.id, s.screenId)}/json/new?${url}`, { method: 'PUT', signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`chrome said ${r.status}`);
    const tab = (await r.json().catch(() => null)) as { id?: string } | null;
    if (tab?.id) await fetch(`${cdpUrlFor(bot.id, s.screenId)}/json/activate/${tab.id}`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
    return c.json({ ok: true, via: 'browser', path: real });
  } catch {
    const cmd = isDir ? `cd ${box.quote(real)} && ls -la && exec bash -l` : `less -R -- ${box.quote(real)}`;
    await openTerminal(s.screenId, cmd, real.split('/').pop() ?? 'File');
    return c.json({ ok: true, via: 'terminal', path: real });
  }
}));
