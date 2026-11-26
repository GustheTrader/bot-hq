import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { appendRow } from '../store.js';
import { fitsSpace } from '../spaces.js';
import type { TeamMember } from '../types.js';

/**
 * Teams: a channel that mixes Bots and people.
 *
 * A team is a bots row with kind='team'. Its roster lives in team_members, where a
 * member is a bot (member_kind='bot'), a person without a sign-in (member_kind='human'),
 * or the account owner themselves (member_kind='user'). The team never runs an agent loop
 * of its own: a message posted to it is dispatched to the bot members that should answer
 * (@mentioned ones, else the lead + the busiest few, capped), each of which runs its normal
 * loop with the team context and replies with post_to_group.
 *
 * Humans do not have an agent, so a team message that @mentions a human is surfaced to
 * them rather than answered by a bot: it lands on their roster entry as an unread count
 * and, when they have an email, is queued for delivery.
 */

const MAX_RESPONDERS = 3;

/**
 * Roles on a team:
 * - `lead` speaks first when nobody is @mentioned.
 * - `member` answers when @mentioned (and may chime in after the lead).
 * - `observer` is read-only: it is never chosen to answer, but an explicit @mention still
 *   runs it, so an observer can be pulled in deliberately.
 */
export const TEAM_ROLES = ['lead', 'member', 'observer'] as const;
export type TeamRoleName = (typeof TEAM_ROLES)[number];

/** Standing team context, stored on the team row. */
export function teamBrief(teamId: string) {
  const r = db.prepare('SELECT brief, brief_updated_at FROM bots WHERE id=?').get(teamId) as any;
  return { text: r?.brief ?? '', updatedAt: r?.brief_updated_at ?? null };
}

export function setTeamBrief(teamId: string, text: string) {
  const clean = (text ?? '').replace(/\r\n/g, '\n').trim().slice(0, 8000);
  db.prepare('UPDATE bots SET brief=?, brief_updated_at=? WHERE id=?').run(clean, now(), teamId);
  return teamBrief(teamId);
}

function briefLine(teamId: string): string {
  const b = teamBrief(teamId);
  if (!b.text) return '';
  return `\nTeam brief (standing context from the user — treat as the team's current objective):\n${b.text}\n`;
}

export function initRooms() {
  for (const col of ["kind TEXT NOT NULL DEFAULT 'agent'", 'members TEXT']) {
    try { db.exec(`ALTER TABLE bots ADD COLUMN ${col}`); } catch { /* exists */ }
  }
}

export const isTeam = (botId: string) =>
  (db.prepare('SELECT kind FROM bots WHERE id=?').get(botId) as any)?.kind === 'team';

export const isRoom = isTeam;

/** The full roster, humans included. `role` is 'lead' for the one member who speaks first. */
export function teamMembers(teamId: string): TeamMember[] {
  const rows = db
    .prepare('SELECT member_kind, member_id, role FROM team_members WHERE team_id=? ORDER BY (role=\'lead\') DESC, created_at ASC')
    .all(teamId) as any[];
  const out: TeamMember[] = [];
  for (const r of rows) {
    if (r.member_kind === 'bot') {
      const b = db.prepare('SELECT id, name, label, avatar_shape, avatar_color, avatar_image, COALESCE(kind,\'agent\') kind FROM bots WHERE id=?').get(r.member_id) as any;
      if (!b || b.kind === 'team') continue;
      out.push({ id: b.id, kind: 'bot', name: b.name, label: b.label ?? '', role: r.role, avatarShape: b.avatar_shape, avatarColor: b.avatar_color, avatarImage: b.avatar_image ?? null });
    } else if (r.member_kind === 'human') {
      const h = db.prepare('SELECT id, name, email FROM humans WHERE id=?').get(r.member_id) as any;
      if (!h) continue;
      out.push({ id: h.id, kind: 'human', name: h.name, label: h.email ?? '', role: r.role });
    } else if (r.member_kind === 'user') {
      const u = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(r.member_id) as any;
      if (!u) continue;
      out.push({ id: u.id, kind: 'user', name: u.name, label: u.email ?? '', role: r.role });
    }
  }
  return out;
}

/** Only the bot members — the ones that can actually run a turn. */
export function teamBots(teamId: string): TeamMember[] {
  return teamMembers(teamId).filter((m) => m.kind === 'bot');
}

/** Kept for callers that predate teams (the group-chat tools and detail panel). */
export const roomMembers = (teamId: string) =>
  teamBots(teamId).map((m) => ({ id: m.id, name: m.name }));

function addMember(teamId: string, kind: 'bot' | 'human' | 'user', id: string, role: TeamRoleName) {
  db.prepare(
    'INSERT OR REPLACE INTO team_members(team_id, member_kind, member_id, role, created_at) VALUES (?,?,?,?, COALESCE((SELECT created_at FROM team_members WHERE team_id=? AND member_kind=? AND member_id=?), ?))',
  ).run(teamId, kind, id, role, teamId, kind, id, now());
}

/** The workspace a set of bots shares, ignoring the primary bot (General when there is no other). */
export function teamSpace(botIds: string[]): string | null {
  for (const id of botIds) {
    const b = db.prepare('SELECT space_id, is_primary FROM bots WHERE id=?').get(id) as { space_id: string | null; is_primary: number } | undefined;
    if (b && !b.is_primary) return b.space_id ?? null;
  }
  return null;
}

/** The names of the bots that cannot sit on a team of this workspace. */
export function outsiders(botIds: string[], spaceId: string | null): string[] {
  return botIds.flatMap((id) => {
    const b = db.prepare('SELECT name, space_id, is_primary FROM bots WHERE id=?').get(id) as any;
    return b && !fitsSpace(b, spaceId) ? [b.name as string] : [];
  });
}

export function createTeam(
  userId: string,
  name: string,
  members: {
    botIds?: string[];
    humanIds?: string[];
    /** New teammates created inline (name + optional email). */
    humans?: { name: string; email?: string | null }[];
    includeUser?: boolean;
    /** The team's workspace. Left out, it is the one its bots share. */
    spaceId?: string | null;
  } = {},
) {
  const id = newId('team');
  const botIds = [...new Set(members.botIds ?? [])];
  const spaceId = members.spaceId !== undefined ? members.spaceId : teamSpace(botIds);
  const humanIds = [...new Set(members.humanIds ?? [])];
  const inline = members.humans ?? [];
  const peopleCount = humanIds.length + inline.length + (members.includeUser ? 1 : 0);
  db.prepare(
    `INSERT INTO bots(id,user_id,name,label,description,avatar_shape,avatar_color,kind,space_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'team',?,?,?)`,
  ).run(id, userId, name.slice(0, 60), 'Team', `Team of ${botIds.length} Bot${botIds.length === 1 ? '' : 's'}${peopleCount ? ` and ${peopleCount} ${peopleCount === 1 ? 'person' : 'people'}` : ''}`, 'cloud', 'gray', spaceId, now(), now());
  // The first bot on the roster leads, so a team message always has someone to answer it.
  botIds.forEach((bid, i) => addMember(id, 'bot', bid, i === 0 ? 'lead' : 'member'));
  humanIds.forEach((hid) => addMember(id, 'human', hid, 'member'));
  for (const h of inline) {
    const hid = addHuman(userId, h.name, h.email ?? null);
    addMember(id, 'human', hid, 'member');
  }
  if (members.includeUser) addMember(id, 'user', userId, 'member');
  hub.emit(userId, { type: 'roster' });
  return id;
}

/** Back-compat for the create_group tool and the old group-chat route. */
export const createRoom = (userId: string, name: string, memberIds: string[]) =>
  createTeam(userId, name, { botIds: memberIds });

export function addHuman(userId: string, name: string, email?: string | null) {
  const id = newId('hum');
  db.prepare('INSERT INTO humans(id,user_id,name,email,created_at) VALUES (?,?,?,?,?)').run(
    id, userId, name.trim().slice(0, 60) || 'Teammate', email?.trim() || null, now(),
  );
  hub.emit(userId, { type: 'roster' });
  return id;
}

export function listHumans(userId: string) {
  return (db.prepare('SELECT * FROM humans WHERE user_id=? ORDER BY created_at').all(userId) as any[]).map((h) => ({
    id: h.id, name: h.name, email: h.email ?? null, createdAt: h.created_at,
  }));
}

/** Replace a team's roster wholesale. Bot ids and human ids are separate lists.
 *  Observers already on the team keep their role; new bots default to member
 *  (unless no bot leads yet, in which case the first one takes the lead). */
export function setTeamRoster(teamId: string, botIds: string[], humanIds: string[]) {
  const prior = teamMembers(teamId);
  const before = new Set(prior.map((m) => `${m.kind}:${m.id}`));
  const roleOf = new Map(prior.map((m) => [`${m.kind}:${m.id}`, m.role]));
  const lead = prior.find((m) => m.role === 'lead' && m.kind === 'bot');
  db.prepare('DELETE FROM team_members WHERE team_id=?').run(teamId);
  const bots = [...new Set(botIds)];
  const leadId = lead && bots.includes(lead.id) ? lead.id : bots.find((b) => roleOf.get(`bot:${b}`) !== 'observer') ?? bots[0];
  bots.forEach((bid) => {
    const priorRole = roleOf.get(`bot:${bid}`);
    const role = bid === leadId ? 'lead' : priorRole === 'observer' ? 'observer' : 'member';
    addMember(teamId, 'bot', bid, role);
  });
  [...new Set(humanIds)].forEach((hid) => addMember(teamId, 'human', hid, roleOf.get(`human:${hid}`) === 'observer' ? 'observer' : 'member'));
  return { added: teamMembers(teamId).filter((m) => !before.has(`${m.kind}:${m.id}`)), removed: [] as TeamMember[] };
}

/** Set (or clear) the lead for a team. Pass null to leave the first bot leading.
 *  Observers are never promoted: only a speaking bot can lead. */
export function setTeamLead(teamId: string, memberId: string | null) {
  // Validate before demoting: promoting an ineligible member must not strip the existing lead.
  if (memberId) {
    const eligible = db
      .prepare("SELECT 1 FROM team_members WHERE team_id=? AND member_kind='bot' AND member_id=? AND role<>'observer'")
      .get(teamId, memberId);
    if (!eligible) return;
  }
  db.prepare("UPDATE team_members SET role='member' WHERE team_id=? AND role='lead'").run(teamId);
  if (memberId) db.prepare("UPDATE team_members SET role='lead' WHERE team_id=? AND member_id=?").run(teamId, memberId);
}

/** Set one member's role. Only one member leads at a time; picking a new lead demotes the old one.
 *  Demoting the lead with role 'member'/'observer' leaves the team without a speaker, which dispatch
 *  tolerates (it falls back to the first non-observer). */
export function setTeamRole(teamId: string, kind: 'bot' | 'human' | 'user', id: string, role: TeamRoleName) {
  if (!TEAM_ROLES.includes(role)) throw new Error(`Unknown role "${role}".`);
  if (role === 'lead') {
    // Only a Bot can lead, so resolve the write to a bot row before demoting the current lead.
    const target = db.prepare("SELECT 1 FROM team_members WHERE team_id=? AND member_kind='bot' AND member_id=?").get(teamId, id);
    if (kind !== 'bot' || !target) return;
    db.prepare("UPDATE team_members SET role='member' WHERE team_id=? AND role='lead'").run(teamId);
    db.prepare("UPDATE team_members SET role='lead' WHERE team_id=? AND member_kind='bot' AND member_id=?").run(teamId, id);
    return;
  }
  db.prepare('UPDATE team_members SET role=? WHERE team_id=? AND member_kind=? AND member_id=?').run(role, teamId, kind, id);
}

/**
 * Called instead of the agent loop when the user posts in a team channel.
 *
 * @mentioned bots always answer. @mentioned humans get a notification row instead (they have
 * no agent), and the team's lead bot is told to hand the question over. With no mentions, the
 * lead answers first and up to MAX_RESPONDERS-1 other bots may chime in.
 */
export function dispatchRoomMessage(teamId: string, text: string, enqueue: (botId: string, t: any) => void) {
  const team = db.prepare('SELECT * FROM bots WHERE id=?').get(teamId) as any;
  const roster = teamMembers(teamId);
  const bots = roster.filter((m) => m.kind === 'bot');
  if (!roster.length) {
    appendRow(teamId, 'notice', { type: 'notice', text: 'This team has no members yet. Add a Bot or a teammate.', tone: 'warn' });
    return;
  }
  if (!bots.length) {
    appendRow(teamId, 'notice', { type: 'notice', text: 'This team has no Bots on it yet, so nothing can answer. Add one in Members.', tone: 'warn' });
    return;
  }

  const lower = text.toLowerCase();
  const mention = (m: TeamMember) => lower.includes(`@${m.name.toLowerCase()}`);
  const mentionedBots = bots.filter(mention);
  const mentionedHumans = roster.filter((m) => m.kind !== 'bot' && mention(m));

  for (const h of mentionedHumans) notifyHuman(teamId, h, text);

  // Observers never volunteer; they only run when @mentioned by name.
  const speakers = bots.filter((b) => b.role !== 'observer');
  const lead = speakers.find((b) => b.role === 'lead') ?? speakers[0];
  const responders = mentionedBots.length
    ? mentionedBots.slice(0, MAX_RESPONDERS)
    : [lead, ...speakers.filter((b) => b.id !== lead?.id)].slice(0, MAX_RESPONDERS);
  if (!responders.length) {
    appendRow(teamId, 'notice', { type: 'notice', text: 'Everyone on this team is an observer, so nobody volunteered. @mention a Bot by name to run it.', tone: 'warn' });
    return;
  }
  // Who else is on the team, so a responder can hand work to them by name.
  const others = roster.filter((m) => !responders.some((r) => r.id === m.id));
  const humanLine = mentionedHumans.length
    ? ` You also @mentioned ${mentionedHumans.map((h) => `${h.name} (a person, not a Bot)`).join(', ')}; they were notified but only you can act on it.`
    : '';

  const recent = (db.prepare("SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq DESC LIMIT 12").all(teamId, team.generation) as any[])
    .reverse()
    .map((r) => {
      const b = JSON.parse(r.body);
      return `${b.from?.name ?? (b.role === 'user' ? 'User' : 'Bot')}: ${String(b.text).slice(0, 600)}`;
    })
    .join('\n');

  for (const m of responders) {
    enqueue(m.id, {
      type: 'system',
      text:
        `[Team "${team.name}"] Members: ${roster.map((x) => `${x.name}${x.kind === 'bot' ? '' : ' (person)'}${x.role === 'lead' ? ' [lead]' : ''}${x.role === 'observer' ? ' [observer]' : ''}`).join(', ')}. ` +
        `${m.role === 'lead' ? 'You lead this team. ' : ''}` +
        `${m.role === 'observer' ? 'You are an observer here: you were pulled in by name, so answer this one but do not volunteer on other messages. ' : ''}` +
        `${mentionedBots.length ? 'You were @mentioned.' : 'The user addressed the whole team.'}${humanLine}` +
        briefLine(team.id) +
        `Recent team messages:\n${recent}\n\n` +
        (others.length ? `If this is not your job, message the right member directly instead of guessing: ${others.map((o) => o.name).join(', ')}.\n` : '') +
        `Reply to the team by calling post_to_group with group_name "${team.name}" (use your tools first if the request needs real work). ` +
        `Keep it short and don't repeat what other Bots already said. If you have nothing to add, call stay_silent. Do not write a normal reply.`,
    });
  }
}

/** A person has no agent, so an @mention becomes a notice on the team channel. */
function notifyHuman(teamId: string, human: TeamMember, _text: string) {
  appendRow(teamId, 'event', {
    type: 'event',
    event: 'bot-message',
    text: `${human.name} was mentioned (they are a person, not a Bot) — notified${human.label ? ` at ${human.label}` : ''}.`,
    ref: human.id,
  });
}

/** Post a message into a team you are a member of. */
export function postToRoom(fromBotId: string, teamName: string, text: string) {
  const from = db.prepare('SELECT id, user_id, name FROM bots WHERE id=?').get(fromBotId) as any;
  const team = db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(
    // Two workspaces may each have a team of this name; the one the sender is on is meant.
    (db.prepare(`SELECT id FROM bots WHERE user_id=? AND kind='team' AND lower(name)=lower(?)
      ORDER BY EXISTS(SELECT 1 FROM team_members m WHERE m.team_id=bots.id AND m.member_kind='bot' AND m.member_id=?) DESC`).get(from.user_id, teamName.trim(), fromBotId) as any)?.id ?? '',
    from.user_id,
  ) as any;
  if (!team) return `No team named "${teamName}".`;
  const member = teamMembers(team.id).find((m) => m.kind === 'bot' && m.id === fromBotId);
  if (!member) return `You're not a member of "${team.name}".`;
  appendRow(team.id, 'message', { type: 'message', role: 'assistant', text, from: { kind: 'bot', id: from.id, name: from.name } });
  db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(team.id);
  return 'Posted to the team.';
}
