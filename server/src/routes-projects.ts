import { Hono, type Context } from 'hono';
import { requireUser, type AuthVars } from './lib/auth.js';
import { isHarnessId } from './harness.js';
import {
  ProjectError, addProjectSkill, createProject, deleteProject, deleteProjectSkill,
  getProject, listProjectSkills, listProjects, updateProject, updateProjectSkill,
} from './projects.js';
import { guard, startWork, type StartInput } from './routes-launch.js';
import { addToCode, listWorktrees, resolveProjectFolder } from './code-workspace.js';

/**
 * Projects: standing notes, skills and a default engine for a piece of ongoing work.
 *
 * "Start" does not switch a bot's engine itself. The app first calls the existing
 * PATCH /bots/:id/harness (which checks the harness is installed on the computer) and then this route, so
 * there is one place that decides whether an engine switch is allowed.
 */
export const projectsApi = new Hono<AuthVars>();
projectsApi.use('*', requireUser);

const body = async (c: Context<AuthVars>) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;

function checkHarness(b: Record<string, unknown>) {
  if (b.harness !== undefined && !(typeof b.harness === 'string' && isHarnessId(b.harness))) throw new ProjectError('Unknown harness.');
}

projectsApi.get('/', (c) => c.json({ projects: listProjects(c.get('user').id) }));

projectsApi.post('/', (c) => guard(c, async () => {
  const b = await body(c);
  checkHarness(b);
  return c.json({ project: createProject(c.get('user').id, b) }, 201);
}));

projectsApi.get('/:id', (c) => {
  const userId = c.get('user').id;
  const project = getProject(userId, c.req.param('id'));
  if (!project) return c.json({ error: 'Project not found.' }, 404);
  return c.json({ project, skills: listProjectSkills(userId, project.id) ?? [] });
});

projectsApi.patch('/:id', (c) => guard(c, async () => {
  const b = await body(c);
  checkHarness(b);
  return c.json({ project: updateProject(c.get('user').id, c.req.param('id'), b) });
}));

projectsApi.delete('/:id', (c) => (deleteProject(c.get('user').id, c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: 'Project not found.' }, 404)));

// ---------- skills ----------

projectsApi.post('/:id/skills', (c) => guard(c, async () => c.json({ skill: addProjectSkill(c.get('user').id, c.req.param('id'), await body(c)) }, 201)));

projectsApi.patch('/skills/:skillId', (c) => guard(c, async () => c.json({ skill: updateProjectSkill(c.get('user').id, c.req.param('skillId'), await body(c)) })));

projectsApi.delete('/skills/:skillId', (c) => (deleteProjectSkill(c.get('user').id, c.req.param('skillId')) ? c.json({ ok: true }) : c.json({ error: 'Skill not found.' }, 404)));

// ---------- start work, open in Code ----------

projectsApi.post('/:id/start', (c) => guard(c, async () => {
  const b = (await body(c)) as StartInput;
  return c.json({ ok: true, ...startWork(c.get('user').id, { ...b, projectId: c.req.param('id') }) });
}));

/** The git worktrees of the project's folder (read-only). */
projectsApi.get('/:id/worktrees', (c) => guard(c, async () => {
  const project = getProject(c.get('user').id, c.req.param('id'));
  if (!project) throw new ProjectError('Project not found.', 404);
  const folder = resolveProjectFolder(project.folder);
  return c.json({ folder, ...(await listWorktrees(folder)) });
}));

/** Registers the project's folder with the Code workspace (T3) so it opens there with a terminal. */
projectsApi.post('/:id/open-code', (c) => guard(c, async () => {
  const project = getProject(c.get('user').id, c.req.param('id'));
  if (!project) throw new ProjectError('Project not found.', 404);
  const folder = resolveProjectFolder(project.folder);
  const { already } = await addToCode(folder, project.name);
  return c.json({ ok: true, folder, already });
}));
