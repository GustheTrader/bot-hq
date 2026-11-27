import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { SpaceError, spaceIdFrom } from './spaces.js';
import type { Project, ProjectSkill } from './types.js';

/**
 * Projects: named pieces of ongoing work with standing notes, a default engine and their own skills.
 *
 * Everything here is scoped to one user. This module only touches the database; the HTTP layer
 * (routes-projects.ts) validates the harness id and hands the brief to the agent loop, so nothing here
 * imports either.
 */

export const LIMITS = {
  projects: 100,
  skillsPerProject: 50,
  name: 80,
  description: 300,
  folder: 300,
  instructions: 8_000,
  skillBody: 12_000,
  /** Most of the project's notes and skills that go into one brief; skills past it are listed by name only. */
  brief: 16_000,
  prompt: 20_000,
} as const;

export class ProjectError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

// Control characters other than tab and newline never belong in text a bot will read.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const text = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(CONTROL, '').trim().slice(0, max) : '');
/** Single-line fields (name, folder, description): line breaks collapse to spaces. */
const line = (s: unknown, max: number) => text(s, max * 2).replace(/\s*[\r\n]+\s*/g, ' ').slice(0, max).trim();

/** For callers that take a single-line value (a folder) from the request. */
export const cleanLine = line;

function toProject(r: any, skillCount: number): Project {
  return {
    id: r.id,
    spaceId: r.space_id ?? null,
    name: r.name,
    description: r.description ?? '',
    folder: r.folder ?? '',
    instructions: r.instructions ?? '',
    harness: r.harness ?? 'hermes',
    harnessModel: r.harness_model ?? null,
    skillCount,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const toSkill = (r: any): ProjectSkill => ({ id: r.id, projectId: r.project_id, name: r.name, description: r.description ?? '', body: r.body, createdAt: r.created_at, updatedAt: r.updated_at });

const skillCount = (projectId: string) => (db.prepare('SELECT COUNT(*) AS n FROM project_skills WHERE project_id=?').get(projectId) as { n: number }).n;
const ownRow = (userId: string, id: string) => db.prepare('SELECT * FROM projects WHERE id=? AND user_id=?').get(id, userId) as any | undefined;

export function listProjects(userId: string): Project[] {
  const rows = db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM project_skills s WHERE s.project_id = p.id) AS skill_count
       FROM projects p WHERE p.user_id=? ORDER BY p.updated_at DESC`,
    )
    .all(userId) as any[];
  return rows.map((r) => toProject(r, r.skill_count));
}

export function getProject(userId: string, id: string): Project | null {
  const r = ownRow(userId, id);
  return r ? toProject(r, skillCount(id)) : null;
}

export interface ProjectInput {
  name?: unknown;
  description?: unknown;
  folder?: unknown;
  instructions?: unknown;
  harness?: unknown;
  harnessModel?: unknown;
  spaceId?: unknown;
}

function projectSpace(userId: string, raw: unknown): string | null {
  try { return spaceIdFrom(userId, raw); } catch (e) {
    if (e instanceof SpaceError) throw new ProjectError(e.message, e.status);
    throw e;
  }
}

export function createProject(userId: string, input: ProjectInput): Project {
  const name = line(input.name, LIMITS.name);
  if (!name) throw new ProjectError('A project needs a name.');
  const count = (db.prepare('SELECT COUNT(*) AS n FROM projects WHERE user_id=?').get(userId) as { n: number }).n;
  if (count >= LIMITS.projects) throw new ProjectError(`You can have up to ${LIMITS.projects} projects.`, 409);
  const id = newId('prj');
  const t = now();
  const model = line(input.harnessModel, 160);
  const spaceId = projectSpace(userId, input.spaceId);
  db.prepare(
    'INSERT INTO projects(id,user_id,name,description,folder,instructions,harness,harness_model,space_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    id, userId, name,
    line(input.description, LIMITS.description),
    line(input.folder, LIMITS.folder),
    text(input.instructions, LIMITS.instructions),
    line(input.harness, 40) || 'hermes',
    model || null,
    spaceId,
    t, t,
  );
  return getProject(userId, id)!;
}

/** Only the fields that are present change; an empty harnessModel clears it back to the harness default. */
export function updateProject(userId: string, id: string, patch: ProjectInput): Project {
  const cur = ownRow(userId, id);
  if (!cur) throw new ProjectError('Project not found.', 404);
  const name = patch.name !== undefined ? line(patch.name, LIMITS.name) : cur.name;
  if (!name) throw new ProjectError('A project needs a name.');
  const model = patch.harnessModel !== undefined ? line(patch.harnessModel, 160) || null : cur.harness_model;
  const spaceId = patch.spaceId !== undefined ? projectSpace(userId, patch.spaceId) : cur.space_id ?? null;
  db.prepare('UPDATE projects SET name=?, description=?, folder=?, instructions=?, harness=?, harness_model=?, space_id=?, updated_at=? WHERE id=?').run(
    name,
    patch.description !== undefined ? line(patch.description, LIMITS.description) : cur.description,
    patch.folder !== undefined ? line(patch.folder, LIMITS.folder) : cur.folder,
    patch.instructions !== undefined ? text(patch.instructions, LIMITS.instructions) : cur.instructions,
    patch.harness !== undefined ? line(patch.harness, 40) || 'hermes' : cur.harness,
    model,
    spaceId,
    now(),
    id,
  );
  return getProject(userId, id)!;
}

export function deleteProject(userId: string, id: string): boolean {
  return db.prepare('DELETE FROM projects WHERE id=? AND user_id=?').run(id, userId).changes > 0;
}

// ---------- skills ----------

export function listProjectSkills(userId: string, projectId: string): ProjectSkill[] | null {
  if (!ownRow(userId, projectId)) return null;
  return (db.prepare('SELECT * FROM project_skills WHERE project_id=? ORDER BY created_at ASC').all(projectId) as any[]).map(toSkill);
}

export interface SkillInput { name?: unknown; description?: unknown; body?: unknown }

export function addProjectSkill(userId: string, projectId: string, input: SkillInput): ProjectSkill {
  if (!ownRow(userId, projectId)) throw new ProjectError('Project not found.', 404);
  const name = line(input.name, LIMITS.name);
  const body = text(input.body, LIMITS.skillBody);
  if (!name) throw new ProjectError('A skill needs a name.');
  if (!body) throw new ProjectError('A skill needs instructions.');
  if (skillCount(projectId) >= LIMITS.skillsPerProject) throw new ProjectError(`A project can have up to ${LIMITS.skillsPerProject} skills.`, 409);
  const id = newId('psk');
  const t = now();
  db.prepare('INSERT INTO project_skills(id,project_id,name,description,body,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, projectId, name, line(input.description, LIMITS.description), body, t, t);
  db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(t, projectId);
  return toSkill(db.prepare('SELECT * FROM project_skills WHERE id=?').get(id));
}

const ownSkill = (userId: string, skillId: string) =>
  db
    .prepare('SELECT s.* FROM project_skills s JOIN projects p ON p.id = s.project_id WHERE s.id=? AND p.user_id=?')
    .get(skillId, userId) as any | undefined;

export function updateProjectSkill(userId: string, skillId: string, patch: SkillInput): ProjectSkill {
  const cur = ownSkill(userId, skillId);
  if (!cur) throw new ProjectError('Skill not found.', 404);
  const name = patch.name !== undefined ? line(patch.name, LIMITS.name) : cur.name;
  const body = patch.body !== undefined ? text(patch.body, LIMITS.skillBody) : cur.body;
  if (!name) throw new ProjectError('A skill needs a name.');
  if (!body) throw new ProjectError('A skill needs instructions.');
  const t = now();
  db.prepare('UPDATE project_skills SET name=?, description=?, body=?, updated_at=? WHERE id=?').run(
    name, patch.description !== undefined ? line(patch.description, LIMITS.description) : cur.description, body, t, skillId,
  );
  db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(t, cur.project_id);
  return toSkill(db.prepare('SELECT * FROM project_skills WHERE id=?').get(skillId));
}

export function deleteProjectSkill(userId: string, skillId: string): boolean {
  const cur = ownSkill(userId, skillId);
  if (!cur) return false;
  db.prepare('DELETE FROM project_skills WHERE id=?').run(skillId);
  db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now(), cur.project_id);
  return true;
}

// ---------- the brief ----------

/**
 * What a bot is told when work starts in a project: the project's notes and skills, then the request.
 * The request always goes in whole. The notes and skills share a budget; a skill that does not fit is listed by
 * name and description only, so the bot knows it exists and can ask for it.
 */
export function buildProjectPrompt(
  project: Pick<Project, 'name' | 'description' | 'folder' | 'instructions'> | null,
  skills: ProjectSkill[],
  request: string,
  /** Skills the person picked for this one request (from the Zo and Hermes libraries). They go first and get budget first. */
  chosen: { name: string; description: string; body: string }[] = [],
  /** The folder for work that is not in a project. */
  folder = '',
): string {
  const head: string[] = project ? [`You are starting work in the project "${project.name}".`] : ['You are starting some work.'];
  const where = project ? project.folder : folder;
  if (where) head.push(`Folder: ${where}`);
  if (project?.description) head.push(`About: ${project.description}`);
  if (project?.instructions) head.push('', 'Project notes:', project.instructions);

  let budget = LIMITS.brief - head.join('\n').length;
  const fit = (items: { name: string; description: string; body: string }[]) => {
    const shown: string[] = [];
    const listed: string[] = [];
    for (const s of items) {
      const full = `## ${s.name}${s.description ? `\n${s.description}` : ''}\n${s.body}`;
      if (full.length <= budget) {
        shown.push(full);
        budget -= full.length;
      } else {
        listed.push(`- ${s.name}${s.description ? `: ${s.description}` : ''}`);
      }
    }
    return { shown, listed };
  };
  const picked = fit(chosen);
  const own = fit(skills);

  const out = [...head];
  if (picked.shown.length) out.push('', 'Skills chosen for this request (use them):', picked.shown.join('\n\n'));
  if (picked.listed.length) out.push('', 'More chosen skills, not shown in full to keep this short (ask the user if you need one):', picked.listed.join('\n'));
  if (own.shown.length) out.push('', 'Project skills (follow these when they apply):', own.shown.join('\n\n'));
  if (own.listed.length) out.push('', 'More project skills, not shown in full to keep this short (ask the user if you need one):', own.listed.join('\n'));
  out.push('', 'Request:', request.trim().slice(0, LIMITS.prompt));
  return out.join('\n');
}
