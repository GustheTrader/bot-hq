import { Hono, type Context } from 'hono';
import { requireUser, type AuthVars } from './lib/auth.js';
import { hub } from './lib/hub.js';
import { SpaceError, createSpace, deleteSpace, getSpace, listSpaces, updateSpace } from './spaces.js';
import { workspaceFolder } from './obsidian.js';

/** /api/spaces: the workspaces (one per business or project) of the signed-in account. */
export const spacesApi = new Hono<AuthVars>();
spacesApi.use('*', requireUser);

async function body(c: Context<AuthVars>): Promise<Record<string, unknown>> {
  const b: unknown = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new SpaceError('Send the workspace as a JSON object.');
  return b as Record<string, unknown>;
}

async function guard(c: Context<AuthVars>, fn: () => Response | Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SpaceError) return c.json({ error: e.message }, e.status);
    throw e;
  }
}

const changed = (userId: string) => hub.emit(userId, { type: 'roster' });

spacesApi.get('/', (c) => c.json({ spaces: listSpaces(c.get('user').id) }));

spacesApi.post('/', (c) => guard(c, async () => {
  const userId = c.get('user').id;
  const space = createSpace(userId, await body(c));
  changed(userId);
  return c.json({ space }, 201);
}));

spacesApi.patch('/:id', (c) => guard(c, async () => {
  const userId = c.get('user').id;
  const patch = await body(c);
  const before = getSpace(userId, c.req.param('id'));
  const renaming = before && typeof patch.name === 'string' && patch.name.trim().toLowerCase() !== before.name.toLowerCase();
  const folder = renaming ? workspaceFolder(userId, before.name) : null;
  // Notes are matched to a workspace by folder name, so a rename would silently stop them syncing.
  if (folder) throw new SpaceError(`The Obsidian vault has notes in ${folder}. Rename or remove that folder first.`, 409);
  const space = updateSpace(userId, c.req.param('id'), patch);
  changed(userId);
  return c.json({ space });
}));

spacesApi.delete('/:id', (c) => guard(c, () => {
  const userId = c.get('user').id;
  deleteSpace(userId, c.req.param('id'));
  changed(userId);
  return c.json({ ok: true });
}));
