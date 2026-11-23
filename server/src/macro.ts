import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { env } from './env.js';

/**
 * Macro (macro.com) for every bot, through Macro's own MCP server (MACRO_MCP_URL).
 *
 * Macro's MCP server signs in with OAuth (browser + PKCE, loopback redirect; no device flow). One sign-in is kept
 * in a small Hermes home of its own (MACRO_AUTH_HOME); each bot's `mcp-tokens/` folder is a link to that home's,
 * so every bot uses the same Macro login and a token refresh by any bot is seen by all. Hermes writes token files
 * atomically (temp file + rename), which is why the whole folder is linked rather than the files.
 *
 * Signing in from Bot HQ: Hermes prints Macro's authorization link; the person opens it in their own browser,
 * approves, and the browser lands on http://127.0.0.1:<port>/callback?code=… on their machine, which cannot be
 * reached. They paste that address back and we feed it to Hermes on stdin (Hermes accepts a pasted redirect).
 */

export const MACRO_SERVER = 'macro';
const LOGIN_TIMEOUT_S = 1800;
const AUTH_LINK = /https:\/\/\S+\/authorize\?\S+/;

export const macroEnabled = () => !!env.macroMcpUrl;

/** The `mcp_servers.macro` entry for a bot's Hermes config. */
export function macroServerConfig(url = env.macroMcpUrl) {
  return { url, auth: 'oauth', oauth: { timeout: LOGIN_TIMEOUT_S } };
}

const tokenDir = (home = env.macroAuthHome) => path.join(home, 'mcp-tokens');

function writeAuthHome() {
  fs.mkdirSync(tokenDir(), { recursive: true, mode: 0o700 });
  fs.chmodSync(env.macroAuthHome, 0o700);
  const cfg = `mcp_servers:\n  ${MACRO_SERVER}:\n    url: ${JSON.stringify(env.macroMcpUrl)}\n    auth: oauth\n    oauth:\n      timeout: ${LOGIN_TIMEOUT_S}\n`;
  fs.writeFileSync(path.join(env.macroAuthHome, 'config.yaml'), cfg, { mode: 0o600 });
}

/**
 * Points a bot's `mcp-tokens/` at the shared Macro sign-in. Leaves a real folder that already holds files alone
 * (another OAuth server's tokens), so nothing of the bot's own is ever removed. Returns whether it is linked.
 */
export function linkMacroTokens(botHome: string): boolean {
  if (!macroEnabled()) return false;
  fs.mkdirSync(tokenDir(), { recursive: true, mode: 0o700 });
  const mine = tokenDir(botHome);
  try {
    const st = fs.lstatSync(mine);
    if (st.isSymbolicLink()) {
      if (path.resolve(path.dirname(mine), fs.readlinkSync(mine)) === path.resolve(tokenDir())) return true;
      fs.unlinkSync(mine);
    } else if (st.isDirectory()) {
      if (fs.readdirSync(mine).length) return false;
      fs.rmdirSync(mine);
    } else return false;
  } catch { /* not there yet */ }
  fs.symlinkSync(tokenDir(), mine, 'dir');
  return true;
}

export interface MacroStatus { enabled: boolean; signedIn: boolean; expiresAt: number | null; signingIn: boolean }

export function macroStatus(): MacroStatus {
  let signedIn = false;
  let expiresAt: number | null = null;
  try {
    const t = JSON.parse(fs.readFileSync(path.join(tokenDir(), `${MACRO_SERVER}.json`), 'utf8'));
    signedIn = !!(t.refresh_token || t.access_token);
    const exp = Number(t.expires_at ?? 0);
    expiresAt = exp > 0 ? (exp < 1e12 ? exp * 1000 : exp) : null;
  } catch { /* no sign-in yet */ }
  return { enabled: macroEnabled(), signedIn, expiresAt, signingIn: !!login };
}

// ---------- sign-in ----------

let login: { child: ChildProcess; out: () => string; done: Promise<number | null> } | null = null;

export function cancelMacroLogin() {
  if (!login) return;
  try { login.child.kill('SIGTERM'); } catch { /* gone */ }
  login = null;
}

/** Starts Hermes' Macro sign-in and returns the link to open. */
export async function startMacroLogin(): Promise<string> {
  if (!macroEnabled()) throw new Error('Macro is not set up on this server (MACRO_MCP_URL).');
  cancelMacroLogin();
  writeAuthHome();
  let text = '';
  const child = spawn(env.hermesBin, ['mcp', 'login', MACRO_SERVER, '--flow', 'browser'], {
    cwd: env.macroAuthHome,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HERMES_HOME: env.macroAuthHome, BROWSER: '/bin/true' },
  });
  child.stdout?.on('data', (d: Buffer) => { text = (text + d.toString('utf8')).slice(-16000); });
  child.stderr?.on('data', (d: Buffer) => { text = (text + d.toString('utf8')).slice(-16000); });
  const done = new Promise<number | null>((resolve) => { child.on('close', resolve); child.on('error', () => resolve(-1)); });
  const mine = { child, out: () => text, done };
  login = mine;
  done.then(() => { if (login === mine) login = null; });
  const timer = setTimeout(() => { if (login === mine) cancelMacroLogin(); }, (LOGIN_TIMEOUT_S + 60) * 1000);
  done.then(() => clearTimeout(timer));

  // Hermes may first prepare its runtime; wait for the link (up to two minutes).
  for (let i = 0; i < 240; i++) {
    const m = AUTH_LINK.exec(text);
    if (m) return m[0];
    if (login !== mine) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  cancelMacroLogin();
  throw new Error('Macro did not give a sign-in link. Try again.');
}

/** Checks a pasted address is a loopback OAuth callback carrying a code (or an error) and a state. */
export function parseCallback(pasted: string): string | null {
  const s = String(pasted ?? '').trim();
  let u: URL;
  try { u = new URL(s.startsWith('?') ? `http://127.0.0.1/callback${s}` : s); } catch { return null; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return null;
  if (!u.searchParams.get('state') || !(u.searchParams.get('code') || u.searchParams.get('error'))) return null;
  return `?${u.searchParams.toString()}`;
}

/** Feeds the pasted redirect to the waiting sign-in and waits for Hermes to finish. */
export async function finishMacroLogin(pasted: string): Promise<MacroStatus> {
  const query = parseCallback(pasted);
  if (!query) throw new Error('Paste the whole address your browser landed on (it starts with http://127.0.0.1:…/callback?code=).');
  const l = login;
  if (!l) throw new Error('No Macro sign-in is waiting. Start again.');
  l.child.stdin?.write(`${query}\n`);
  const code = await Promise.race([l.done, new Promise<'slow'>((r) => setTimeout(() => r('slow'), 60_000))]);
  const st = macroStatus();
  if (st.signedIn) return st;
  if (code === 'slow') throw new Error('Macro is taking a while to finish. Check again in a minute.');
  const why = l.out().split(/\r?\n/).map((x) => x.trim()).filter((x) => /fail|error|denied|invalid/i.test(x)).pop();
  throw new Error(why ? why.replace(/^✗\s*/, '').slice(0, 300) : 'Macro sign-in did not finish. Start again.');
}
