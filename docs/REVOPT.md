# Bot HQ — RevOpt Admin

Status: **shipped** (2026-11-17). The revenue-operations console: a CRM-shaped task catalog,
each task routed to a **team**, worked by that team's bots.

## Why it exists

Bot HQ Teams answer chat messages. RevOpt turns that into an operations queue: you write down the
work (reply to this lead, advance this deal, research this account), pick the team that owns it,
and hit **Dispatch**. Dispatch is the same path a typed message takes — the task is posted into
the team channel and the lead picks it up — so nothing about the roster model changes.

## Data model

One table, `revopt_tasks` (SQLite, same DB as the rest of Bot HQ):

| column | notes |
|---|---|
| `id` | `rev_…` |
| `user_id` | owner; every read is scoped to it |
| `team_id` | FK → `bots(id)` where `kind='team'`; deleting the team cascades the tasks away |
| `kind` | `email` \| `crm` \| `other` |
| `title`, `detail` | the task itself; `detail` is what the bot reads |
| `target` | the counterparty — an email address, domain, or CRM record id (`NOT NULL DEFAULT ''`) |
| `status` | `todo` \| `running` \| `review` \| `done` \| `blocked` |
| `priority` | `low` \| `normal` \| `high` \| `urgent` |
| `payload` | JSON blob for kind-specific fields (subject, threadId, dealStage, …) |
| `created_at`, `updated_at`, `due_at`, `done_at` | timestamps (ms) |

`done_at` is set only while `status='done'` and cleared on any other status, so "when did this
finish" is one column read.

## API

Mounted at `/api/revopt` (`server/src/routes-revopt.ts`), all session-gated:

| method | path | purpose |
|---|---|---|
| `GET` | `/api/revopt/summary` | teams with per-status counts, the enum lists, and `macroUrl` |
| `GET` | `/api/revopt/tasks?team=&status=&kind=` | the queue, ordered by status → priority → due → newest |
| `POST` | `/api/revopt/tasks` | create `{ teamId, kind?, title, detail?, target?, priority?, payload?, dueAt? }` |
| `PATCH` | `/api/revopt/tasks/:id` | update status / priority / title / detail / target / payload |
| `DELETE` | `/api/revopt/tasks/:id` | remove |
| `POST` | `/api/revopt/tasks/:id/dispatch` | post the task into the team channel, start the lead, mark `running` |

A task must name a team the caller owns and carry a non-empty title; `kind`, `status`, and
`priority` are validated against the enums, and a bad value is a 400, not a silent default.

## Dispatch

`POST /tasks/:id/dispatch` builds a one-line brief —

```
[RevOpt task · email · high] Reply to Acme renewal
Target: ops@acme.com
Details: …
```

— appends it to the team channel as a `user` message, bumps the team's unread count, and enqueues
the **lead** bot (falling back to the first bot). The task flips to `running`. From there the
normal team rules apply: the lead may hand it to another member with `post_to_group`.

## UI

`web/src/components/RevOptView.tsx`, reached from the sidebar **RevOpt Admin** island
(`useConfigUI.setView('revopt')`). One screen:

- a row of **team tabs**, each with its open/total counts and member count;
- a status filter (`Open` / `All` / each status);
- an inline **New task** form (team, kind, priority, title, target, detail);
- the task cards, each with **Dispatch**, **Mark done**, **Block**, a reopen/back control, and
  delete;
- a **Macro console** panel (see below).

## Macro console (slice 3)

The panel embeds the Macro desktop frontend in an iframe when the server exposes a reachable URL.
Set `MACRO_TEAM_URL` (server) or `VITE_MACRO_TEAM_URL` (web build) to an HTTPS URL and it renders
beside the queue; with neither set it shows the setup hint instead. This is a build-time constant
on the web side, mirroring `VITE_T3_WORKSPACE_URL`, so changing it needs a redeploy.

**Serving (2026-11-17):** the Zen Macro frontend is now reachable. `macro-desktop-web-build`
finished its nix rebuild and serves on Zen `127.0.0.1:3018` (verified: real HTTP 200 + 5.5 KB
"Macro AI Workspace" HTML). It is exposed to this box over a Zen **reverse SSH tunnel**
(`macro-sshtun` scheduled task: Zen `-R 3020:127.0.0.1:3018` → modal `127.0.0.1:3020`), then
`scripts/macro-gateway.ts` (process service `macro-gateway`, port 8801) rewrites the Host and
Caddy (`macro-workspace-tls`, Caddyfile at `/var/lib/caddy-macro`) terminates TLS on `:8444` with
this box's tailscale cert. `MACRO_TEAM_URL=https://modal.taila95594.ts.net:8444/` is set in `.env`.
Full end-to-end verified from this box: `https://modal.taila95594.ts.net:8444/` → 200 + Macro HTML.

**Caveat:** the revopt iframe in the deployed web app renders a placeholder because the tailnet
`modal.taila95594.ts.net` host is only resolvable/reachable from machines on the tailnet (and the
Caddy `:8444` listener is not exposed through Zo's hosted-service proxy). Any tailnet browser
(both boxes) reaches it fine; a browser outside the tailnet cannot. Serving infrastructure is done;
making the panel render off-tailnet is a separate networking decision.

## Tests

`server/test/revopt.test.ts` — create validates the team and title, status/priority round-trip via
PATCH, `done_at` set/cleared, list filters by team and status, and deleting a team cascades its
tasks. Run with `npm test -w server`.
