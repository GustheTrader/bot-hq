import { Hono, type Context } from 'hono';
import { requireUser, type AuthVars } from './lib/auth.js';
import { appendRow, getBotRow } from './store.js';
import { enqueue } from './agent/loop.js';
import { LIMITS, ProjectError, buildProjectPrompt, cleanLine, getProject, listProjectSkills } from './projects.js';
import { SkillError, listLibrarySkills, readLibrarySkill } from './skill-library.js';
import { fitsSpace } from './spaces.js';

/**
 * The launch page: the skills available on this computer, and one way to start work on a bot.
 *
 * Starting work is the same whether it came from the launch page (a project is optional) or from inside a
 * project, so there is one `startWork` and both routes call it. It does not switch the bot's engine; the app
 * calls the existing PATCH /bots/:id/harness first so one place decides whether a switch is allowed.
 */
export const launchApi = new Hono<AuthVars>();
launchApi.use('*', requireUser);

/** The most skills one request can carry; each can be thousands of characters. */
export const MAX_PICKED_SKILLS = 8;

export interface StartInput { botId?: unknown; prompt?: unknown; projectId?: unknown; folder?: unknown; skills?: unknown }

/** What startWork touches outside the database, so a test can watch it without running a real agent turn. */
export interface StartDeps {
  getBotRow: (id: string) => { id: string; user_id: string; kind?: string | null; space_id?: string | null; is_primary?: number | null } | null | undefined;
  appendRow: (botId: string, kind: 'message', body: { type: 'message'; role: 'user'; text: string }) => unknown;
  enqueue: (botId: string, trigger: { type: 'user'; text: string }) => unknown;
}

const realDeps: StartDeps = { getBotRow: (id) => getBotRow(id) as any, appendRow: (b, k, body) => appendRow(b, k, body), enqueue: (b, t) => enqueue(b, t) };

export function startWork(userId: string, input: StartInput, deps: StartDeps = realDeps): { botId: string } {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw new ProjectError('Say what the work is.');

  const bot = typeof input.botId === 'string' ? deps.getBotRow(input.botId) : null;
  // A team channel answers through its members, so work starts on a single bot.
  if (!bot || bot.user_id !== userId || bot.kind === 'team') throw new ProjectError('Pick one of your bots.', 404);

  const hasProject = input.projectId !== undefined && input.projectId !== null && input.projectId !== '';
  const project = hasProject ? (typeof input.projectId === 'string' ? getProject(userId, input.projectId) : null) : null;
  if (hasProject && !project) throw new ProjectError('Project not found.', 404);
  // A workspace's project notes and skills go only to its own bots (and the main bot).
  if (project?.spaceId && !fitsSpace(bot, project.spaceId)) throw new ProjectError('That project belongs to another workspace. Pick a bot from its workspace.', 409);

  const picked = Array.isArray(input.skills) ? [...new Set(input.skills)] : [];
  if (picked.length > MAX_PICKED_SKILLS) throw new ProjectError(`Pick up to ${MAX_PICKED_SKILLS} skills.`);
  // Each id is checked against the real skills folders; the client never supplies skill text.
  const chosen = picked.map((id) => readLibrarySkill(id as string));

  const folder = project ? '' : cleanLine(input.folder, LIMITS.folder);
  const brief = buildProjectPrompt(project, project ? listProjectSkills(userId, project.id) ?? [] : [], prompt, chosen, folder);

  // The chat shows what the person asked (and which skills they picked); the bot gets the full brief.
  const where = project ? `In project “${project.name}”: ` : folder ? `In ${folder}: ` : '';
  const used = chosen.length ? `\n\nSkills: ${chosen.map((s) => s.name).join(', ')}` : '';
  deps.appendRow(bot.id, 'message', { type: 'message', role: 'user', text: `${where}${prompt}${used}` });
  deps.enqueue(bot.id, { type: 'user', text: brief });
  return { botId: bot.id };
}

/** Run a handler, turning the module errors into their JSON responses. */
export async function guard(c: Context<AuthVars>, fn: () => Response | Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ProjectError || e instanceof SkillError) return c.json({ error: e.message }, e.status);
    throw e;
  }
}

launchApi.get('/skills', (c) => c.json({ skills: listLibrarySkills() }));

launchApi.post('/start', (c) => guard(c, async () => {
  const b = ((await c.req.json().catch(() => null)) ?? {}) as StartInput;
  return c.json({ ok: true, ...startWork(c.get('user').id, b) });
}));
