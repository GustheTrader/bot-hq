import { Hono, type Context } from 'hono';
import { requireUser, type AuthVars } from './lib/auth.js';
import { hub } from './lib/hub.js';
import { SpaceError, createSpace, deleteSpace, listSpaces, updateSpace } from './spaces.js';

/** /api/spaces: the workspaces (one per business or project) of the signed-in account. */
export const spacesApi = new Hono<AuthVars>();
spacesApi.use('*', requireUser);

const body = async (c: Context<AuthVars>) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;

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
  const space = updateSpace(userId, c.req.param('id'), await body(c));
  changed(userId);
  return c.json({ space });
}));

spacesApi.delete('/:id', (c) => guard(c, () => {
  const userId = c.get('user').id;
  deleteSpace(userId, c.req.param('id'));
  changed(userId);
  return c.json({ ok: true });
}));
