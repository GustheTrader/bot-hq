import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { env } from './env.js';
import type { LibrarySkill, SkillSource } from './types.js';

/**
 * The skills already on this computer, read-only: Zo's (`<workspace>/Skills/<name>/SKILL.md`), the primary
 * Hermes agent's (`<hermes home>/skills/<category>/<name>/SKILL.md`) and Anthropic's public skills
 * (a clone of github.com/anthropics/skills, `<clone>/skills/<name>/SKILL.md`). A skill is a folder with a
 * SKILL.md whose header names it and says when to use it. An Anthropic skill is only offered when its folder
 * carries an open-source license file (Apache or MIT), so a source-available one never slips in.
 *
 * Nothing here writes. Callers pass an id from the listing, never a path, and the id is checked against the
 * folder it claims to be in (including where a symlink really points) before anything is read.
 */

export type { LibrarySkill, SkillSource };

/** Anthropic's folder is optional: without it there are just the other two sources. */
export type SkillRoots = { zo: string; hermes: string; anthropic?: string };

export const defaultRoots = (): SkillRoots => ({
  zo: process.env.SKILLS_ZO_DIR ?? '/home/workspace/Skills',
  hermes: path.join(env.hermesHome, 'skills'),
  anthropic: process.env.SKILLS_ANTHROPIC_DIR ?? '/home/workspace/Skills-anthropic/skills',
});

/** Sources whose skills need an open-source license file in their folder to be offered. */
const NEEDS_LICENSE: ReadonlySet<SkillSource> = new Set(['anthropic']);
const OPEN_LICENSE = /\b(apache license|mit license)\b/i;

/** True when the skill folder has a LICENSE file that is Apache or MIT. */
export function hasOpenLicense(dir: string): boolean {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return false; }
  for (const n of names) {
    if (!/^licen[cs]e(\.(txt|md))?$/i.test(n)) continue;
    let fd: number | null = null;
    try {
      fd = fs.openSync(path.join(dir, n), 'r');
      const buf = Buffer.alloc(2048);
      const len = fs.readSync(fd, buf, 0, buf.length, 0);
      if (OPEN_LICENSE.test(buf.subarray(0, len).toString('utf8'))) return true;
    } catch { /* unreadable (or a folder named LICENSE): not a license */ } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch { /* already gone */ }
    }
  }
  return false;
}

const MAX_DEPTH = 4;
/** A SKILL.md bigger than this is not read at all. */
const MAX_FILE = 256 * 1024;
/** The most of a skill's instructions that goes into a brief. */
export const MAX_BODY = 12_000;
const ID = /^(zo|hermes|anthropic):([A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3})$/;

const oneLine = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

interface Parsed { name: string; description: string; body: string }

/** Splits a SKILL.md into its YAML header fields and the instructions after it. A missing or broken header is fine. */
export function parseSkillFile(text: string): Parsed {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  let fm: Record<string, unknown> = {};
  if (m) {
    try {
      const v = YAML.parse(m[1]);
      if (v && typeof v === 'object' && !Array.isArray(v)) fm = v as Record<string, unknown>;
    } catch { /* a header that does not parse is treated as no header */ }
  }
  const body = (m ? text.slice(m[0].length) : text).trim();
  return { name: oneLine(fm.name, 80), description: oneLine(fm.description, 300), body };
}

function walk(root: string, source: SkillSource, out: LibrarySkill[]) {
  const visit = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const file = entries.find((e) => e.isFile() && e.name === 'SKILL.md');
    if (file && depth > 0) {
      if (NEEDS_LICENSE.has(source) && !hasOpenLicense(dir)) return;
      let size = 0;
      try { size = fs.statSync(path.join(dir, 'SKILL.md')).size; } catch { return; }
      if (size <= MAX_FILE) {
        const rel = path.relative(root, dir).split(path.sep).join('/');
        // A folder name an id can't carry (a space, say) could be listed but never read: leave it out.
        if (!ID.test(`${source}:${rel}`)) return;
        let head = { name: '', description: '' };
        try {
          const p = parseSkillFile(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
          head = { name: p.name, description: p.description };
        } catch { /* unreadable: still listed by folder name */ }
        const parts = rel.split('/');
        out.push({
          id: `${source}:${rel}`,
          source,
          name: head.name || parts[parts.length - 1],
          description: head.description,
          category: parts.length > 1 ? parts.slice(0, -1).join('/') : '',
        });
      }
      return; // a skill folder is a leaf: do not look inside it for more skills
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      // Directories only, not symlinked ones (readdir reports a symlink as a symlink), and nothing hidden.
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') visit(path.join(dir, e.name), depth + 1);
    }
  };
  visit(root, 0);
}

export function scanSkills(roots: SkillRoots): LibrarySkill[] {
  const out: LibrarySkill[] = [];
  walk(roots.zo, 'zo', out);
  walk(roots.hermes, 'hermes', out);
  if (roots.anthropic) walk(roots.anthropic, 'anthropic', out);
  return out.sort((a, b) => a.source.localeCompare(b.source) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

let cache: { at: number; skills: LibrarySkill[] } | null = null;
const TTL_MS = 30_000;

/** The listing, cached for 30 seconds: about a hundred small files, but the picker asks every time it opens. */
export function listLibrarySkills(): LibrarySkill[] {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.skills;
  const skills = scanSkills(defaultRoots());
  cache = { at: Date.now(), skills };
  return skills;
}

export class SkillError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) { super(message); }
}

export interface ChosenSkill { id: string; name: string; description: string; body: string }

/** Where a skill's folder really is, by id. Throws SkillError for anything that is not a real skill inside its folder. */
function resolveSkill(id: string, roots: SkillRoots): { source: SkillSource; rel: string; dirReal: string; fileReal: string } {
  const m = typeof id === 'string' ? ID.exec(id) : null;
  if (!m) throw new SkillError(`Unknown skill: ${String(id).slice(0, 80)}`);
  const source = m[1] as SkillSource;
  const rel = m[2];
  const root = roots[source];
  if (!root) throw new SkillError(`Unknown skill: ${id}`, 404);
  let rootReal: string;
  let fileReal: string;
  try {
    rootReal = fs.realpathSync(root);
    fileReal = fs.realpathSync(path.join(root, rel, 'SKILL.md'));
  } catch { throw new SkillError(`Unknown skill: ${id}`, 404); }
  // A symlink inside the skills folder must not lead anywhere outside it.
  if (!fileReal.startsWith(rootReal + path.sep)) throw new SkillError(`Unknown skill: ${id}`, 404);
  const dirReal = path.dirname(fileReal);
  if (NEEDS_LICENSE.has(source) && !hasOpenLicense(dirReal)) throw new SkillError(`Unknown skill: ${id}`, 404);
  return { source, rel, dirReal, fileReal };
}

/** One skill's instructions, by id, cut at `maxBody` characters (a brief's share by default). */
export function readLibrarySkill(id: string, roots: SkillRoots = defaultRoots(), maxBody = MAX_BODY): ChosenSkill & { cut: boolean } {
  const { rel, fileReal } = resolveSkill(id, roots);
  let stat: fs.Stats;
  try { stat = fs.statSync(fileReal); } catch { throw new SkillError(`Unknown skill: ${id}`, 404); }
  if (!stat.isFile() || stat.size > MAX_FILE) throw new SkillError(`Skill is not readable: ${id}`);
  const p = parseSkillFile(fs.readFileSync(fileReal, 'utf8'));
  const folder = rel.split('/').pop()!;
  return { id, name: p.name || folder, description: p.description, body: p.body.slice(0, maxBody), cut: p.body.length > maxBody };
}

const MAX_FILES = 60;

/**
 * The other files a skill ships (scripts, references, templates), as absolute paths on this computer, so an
 * agent can open or run them. Nothing hidden, no symlinks, at most 60 and 3 folders deep.
 */
export function skillFiles(id: string, roots: SkillRoots = defaultRoots()): { dir: string; files: string[]; more: boolean } {
  const { dirReal } = resolveSkill(id, roots);
  const files: string[] = [];
  let more = false;
  const visit = (dir: string, depth: number) => {
    if (more) return; // the cap was hit: stop the whole walk, not just this folder
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (more) return;
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      const full = path.join(dir, e.name);
      if (e.isFile() && !(depth === 0 && e.name === 'SKILL.md')) {
        if (files.length >= MAX_FILES) { more = true; return; }
        files.push(full);
      } else if (e.isDirectory() && depth < 3) visit(full, depth + 1);
    }
  };
  visit(dirReal, 0);
  return { dir: dirReal, files, more };
}
