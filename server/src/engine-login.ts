import { spawn, type ChildProcess } from 'node:child_process';
import { env } from './env.js';

/**
 * Claude subscription sign-in without the bot's screen. Hermes' own command prints an authorization
 * link and then waits for the code that page shows; we run it with pipes, hand the link to the web
 * app, and feed the code back in. Nothing here sees a token: Hermes exchanges the code and keeps
 * the credential in the agent's home.
 */

interface Pending { child: ChildProcess; out: () => string; done: Promise<number | null>; timer: NodeJS.Timeout }

const pending = new Map<string, Pending>();
const LINK = /https:\/\/claude\.ai\/oauth\/authorize\?[^\s]+/;
const WAIT_FOR_CODE_MS = 10 * 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The last thing Hermes said (its reason, when it gives up), without its prompt or the link. */
const tail = (text: string) => (text.replace(LINK, '').split(/\r?\n/).map((l) => l.replace(/^\s*Authorization code:\s*/, '').trim()).filter(Boolean).pop() ?? '').slice(-300);

export function cancelClaudeLogin(botId: string): void {
  const p = pending.get(botId);
  if (!p) return;
  pending.delete(botId);
  clearTimeout(p.timer);
  try { p.child.kill('SIGTERM'); } catch { /* already gone */ }
}

/** Start Hermes' Claude sign-in for the agent whose home is `home`. Returns the link to open. */
export async function startClaudeLogin(botId: string, home: string): Promise<string> {
  cancelClaudeLogin(botId);
  let text = '';
  const child = spawn(env.hermesBin, ['auth', 'add', 'anthropic', '--type', 'oauth', '--no-browser'], {
    cwd: home,
    stdio: ['pipe', 'pipe', 'pipe'],
    // No DISPLAY: Hermes must not open a browser on the computer; the person opens the link themself.
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? '/root',
      USER: process.env.USER ?? 'root',
      LANG: process.env.LANG ?? 'C.UTF-8',
      HERMES_HOME: home,
      PYTHONUNBUFFERED: '1', // or the link sits in a buffer while Hermes waits for the code
    },
  });
  child.stdout?.on('data', (d: Buffer) => { text = (text + d.toString('utf8')).slice(-8000); });
  child.stderr?.on('data', (d: Buffer) => { text = (text + d.toString('utf8')).slice(-8000); });
  const done = new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(-1));
  });
  let exited = false;
  void done.then(() => { exited = true; });

  for (let i = 0; i < 100 && !exited && !LINK.test(text); i++) await sleep(200);
  const link = text.match(LINK)?.[0];
  if (!link) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    throw new Error(tail(text) || 'Hermes did not offer a sign-in link.');
  }
  const timer = setTimeout(() => cancelClaudeLogin(botId), WAIT_FOR_CODE_MS);
  pending.set(botId, { child, out: () => text, done, timer });
  void done.then(() => { if (pending.get(botId)?.child === child) { clearTimeout(timer); pending.delete(botId); } });
  return link;
}

/** Give Hermes the code from Claude's page and wait for it to finish the sign-in. */
export async function finishClaudeLogin(botId: string, code: string): Promise<void> {
  const p = pending.get(botId);
  if (!p) throw new Error('That sign-in has expired. Start it again.');
  const clean = code.trim();
  if (!clean || clean.length > 2000 || /\s/.test(clean)) throw new Error('That does not look like the code from Claude.');
  pending.delete(botId);
  clearTimeout(p.timer);
  p.child.stdin?.end(`${clean}\n`);
  const exit = await Promise.race([p.done, sleep(45_000).then(() => 'timeout' as const)]);
  if (exit === 'timeout') {
    try { p.child.kill('SIGTERM'); } catch { /* already gone */ }
    throw new Error('Hermes did not finish the sign-in in time.');
  }
  if (exit !== 0) throw new Error(tail(p.out()) || 'Claude did not accept the code.');
}
