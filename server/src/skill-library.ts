import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { env } from './env.js';

/**
 * The skills already on this computer, read-only: Zo's (`<workspace>/Skills/<name>/SKILL.md`) and the primary
 * Hermes agent's (`<hermes home>/skills/<category>/<name>/SKILL.md`). A skill is a folder with a SKILL.md whose
 * header names it and says when to use it.
 *
 * Nothing here writes. Callers pass an id from the listing, never a path, and the id is checked against the
 * folder it claims to be in (including where a symlink really points) before anything is read.
 */

export type SkillSource = 'zo' | 'hermes';

export interface LibrarySkill {
  /** `zo:<folder>` or `hermes:<category>/<folder>`: the only handle a caller ever holds. */
  id: string;
  source: SkillSource;
  name: string;
  description: string;
  /** Hermes groups skills in category folders; Zo's are flat. Empty when there is none. */
  category: string;
}

export type SkillRoots = Record<SkillSource, string>;

export const defaultRoots = (): SkillRoots => ({
  zo: process.env.SKILLS_ZO_DIR ?? '/home/workspace/Skills',
  hermes: path.join(env.hermesHome, 'skills'),
});

const MAX_DEPTH = 4;
/** A SKILL.md bigger than this is not read at all. */
const MAX_FILE = 256 * 1024;
/** The most of a skill's instructions that goes into a brief. */
export const MAX_BODY = 12_000;
const ID = /^(zo|hermes):([A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3})$/;

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
      let size = 0;
      try { size = fs.statSync(path.join(dir, 'SKILL.md')).size; } catch { return; }
      if (size <= MAX_FILE) {
        const rel = path.relative(root, dir).split(path.sep).join('/');
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

/** One skill's instructions, by id. Throws SkillError for anything that is not a real skill inside its folder. */
export function readLibrarySkill(id: string, roots: SkillRoots = defaultRoots()): ChosenSkill {
  const m = typeof id === 'string' ? ID.exec(id) : null;
  if (!m) throw new SkillError(`Unknown skill: ${String(id).slice(0, 80)}`);
  const source = m[1] as SkillSource;
  const rel = m[2];
  let rootReal: string;
  let fileReal: string;
  try {
    rootReal = fs.realpathSync(roots[source]);
    fileReal = fs.realpathSync(path.join(roots[source], rel, 'SKILL.md'));
  } catch { throw new SkillError(`Unknown skill: ${id}`, 404); }
  // A symlink inside the skills folder must not lead anywhere outside it.
  if (!fileReal.startsWith(rootReal + path.sep)) throw new SkillError(`Unknown skill: ${id}`, 404);
  let stat: fs.Stats;
  try { stat = fs.statSync(fileReal); } catch { throw new SkillError(`Unknown skill: ${id}`, 404); }
  if (!stat.isFile() || stat.size > MAX_FILE) throw new SkillError(`Skill is not readable: ${id}`);
  const p = parseSkillFile(fs.readFileSync(fileReal, 'utf8'));
  const folder = rel.split('/').pop()!;
  return { id, name: p.name || folder, description: p.description, body: p.body.slice(0, MAX_BODY) };
}
