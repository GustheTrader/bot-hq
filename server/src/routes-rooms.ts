import { Hono } from 'hono';
import { db, now } from './db.js';
import { hub } from './lib/hub.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { appendRow } from './store.js';
import {
  addHuman,
  createTeam,
  listHumans,
  setTeamLead,
  setTeamRoster,
  teamMembers,
} from './agent/rooms.js';

/**
 * /api/teams: a channel that mixes Bots and people. A team is a bot row with kind='team';
 * its roster lives in team_members. Humans are people without an agent of their own.
 */
export const roomsApi = new Hono<AuthVars>();
roomsApi.use('*', requireUser);

const ownTeam = (userId: string, id: string) =>
  db.prepare("SELECT * FROM bots WHERE id=? AND user_id=? AND kind='team'").get(id, userId) as any;

const isBotMember = (userId: string, id: string) =>
  !!db.prepare("SELECT 1 FROM bots WHERE id=? AND user_id=? AND COALESCE(kind,'agent')<>'team' AND COALESCE(hidden,0)=0").get(id, userId);

const isHumanMember = (userId: string, id: string) =>
  !!db.prepare('SELECT 1 FROM humans WHERE id=? AND user_id=?').get(id, userId);

roomsApi.get('/:id/members', (c) => {
  const team = ownTeam(c.get('user').id, c.req.param('id'));
  if (!team) return c.json({ error: 'not found' }, 404);
  return c.json({ members: teamMembers(team.id) });
});

roomsApi.get('/', (c) => {
  const userId = c.get('user').id;
  const teams = (db.prepare("SELECT id, name, label, description FROM bots WHERE user_id=? AND kind='team' ORDER BY created_at").all(userId) as any[])
    .map((t) => ({ id: t.id, name: t.name, label: t.label, description: t.description, members: teamMembers(t.id) }));
  return c.json({ teams, humans: listHumans(userId) });
});

/** Create a team from the UI: { name, botIds[], humanIds[], people[], includeUser? }.
 *  `people` are new teammates created inline (name + optional email). */
roomsApi.post('/', async (c) => {
  const user = c.get('user');
  const { name, botIds, humanIds, people, includeUser } = await c.req.json<{
    name: string; botIds?: string[]; humanIds?: string[];
    people?: { name: string; email?: string }[]; includeUser?: boolean;
  }>();
  const bots = [...new Set(botIds ?? [])].filter((id) => isBotMember(user.id, id));
  if (!name?.trim()) return c.json({ error: 'A team needs a name.' }, 400);
  if (bots.length < 1) return c.json({ error: 'A team needs at least one Bot.' }, 400);
  const id = createTeam(user.id, name.trim(), {
    botIds: bots,
    humanIds: [...new Set(humanIds ?? [])].filter((id) => isHumanMember(user.id, id)),
    humans: people ?? [],
    includeUser: !!includeUser,
  });
  return c.json({ id });
});

roomsApi.put('/:id/members', async (c) => {
  const user = c.get('user');
  const team = ownTeam(user.id, c.req.param('id'));
  if (!team) return c.json({ error: 'not found' }, 404);
  const { botIds, humanIds } = await c.req.json<{ botIds?: string[]; humanIds?: string[] }>();
  const before = new Set(teamMembers(team.id).map((m) => `${m.kind}:${m.id}`));
  const bots = [...new Set(botIds ?? [])].filter((id) => isBotMember(user.id, id));
  const humans = [...new Set(humanIds ?? [])].filter((id) => isHumanMember(user.id, id));
  if (bots.length < 1) return c.json({ error: 'A team needs at least one Bot.' }, 400);
  setTeamRoster(team.id, bots, humans);
  const after = teamMembers(team.id);
  const name = (m: { id: string; name: string }) => m.name;
  const added = after.filter((m) => !before.has(`${m.kind}:${m.id}`)).map(name);
  const removed = [...before]
    .filter((k) => !after.some((m) => `${m.kind}:${m.id}` === k))
    .map((k) => {
      const [kind, id] = k.split(':');
      const row = kind === 'human'
        ? (db.prepare('SELECT name FROM humans WHERE id=?').get(id) as any)
        : (db.prepare('SELECT name FROM bots WHERE id=?').get(id) as any);
      return row?.name ?? id;
    });
  db.prepare('UPDATE bots SET description=?, updated_at=? WHERE id=?').run(
    `Team of ${after.filter((m) => m.kind === 'bot').length} Bot${after.filter((m) => m.kind === 'bot').length === 1 ? '' : 's'}` +
      (after.some((m) => m.kind !== 'bot') ? ` and ${after.filter((m) => m.kind !== 'bot').length} ${after.filter((m) => m.kind !== 'bot').length === 1 ? 'person' : 'people'}` : ''),
    now(), team.id,
  );
  if (added.length || removed.length) {
    appendRow(team.id, 'event', {
      type: 'event', event: 'bot-message',
      text: [added.length ? `${added.join(', ')} joined` : '', removed.length ? `${removed.join(', ')} left` : ''].filter(Boolean).join(' · '),
    });
  }
  hub.emit(user.id, { type: 'roster' });
  return c.json({ ok: true, members: after });
});

/** People on the roster who have no agent of their own. */
roomsApi.post('/humans', async (c) => {
  const user = c.get('user');
  const { name, email } = await c.req.json<{ name: string; email?: string }>();
  if (!name?.trim()) return c.json({ error: 'A teammate needs a name.' }, 400);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return c.json({ error: 'That email does not look right.' }, 400);
  return c.json({ id: addHuman(user.id, name, email) });
});

roomsApi.delete('/humans/:id', (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  if (!isHumanMember(user.id, id)) return c.json({ error: 'not found' }, 404);
  db.prepare('DELETE FROM team_members WHERE member_kind=? AND member_id=?').run('human', id);
  db.prepare('DELETE FROM humans WHERE id=?').run(id);
  hub.emit(user.id, { type: 'roster' });
  return c.json({ ok: true });
});

/** Pick which Bot speaks first in a team. */
roomsApi.post('/:id/lead', async (c) => {
  const user = c.get('user');
  const team = ownTeam(user.id, c.req.param('id'));
  if (!team) return c.json({ error: 'not found' }, 404);
  const { memberId } = await c.req.json<{ memberId: string | null }>();
  if (memberId && !teamMembers(team.id).some((m) => m.kind === 'bot' && m.id === memberId)) {
    return c.json({ error: 'Pick a Bot on this team.' }, 400);
  }
  setTeamLead(team.id, memberId);
  hub.emit(user.id, { type: 'roster' });
  return c.json({ ok: true, members: teamMembers(team.id) });
});
