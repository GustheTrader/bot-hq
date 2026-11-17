# Teams (Bots + people) — 2026-11-16

Status: **Slice 1 shipped.** Team is a first-class object; the roster mixes Bots and people.

## What changed

Rooms are gone. What was `bots.kind='room'` — a group chat with a JSON list of bot ids —
is now `bots.kind='team'` with its roster in a real table. Legacy rows are migrated on boot
(`migrateRoomsToTeams` in `server/src/db.ts`, idempotent).

- **`team_members`** — `(team_id, member_kind, member_id, role, created_at)` where
  `member_kind ∈ {bot, human, user}` and `role ∈ {lead, member}`. A team's roster is rows
  here, not a JSON blob, so it can be queried and indexed both ways.
- **`humans`** — people the owner names: name + optional email, no sign-in. They are
  contacts, not accounts, which keeps the door open for real invites later without a
  schema rewrite.
- **`agent/rooms.ts`** — `teamMembers`, `teamBots`, `createTeam`, `addHuman`,
  `setTeamRoster`, `setTeamLead`, `dispatchTeamMessage`, `postToRoom`. `isRoom` is kept
  as an alias of `isTeam` for callers that predate the rename.
- **`routes-rooms.ts`** — served at `/api/teams` (the mount is still `/api/rooms`):
  `GET /`, `POST /`, `PUT /:id/members`, `POST /:id/lead`, `POST /humans`, `DELETE /humans/:id`.
- **Tools** — `create_group` and `post_to_group` still work and now produce teams.
- **Web** — Teams island in the sidebar (alongside Code / Work), `TeamsView` with create,
  roster editing, lead pick, and "Open team chat"; `MembersCard` and `DetailsPanel` render
  the mixed roster.

## Dispatch rules

`dispatchTeamMessage(teamId, text, enqueue)`:

1. `@mention` a bot → only mentioned bots answer (capped at 3).
2. No mention → the **lead** bot answers first, then up to 2 others.
3. `@mention` a person → they get an event row on the channel; no loop runs, since a human
   has no agent.
4. Responders are told who else is on the roster so they can hand work over by name, and
   told to `stay_silent` if they have nothing to add.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` (server + web) | pass |
| `npm test -w server` | 14/14 pass (9 pre-existing + 5 team) |
| `npm run build` | pass |
| `/api/health` on 8797 | `{"ok":true,"engine":"hermes"}` |
| Teams view rendered in browser | sidebar island, team tabs, Bots + People sections, lead badge |
| Public bundle | `https://bot-hq-herb.zocomputer.io` serves the Teams build |

## Next

Slice 2 — team brief prepended to every member's group context, and role behavior
(observer bots stay silent unless mentioned). Slice 3 — Macro sub-app: decision pending on
iframe vs. bridging Macro's API in as a bot tool (recon in the conversation workspace).
