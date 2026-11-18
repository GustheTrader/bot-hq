import { Hono, type Context } from 'hono';
import { requireUser, type AuthVars } from './lib/auth.js';
import { appendRow, getBotRow } from './store.js';
import { enqueue } from './agent/loop.js';
import { isHarnessId } from './harness.js';
import {
  ProjectError, addProjectSkill, buildProjectPrompt, createProject, deleteProject, deleteProjectSkill,
  getProject, listProjectSkills, listProjects, updateProject, updateProjectSkill,
} from './projects.js';

/**
 * Projects: standing notes, skills and a default engine for a piece of ongoing work.
 *
 * "Start" does not switch a bot's engine itself. The app first calls the existing
 * PATCH /bots/:id/harness (which checks the harness is installed on the computer) and then this route, so
 * there is one place that decides whether an engine switch is allowed.
 */
export const projectsApi = new Hono<AuthVars>();
projectsApi.use('*', requireUser);

/** Run a handler, turning a ProjectError into its JSON response. */
async function guard(c: Context<AuthVars>, fn: () => Response | Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ProjectError) return c.json({ error: e.message }, e.status);
    throw e;
  }
}

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

// ---------- start work ----------

projectsApi.post('/:id/start', (c) => guard(c, async () => {
  const userId = c.get('user').id;
  const b = await body(c);
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
  if (!prompt) throw new ProjectError('Say what the work is.');
  const project = getProject(userId, c.req.param('id'));
  if (!project) throw new ProjectError('Project not found.', 404);
  const bot = typeof b.botId === 'string' ? getBotRow(b.botId) : null;
  // A team channel answers through its members, so work starts on a single bot.
  if (!bot || bot.user_id !== userId || bot.kind === 'team') throw new ProjectError('Pick one of your bots.', 404);

  const brief = buildProjectPrompt(project, listProjectSkills(userId, project.id) ?? [], prompt);
  // The chat shows what the person asked; the bot also gets the project's notes and skills.
  appendRow(bot.id, 'message', { type: 'message', role: 'user', text: `In project “${project.name}”: ${prompt}` });
  enqueue(bot.id, { type: 'user', text: brief });
  return c.json({ ok: true, botId: bot.id });
}));
