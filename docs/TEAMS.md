# Bot HQ — Teams

Status: **slice 1 shipped** (2026-11-16). Slices 2 and 3 pending.

## The model

A **team** is a `bots` row with `kind='team'`. It is a channel, not an agent: it never runs its
own loop. Its roster lives in the `team_members` table, one row per member:

| column | values |
|---|---|
| `member_kind` | `bot` (a Hermes agent with its own screen), `human` (a person with no agent), `user` (the account owner) |
| `member_id` | the bot id, the `humans.id`, or the `users.id` |
| `role` | `lead` or `member` — exactly one bot leads |

People are rows in `humans` (`id, user_id, name, email`). They are **contacts, not logins**.

Legacy group chats (`kind='room'`, JSON `members` list) are migrated once at boot by
`migrateRoomsToTeams()` in `server/src/db.ts`: each room becomes a team with `team_members` rows.
The migration is idempotent — the `UPDATE` only matches rows still marked `room`.

## Dispatch

Posting to a team goes through `dispatchTeamMessage` (`server/src/agent/rooms.ts`), not the agent
loop:

- **@mention narrows responders.** Mentioned bots answer (capped at `MAX_RESPONDERS = 3`).
- **Mentioning a person** does not run a loop — it appends an `event` row so the mention is visible
  on the channel, and the responding bot is told that person is "a person, not a Bot".
- **No mentions:** the team's lead answers first, then up to two other bots may chime in.
- Each responder gets a synthetic `[Team "…"]` system prompt carrying the roster, the recent
  messages, who was mentioned, and who else is on the team to hand work to.
- Bots reply with the `post_to_group` tool (still named that; it resolves a team by name).
  `stay_silent` lets a bot opt out.

## API

Mounted at `/api/rooms` (`server/src/routes-rooms.ts`), all session-gated:

| method | path | purpose |
|---|---|---|
| `GET` | `/api/rooms` | list teams (with members) + known humans |
| `POST` | `/api/rooms` | create a team: `{ name, botIds[], humanIds[], people[], includeUser? }` |
| `GET` | `/api/rooms/:id/members` | the roster |
| `PUT` | `/api/rooms/:id/members` | replace the roster `{ botIds[], humanIds[] }` |
| `POST` | `/api/rooms/:id/lead` | pick which bot speaks first |
| `POST` | `/api/rooms/humans` | add a person (name + optional email) |
| `DELETE` | `/api/rooms/humans/:id` | remove a person everywhere |

A team must keep at least one bot — the routes reject a roster with zero bots.

## UI

`web/src/components/TeamsView.tsx`, reached from the sidebar **Teams** island
(`useConfigUI.setView('teams')`). One screen: a creation panel, a tab per team, then the roster
split into **Bots on this team** and **People on this team**. From here you swap bots, add/remove
people, pick who speaks first, and open the team chat.

## Tests

`server/test/teams.test.ts` (5 cases): create with mixed roster, mention routing, @mentioning a
person notifies instead of dispatching, non-member post refusal, roster swap keeps a lead.
Run with `npm test -w server`.

## Still open

- **Slice 2:** a team **brief** prepended to every member's context, and an `observer` role that
  stays silent unless mentioned.
- **Slice 3:** the **Macro sub-app** (Docker on the Zen laptop, `macro-desktop-web` on
  `127.0.0.1:3017`) surfaced under the Team label — iframe vs. bot tool is undecided. See
  `Projects/bot-hq/docs/TEAMS-macro.md`.
