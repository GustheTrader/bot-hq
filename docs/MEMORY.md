# Bot HQ — Memory: layers, ontology, Obsidian

Status: built on branch `claude/memory-banks`, not deployed. Nothing changes on Zo until the server is redeployed, and the Obsidian sync stays off until `OBSIDIAN_VAULT` is set.

## Three layers, one bank each

| Layer | Bank in Hindsight | Who reads | Who writes |
|---|---|---|---|
| A bot's own | the bot's HQ id (`bot_…`) | that bot | that bot |
| A team's | the team's id (`team_…`) | every bot on the team | members; **observers read only** |
| Global | `shared` (already live, ~760 facts) | every bot in General | every bot in General, and Hermes' own memory provider |
| A workspace's | the workspace's id (`spc_…`) | the bots of that workspace | the bots of that workspace |

**Workspaces** (`server/src/spaces.ts`): one per business or project. For a bot in a workspace, its bank takes the place of `shared`, so `everyone` means that workspace and nothing is read from or written to the global bank. The primary bot stays in General, reads `shared`, and may join teams in any workspace. A bot's own bank moves with it, including what it learned before the move. App connections, Build-flow and the computer's files are not separated.

Access is worked out from the roster each time (`server/src/memory-banks.ts`), not stored a second time. Another account's bots and teams are never in reach. A bot's or team's bank is created on its first save (`PUT`, idempotent). `shared` is never re-created by the app.

The bank ids are the same HQ ids the unified-memory ontology v1 uses for bot identity, so a later Gnoesis policy can grant banks by bot id without a mapping table.

Each bot's short working notes still live in its Hermes home (`memories/MEMORY.md`, `USER.md`; see `engine-memory.ts`). The banks hold knowledge worth searching later.

### Bot tools

- `memory_recall { query, scope?: all|me|team|everyone, team? }` searches the banks in parallel and groups the results by bank. A bank never written to counts as empty. If one bank fails, the others still answer and the reply says which bank could not be searched.
- `memory_save { text, scope?: me|team|everyone, team?, tags? }` saves to the bot's own bank by default; giving `team` alone saves to that team. A bot on several teams must name the team, by its id when two teams share a name. Text over 8,000 characters is refused (split into separate facts), never cut.

### Automatic team memory

When a RevOpt task is marked **done** (or created already done), its team's bank gets the title, target, Build-flow job, the brief and the outcome. The outcome is the team bots' last two replies in the team channel after the task was dispatched (`rememberDone` and `taskOutcome` in `routes-revopt.ts`). Each task is one document (`revopt-<task id>`), so re-finishing a reopened task replaces its memory. The save is queued in `memory_pending` and retried every 10 minutes until Hindsight takes it, so a brief outage loses nothing and never holds up the status change.

### Memory graph (RevOpt → Memory graph)

The bank picker lists **Global / Teams / Bots**, only for the signed-in person's own banks. Nodes are coloured by ontology type, and the legend hides a type.

## Ontology (`server/src/ontology.ts`)

It extends `Projects/unified-memory/ONTOLOGY.md` (v1, proposed, not deployed): the same Bot, Team, Project and document types and the same relation names. Business types are added.

- **Types:** person, company, deal, project, job (Build-flow), bot, team, decision, task, service, incident, document. Anything else shows as "Entity" until typed.
- **Link fields** (frontmatter): works_at, owns, decided, assigned_to, about, part_of, affects, plus v1's member_of, works_on, belongs_to, authored_by, cites, supports, contradicts, supersedes, derived_from, related_to.
- Hindsight does not store entity types, so `memory_entity_types` keeps them, per account and with note types and `Types.md` types in separate rows (editing one never loses the other). In increasing priority:
  - a name in Build-flow's job-number format (`JOB-1001`, `#3333`) is a job;
  - the account's own bots and teams, by name;
  - typed Obsidian notes, re-derived on every sync: a deleted note stops typing its entity, and when two notes type one name differently the first by path wins and the sync reports the conflict;
  - `Types.md`.
- v1's evidence kinds and lesson promotion stay in Gnoesis. Nothing here validates or promotes.

## Obsidian, both ways (`server/src/obsidian.ts`)

```
<OBSIDIAN_VAULT>/
  workspace/                you write; bots learn it
    Shared/…                → shared
    Workspaces/<workspace name>/… → that workspace's bank (matched by name, any case; not its id)
    Teams/<team name>/…     → that team's bank
    Bots/<bot name>/…       → that bot's bank
  Memory/                   generated; never read back
    Ontology.md
    Shared/, Workspaces/<workspace name>/, Teams/<team>/, Bots/<bot>/   00 <name>.md + <type plural>/<entity>.md
```

- **In:** only changed notes are sent (content hash in `obsidian_notes`). The document id is a hash of the note's path, so an edit **replaces** the old version. A deleted note, or one moved to another bank, is forgotten from the old bank. `type:` and link fields become entity hints plus plain statements ("Dana works at Acme"). Hidden entries and names containing "secret" are skipped. A note over 256 KB, or whose text sent to Hindsight (title, type and relation lines, then the body) is over 60,000 characters, is skipped, and its earlier version is forgotten so nothing stale stays. Each changed note costs one fact-extraction LLM call in Hindsight.
- **Never forgets by accident:** an unreadable folder, or a missing `workspace/` that was synced before, stops the sync with an error. A vault over 4,000 notes is synced up to that point (`truncated` in the result). Notes the partial scan never reached are not forgotten and keep their types; a scanned note can still have its old version forgotten for being too large.
- **Out:** each bank's top entities (250) become typed notes with their facts and path wikilinks to what they come up with, so Obsidian's graph view matches the Memory graph. Only files carrying `generated: bot-hq` are ever written over or removed; somebody's own file at a generated path is left alone and listed as `kept`. Unchanged files are not rewritten. Two labels that clean up to one file name get distinct files (the less-mentioned gets a short entity id). If an entity's facts cannot be read, its existing note is kept as it was.
- **`Types.md`** at the vault root (outside `workspace/`, so never sent into memory): `## <type>` headings (`## People`, `## service`, …) with `- name` lines, and `## ignore` for names to leave out of the graph (Hindsight's `user`, `assistant`). It is the whole of the person's typing. Each sync replaces the earlier entries, so removing a name untypes it, and a retyped entity's note moves folder.
- **Graph colours:** if the vault has no `.obsidian/graph.json`, the export writes one with a colour group per type (`[type:person]`, …) matching the Memory graph, filtered to `Memory/`. Existing graph settings are never touched.
- **Secrets:** a fact is not written to the vault when it looks like a known key or token format (`sk-`, `ghp_`, `zo_sk_`, `AKIA`, JWTs…), a URL with a password, a private key, or a long opaque string: 40+ characters of letters **and digits** with no slash or space. That covers hashes and base64 keys; an all-letter run is not caught, because it is far more often a word or slug. The note says how many were withheld; they stay in Hindsight and the Memory graph.
- The folder is named `Memory/` because the zo-vaults indexer (`Vaults/docs/DESIGN.md`) already skips folders of that name, so generated notes cannot loop back in through that path either.
- Measured against the live `shared` bank on Zo (read-only, scratch copy): 40 entities exported in 3.4 s.

### Turning it on

| env | meaning |
|---|---|
| `OBSIDIAN_VAULT` | the vault folder, e.g. `/home/workspace/Vaults/bot-memory`. Unset = off |
| `OBSIDIAN_SYNC_MINUTES` | background sync interval. Unset/0 = only "Sync now" in the Memory graph. Off when `GROKBOT_NO_SCHEDULER=1` |
| `OBSIDIAN_WORKSPACE` | the account the vault belongs to (account id or email). Default: the only account that has bots; required when there are several |
| `HINDSIGHT_URL` | default `http://127.0.0.1:8888` |

The vault belongs to one account. Only that account's bots, teams, business and project workspaces and `shared` are synced, and only that account (and its team members) sees the sync's details or can start it. Other accounts see that the vault belongs to another account.

Before pointing it into the `zo-vaults` git repo, decide whether `Memory/` is committed. It holds what the bots remember (client names, deal facts), and a commit would push it to GitHub. **This repo does not add any ignore rule there.** To keep it on Zo only, add `bot-memory/Memory/` to the zo-vaults `.gitignore` yourself before the first commit.

API (session-gated, under `/api/revopt`): `GET /memory/banks`, `GET /memory/graph?bank=`, `GET /memory/entities/:id?bank=`, `GET /memory/ontology`, `GET /memory/obsidian`, `POST /memory/obsidian/sync` (202, poll the GET).

## Not done

- Gnoesis `policy.json` still lists only `hermes`, `research-agent` and `coding-agent`. Bot HQ enforces bank access itself; mirroring it into Gnoesis waits for the unified-memory auth work (DO-NOT-DEPLOY today).
- Deleting a bot, team or (empty) workspace leaves its bank in Hindsight.
- Typing is done in `Types.md`; there is no in-app editor for it yet.
