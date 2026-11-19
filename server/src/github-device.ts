import { spawn as nodeSpawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/**
 * Signing the computer in to GitHub from the app itself (no terminal): runs `gh auth login --web` on the computer,
 * reads the one-time code it prints, and hands that code and github.com/login/device to the page. The person
 * approves on github.com; gh notices, saves its sign-in on the computer and exits; then `gh auth setup-git` lets git
 * use it. The token never leaves the computer and is never read by Bot HQ.
 */

export const DEVICE_URL = 'https://github.com/login/device';
const LIFETIME_MS = 15 * 60_000;

export type DeviceState =
  | { state: 'idle' }
  | { state: 'waiting'; code: string; url: string; startedAt: number }
  | { state: 'done'; account: string | null }
  | { state: 'error'; error: string };

/** The one-time code in gh's output ("First copy your one-time code: ABCD-1234"). */
export function parseDeviceCode(text: string): string | null {
  return /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(text)?.[1]?.toUpperCase() ?? null;
}

type Spawn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcess;

let current: { proc: ChildProcess; state: DeviceState; timer: NodeJS.Timeout } | null = null;
let last: DeviceState = { state: 'idle' };

export function deviceStatus(): DeviceState {
  return current ? current.state : last;
}

/** Starts the sign-in (or returns the one already waiting) and resolves with the code to show. */
export function startDeviceLogin(spawn: Spawn = nodeSpawn as unknown as Spawn, setupGit: () => Promise<void> = defaultSetupGit): Promise<{ code: string; url: string }> {
  if (current?.state.state === 'waiting') return Promise.resolve({ code: current.state.code, url: current.state.url });
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      // GH_BROWSER/BROWSER = `true`: gh "opens" a browser by running a no-op, since there is none on the computer.
      proc = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], {
        env: { ...process.env, GH_BROWSER: 'true', BROWSER: 'true', GH_PROMPT_DISABLED: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e: any) { reject(new Error(`Could not start GitHub sign-in: ${e?.message ?? e}`)); return; }

    let text = '';
    let settled = false;
    const finish = (s: DeviceState) => {
      if (current?.proc === proc) { clearTimeout(current.timer); current = null; }
      last = s;
    };
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } finish({ state: 'error', error: 'The sign-in code expired. Start again.' }); }, LIFETIME_MS);
    current = { proc, state: { state: 'idle' }, timer };

    const onData = (b: Buffer) => {
      text += b.toString();
      const code = !settled ? parseDeviceCode(text) : null;
      if (code && current?.proc === proc) {
        settled = true;
        current.state = { state: 'waiting', code, url: DEVICE_URL, startedAt: Date.now() };
        try { proc.stdin?.write('\n'); } catch { /* not waiting for Enter */ }
        resolve({ code, url: DEVICE_URL });
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', (e) => {
      const msg = /ENOENT/.test(String(e)) ? 'The GitHub command line (gh) is not installed on the computer.' : `GitHub sign-in failed: ${e.message}`;
      finish({ state: 'error', error: msg });
      if (!settled) { settled = true; reject(new Error(msg)); }
    });
    proc.on('exit', (code) => {
      if (code === 0) {
        const account = /Logged in as ([A-Za-z0-9-]+)/.exec(text)?.[1] ?? null;
        setupGit().catch(() => {}).finally(() => finish({ state: 'done', account }));
      } else {
        const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
        finish({ state: 'error', error: line ? `GitHub sign-in did not finish: ${line.slice(0, 160)}` : 'GitHub sign-in did not finish.' });
      }
      if (!settled) { settled = true; reject(new Error(text.trim().split('\n').pop()?.slice(0, 200) || 'GitHub sign-in stopped before it showed a code.')); }
    });
  });
}

/** Stops a sign-in that is waiting (the person closed it). */
export function cancelDeviceLogin(): void {
  if (!current) return;
  try { current.proc.kill(); } catch { /* gone */ }
  clearTimeout(current.timer);
  current = null;
  last = { state: 'idle' };
}

function defaultSetupGit(): Promise<void> {
  return new Promise((resolve) => execFile('gh', ['auth', 'setup-git'], { timeout: 15_000 }, () => resolve()));
}
