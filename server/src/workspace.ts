import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ProjectError } from './projects.js';
import { codeRoots, resolveProjectFolder, type Runner } from './code-workspace.js';

/**
 * Where GnoesisWork's work happens on the computer: a new empty folder, a GitHub repository cloned for it, or a new
 * git worktree beside an existing checkout. Everything lands inside the workspace roots (CODE_ROOTS), names are
 * checked before they touch the disk, and git/gh run with argument lists, never through a shell.
 */

const run0: Runner = execFile as unknown as Runner;

/** New folders and clones go here (`WORKSPACE_PROJECTS_DIR`, default /home/workspace/Projects). */
export const projectsDir = () => process.env.WORKSPACE_PROJECTS_DIR ?? '/home/workspace/Projects';

const within = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

function insideRoots(p: string, roots = codeRoots()): boolean {
  return roots.some((r) => { try { return within(p, fs.realpathSync(r)); } catch { return false; } });
}

/** A folder name a person typed: letters, digits, space, dot, dash, underscore; no path parts. */
export function checkName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(name) || name.endsWith('.') || name.includes('..')) {
    throw new ProjectError('Use a short folder name: letters, numbers, spaces, dots, dashes or underscores.');
  }
  return name;
}

/** The projects folder, resolved, and checked to be inside the workspace. */
function root(): string {
  let real: string;
  try { real = fs.realpathSync(projectsDir()); } catch { throw new ProjectError('The projects folder does not exist on the server.', 409); }
  if (!insideRoots(real)) throw new ProjectError('The projects folder is outside the workspace Bot HQ may use.', 409);
  return real;
}

/** Makes a new, empty folder for work. An existing folder is an error, so nobody's files get mixed in. */
export function createFolder(rawName: unknown): string {
  const target = path.join(root(), checkName(rawName));
  try { fs.mkdirSync(target); } catch (e: any) {
    if (e?.code === 'EEXIST') throw new ProjectError('A folder with that name already exists. Pick it with "A folder…" instead.', 409);
    throw new ProjectError('Could not make the folder.', 409);
  }
  return target;
}

/** "owner/name", a github.com web address or an SSH address, as owner and name. */
export function parseRepo(raw: unknown): { owner: string; name: string } {
  const s = (typeof raw === 'string' ? raw : '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(s);
  if (!m || m[2] === '.' || m[2] === '..') throw new ProjectError('Give the repository as owner/name, like octocat/hello-world.');
  return { owner: m[1], name: m[2] };
}

const firstLine = (text: string) => text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';

function runP(run: Runner, file: string, args: string[], timeout: number): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => run(file, args, { timeout }, (e, out, err) => resolve({ ok: !e, out: out ?? '', err: `${err ?? ''}${e && !err ? e.message : ''}` })));
}

/** Clones a GitHub repository into the projects folder with the computer's GitHub sign-in (gh). */
export async function cloneRepo(rawRepo: unknown, rawName?: unknown, run: Runner = run0): Promise<string> {
  const repo = parseRepo(rawRepo);
  const name = rawName === undefined || rawName === '' ? checkName(repo.name) : checkName(rawName);
  const target = path.join(root(), name);
  if (fs.existsSync(target)) throw new ProjectError('A folder with that name already exists. Give the clone another name.', 409);
  const r = await runP(run, 'gh', ['repo', 'clone', `${repo.owner}/${repo.name}`, target], 10 * 60_000);
  if (!r.ok) {
    const why = firstLine(r.err) || 'unknown error';
    if (/auth|login|credential|403|404|could not read/i.test(why)) throw new ProjectError(`GitHub would not give us that repository (${why.slice(0, 160)}). Check the name, or sign in to GitHub on the computer.`, 409);
    throw new ProjectError(`Could not clone it: ${why.slice(0, 200)}`, 409);
  }
  return target;
}

/** Does this checkout's origin point at github.com/owner/name? */
export function originMatches(url: string, repo: { owner: string; name: string }): boolean {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return !!m && m[1].toLowerCase() === repo.owner.toLowerCase() && m[2].toLowerCase() === repo.name.toLowerCase();
}

/**
 * The repository's folder in Projects: the existing checkout when it is already there (same origin), else a fresh
 * clone. A folder of that name holding something else is an error, never overwritten.
 */
export async function openOrCloneRepo(rawRepo: unknown, run: Runner = run0): Promise<{ folder: string; existing: boolean }> {
  const repo = parseRepo(rawRepo);
  const target = path.join(root(), checkName(repo.name));
  if (fs.existsSync(target)) {
    const r = await runP(run, 'git', ['-C', target, 'remote', 'get-url', 'origin'], 10_000);
    if (r.ok && originMatches(r.out, repo)) return { folder: target, existing: true };
    throw new ProjectError(`Projects/${path.basename(target)} already exists and is not a checkout of ${repo.owner}/${repo.name}. Clone it under another name from the GitHub page.`, 409);
  }
  return { folder: await cloneRepo(`${repo.owner}/${repo.name}`, undefined, run), existing: false };
}

/** A branch name git accepts, kept conservative (no spaces, no "..", no leading dash, no trailing slash or ".lock"). */
export function checkBranch(raw: unknown): string {
  const b = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(b) || b.includes('..') || b.includes('//') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock')) {
    throw new ProjectError('Use a branch name like feature/login: letters, numbers, dots, dashes, underscores and slashes.');
  }
  return b;
}

/**
 * Adds a git worktree for `branch` beside the checkout in `folder` (as `<folder>-<branch>`): a new branch from
 * `base` (or the current HEAD), or the existing branch when it already exists.
 */
export async function addWorktree(rawFolder: unknown, rawBranch: unknown, rawBase?: unknown, run: Runner = run0): Promise<string> {
  const folder = resolveProjectFolder(typeof rawFolder === 'string' ? rawFolder : '');
  const branch = checkBranch(rawBranch);
  const base = rawBase === undefined || rawBase === '' ? null : checkBranch(rawBase);
  const target = `${folder}-${branch.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
  if (!insideRoots(path.dirname(target))) throw new ProjectError('The new worktree would be outside the workspace.');
  if (fs.existsSync(target)) throw new ProjectError(`${path.basename(target)} already exists next to this folder.`, 409);
  const fresh = await runP(run, 'git', ['-C', folder, 'worktree', 'add', '-b', branch, target, ...(base ? [base] : [])], 120_000);
  if (fresh.ok) return target;
  if (/already exists/i.test(fresh.err) && !fs.existsSync(target)) {
    const existing = await runP(run, 'git', ['-C', folder, 'worktree', 'add', target, branch], 120_000);
    if (existing.ok) return target;
    throw new ProjectError(`Could not add the worktree: ${firstLine(existing.err).slice(0, 200)}`, 409);
  }
  if (/not a git repository/i.test(fresh.err)) throw new ProjectError('That folder is not a git repository, so it cannot have worktrees.', 409);
  throw new ProjectError(`Could not add the worktree: ${firstLine(fresh.err).slice(0, 200)}`, 409);
}

/** Whether the computer's GitHub command line (gh) is signed in, and as whom. Never returns the token. */
export async function githubStatus(run: Runner = run0): Promise<{ installed: boolean; signedIn: boolean; account: string | null }> {
  const r = await runP(run, 'gh', ['auth', 'status', '--hostname', 'github.com'], 15_000);
  const text = `${r.out}\n${r.err}`;
  if (/ENOENT|not found/i.test(r.err) && !/github\.com/.test(text)) return { installed: false, signedIn: false, account: null };
  const account = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/.exec(text)?.[1] ?? null;
  return { installed: true, signedIn: r.ok && !!account, account };
}

export interface RepoInfo { nameWithOwner: string; description: string; isPrivate: boolean; updatedAt: string }

/** The signed-in account's repositories, newest first (up to 100). */
export async function listRepos(run: Runner = run0): Promise<RepoInfo[]> {
  const r = await runP(run, 'gh', ['repo', 'list', '--limit', '100', '--json', 'nameWithOwner,description,isPrivate,updatedAt'], 30_000);
  if (!r.ok) throw new ProjectError(`Could not list repositories: ${firstLine(r.err).slice(0, 200) || 'is GitHub signed in on the computer?'}`, 409);
  try {
    const list = JSON.parse(r.out) as RepoInfo[];
    return list.map((x) => ({ nameWithOwner: x.nameWithOwner, description: x.description ?? '', isPrivate: !!x.isPrivate, updatedAt: x.updatedAt })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch { return []; }
}

/** The command a terminal on the computer runs: OpenCode (a terminal agent) or a plain shell, in the folder. */
export function terminalCommand(realFolder: string, agent: 'opencode' | 'shell', quote: (s: string) => string): string {
  return agent === 'opencode' ? `cd ${quote(realFolder)} && opencode` : `cd ${quote(realFolder)} && exec bash -l`;
}

/** The command that signs the computer in to GitHub in a terminal (browser code flow) and lets git use it. */
export const GITHUB_LOGIN_COMMAND = 'gh auth login --hostname github.com --git-protocol https --web && gh auth setup-git && echo && echo "Signed in to GitHub. You can close this window."';

/**
 * A file or folder a bot linked to in its reply (an absolute path on the computer), checked before it is shown:
 * it must exist and be inside the workspace roots or that bot's own Library. Returns its real path.
 */
export function resolveShowPath(raw: unknown, botId: string, libRoot = '/root/grokbot/files'): { real: string; isDir: boolean } {
  let p = typeof raw === 'string' ? raw.trim() : '';
  if (p.startsWith('file://')) { try { p = decodeURIComponent(new URL(p).pathname); } catch { p = ''; } }
  if (!p || !path.isAbsolute(p) || p.includes('\0') || p.includes('\n') || p.includes('\r')) throw new ProjectError('That is not a file on the computer.');
  let real: string;
  try { real = fs.realpathSync(p); } catch { throw new ProjectError('That file is not on the computer (it may have moved).', 404); }
  const lib = (() => { try { return fs.realpathSync(path.join(libRoot, botId)); } catch { return null; } })();
  if (!insideRoots(real) && !(lib && within(real, lib))) throw new ProjectError('That file is outside the folders Bot HQ may show.', 409);
  return { real, isDir: fs.statSync(real).isDirectory() };
}
