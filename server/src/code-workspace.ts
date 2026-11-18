import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ProjectError } from './projects.js';

/**
 * "Open in Code": register a project's folder with the T3 Code server on this computer (`t3 project add`),
 * so the Code workspace lists it and has a terminal there.
 *
 * A project's folder is free text a person typed, so before it goes anywhere it is turned into a real directory
 * and checked to be inside the allowed workspace (symlinks and `..` included). T3 is run with an argument list,
 * never through a shell, and by its full path: the plain `t3` on this machine's PATH is a helper for another
 * computer and must not be used.
 */

/** Folders Bot HQ may open in Code. `CODE_ROOTS` (colon separated) overrides the default. */
export const codeRoots = (): string[] => (process.env.CODE_ROOTS ?? '/home/workspace').split(':').filter(Boolean);

const within = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

/** The real directory behind a project's folder text, but only if it exists and is inside an allowed root. */
export function resolveProjectFolder(folder: string, roots: string[] = codeRoots()): string {
  const f = folder.trim();
  if (!f) throw new ProjectError('This project has no folder yet. Add one in its settings.');
  if (!path.isAbsolute(f)) throw new ProjectError('The folder must be a full path, like /home/workspace/Projects/pricing.');
  let real: string;
  try { real = fs.realpathSync(f); } catch { throw new ProjectError('That folder does not exist on the server.', 404); }
  if (!fs.statSync(real).isDirectory()) throw new ProjectError('That path is not a folder.');
  const allowed = roots.some((r) => {
    try { return within(real, fs.realpathSync(r)); } catch { return false; }
  });
  if (!allowed) throw new ProjectError('That folder is outside the workspace Bot HQ is allowed to open.');
  return real;
}

const versionParts = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
const byVersion = (a: string, b: string) => {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** The newest installed T3 binary (`T3_BIN` overrides), or null when there is none. */
export function findT3Bin(versionsDir = '/root/.t3/runtime/versions'): string | null {
  if (process.env.T3_BIN) return process.env.T3_BIN;
  try {
    const dirs = fs.readdirSync(versionsDir).filter((d) => /^\d+\.\d+\.\d+/.test(d) && fs.existsSync(path.join(versionsDir, d, 't3'))).sort(byVersion);
    return dirs.length ? path.join(versionsDir, dirs[dirs.length - 1], 't3') : null;
  } catch { return null; }
}

export type Runner = (file: string, args: string[], opts: { timeout: number }, cb: (err: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => void) => unknown;

/** One git worktree of a project's folder (`git worktree list --porcelain`). */
export interface Worktree { path: string; branch: string | null; head: string; detached: boolean; bare: boolean; main: boolean }

/** Parses `git worktree list --porcelain`. The first entry is the main worktree. */
export function parseWorktrees(out: string): Worktree[] {
  const list: Worktree[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const p = lines.find((l) => l.startsWith('worktree '));
    if (!p) continue;
    const head = lines.find((l) => l.startsWith('HEAD '))?.slice(5) ?? '';
    const br = lines.find((l) => l.startsWith('branch '))?.slice(7) ?? null;
    list.push({
      path: p.slice(9),
      branch: br ? br.replace(/^refs\/heads\//, '') : null,
      head: head.slice(0, 12),
      detached: lines.includes('detached'),
      bare: lines.includes('bare'),
      main: list.length === 0,
    });
  }
  return list;
}

/**
 * The git worktrees of a project's (already resolved) folder. Read-only: runs `git worktree list` with an argument
 * list, never a shell. A folder that is not a git repository gives `repo: false` instead of an error.
 */
export function listWorktrees(realFolder: string, run: Runner = execFile as unknown as Runner): Promise<{ repo: boolean; worktrees: Worktree[] }> {
  return new Promise((resolve, reject) => {
    run('git', ['-C', realFolder, 'worktree', 'list', '--porcelain'], { timeout: 8_000 }, (err, stdout, stderr) => {
      if (!err) return resolve({ repo: true, worktrees: parseWorktrees(stdout ?? '') });
      const text = `${stderr ?? ''}`.trim();
      if (/not a git repository/i.test(text)) return resolve({ repo: false, worktrees: [] });
      const first = text.split('\n').find((l) => l.trim());
      reject(new ProjectError(`Could not read the worktrees: ${(first ?? err.message).slice(0, 200)}`, 409));
    });
  });
}

/** Adds a folder to T3 as a project. A folder T3 already has counts as success. */
export function addToCode(realFolder: string, title: string, bin: string | null = findT3Bin(), run: Runner = execFile as unknown as Runner): Promise<{ already: boolean }> {
  if (!bin) return Promise.reject(new ProjectError('The Code workspace (T3) is not installed on the server.', 409));
  return new Promise((resolve, reject) => {
    run(bin, ['project', 'add', realFolder, '--title', title.slice(0, 80)], { timeout: 20_000 }, (err, stdout, stderr) => {
      if (!err) return resolve({ already: false });
      const text = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
      if (/already/i.test(text)) return resolve({ already: true });
      const first = text.split('\n').find((l) => l.trim());
      reject(new ProjectError(`Could not add the folder to Code: ${(first ?? err.message).slice(0, 200)}`, 409));
    });
  });
}
