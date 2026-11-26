# Bot HQ — Memory: layers, ontology, Obsidian

Status: built on branch `claude/memory-banks`, not deployed. Nothing changes on Zo until the server is redeployed, and the Obsidian sync stays off until `OBSIDIAN_VAULT` is set.

## Three layers, one bank each

| Layer | Bank in Hindsight | Who reads | Who writes |
|---|---|---|---|
| A bot's own | the bot's HQ id (`bot_…`) | that bot | that bot |
| A team's | the team's id (`team_…`) | every bot on the team | members; **observers read only** |
| Global | `shared` (already live, ~760 facts) | every bot | every bot, and Hermes' own memory provider |

Access is worked out from the roster each time (`server/src/memory-banks.ts`), not stored a second time. Another account's bots and teams are never in reach. A bot's or team's bank is created on its first save (`PUT`, idempotent). `shared` is never re-created by the app.

The bank ids are the same HQ ids the unified-memory ontology v1 uses for bot identity, so a later Gnoesis policy can grant banks by bot id without a mapping table.

Each bot's short working notes still live in its Hermes home (`memories/MEMORY.md`, `USER.md`; see `engine-memory.ts`). The banks hold knowledge worth searching later.

### Bot tools

- `memory_recall { query, scope?: all|me|team|everyone, team? }` searches the banks in parallel and groups the results by bank. A bank never written to counts as empty.
- `memory_save { text, scope?: me|team|everyone, team?, tags? }` saves to the bot's own bank by default. A bot on several teams must name the team.

### Automatic team memory

When a RevOpt task is marked **done**, its title, target, Build-flow job and details are saved to its team's bank in the background (`rememberDone` in `routes-revopt.ts`). A slow store never holds up the status change.

### Memory graph (RevOpt → Memory graph)

The bank picker lists **Global / Teams / Bots**, only for the signed-in person's own banks. Nodes are coloured by ontology type, and the legend hides a type.

## Ontology (`server/src/ontology.ts`)

It extends `Projects/unified-memory/ONTOLOGY.md` (v1, proposed, not deployed): the same Bot, Team, Project and document types and the same relation names. Business types are added.

- **Types:** person, company, deal, project, job (Build-flow), bot, team, decision, task, service, incident, document. Anything else shows as "Entity" until typed.
- **Link fields** (frontmatter): works_at, owns, decided, assigned_to, about, part_of, affects, plus v1's member_of, works_on, belongs_to, authored_by, cites, supports, contradicts, supersedes, derived_from, related_to.
- Hindsight does not store entity types, so `memory_entity_types` keeps them. Sources, in increasing priority: a bare job number is a job; then the app's bots and teams; then typed Obsidian notes; then (later) user edits.
- v1's evidence kinds and lesson promotion stay in Gnoesis. Nothing here validates or promotes.

## Obsidian, both ways (`server/src/obsidian.ts`)

```
<OBSIDIAN_VAULT>/
  workspace/                you write; bots learn it
    Shared/…                → shared
    Teams/<team name>/…     → that team's bank
    Bots/<bot name>/…       → that bot's bank
  Memory/                   generated; never read back
    Ontology.md
    Shared/, Teams/<team>/, Bots/<bot>/   00 <name>.md + <type plural>/<entity>.md
```

- **In:** only changed notes are sent (content hash in `obsidian_notes`). The document id is a hash of the note's path, so an edit **replaces** the old version. A deleted note, or one moved to another bank, is forgotten from the old bank. `type:` and link fields become entity hints plus plain statements ("Dana works at Acme"). Hidden entries, names containing "secret", and notes over 256 KB are skipped. Each changed note costs one fact-extraction LLM call in Hindsight.
- **Out:** each bank's top entities (250) become typed notes with their facts and path wikilinks to what they come up with, so Obsidian's graph view matches the Memory graph. Only files carrying `generated: bot-hq` are ever overwritten or removed. Unchanged files are not rewritten.
- The folder is named `Memory/` because the zo-vaults indexer (`Vaults/docs/DESIGN.md`) already skips folders of that name, so generated notes cannot loop back in through that path either.
- Measured against the live `shared` bank on Zo (read-only, scratch copy): 40 entities exported in 3.4 s.

### Turning it on

| env | meaning |
|---|---|
| `OBSIDIAN_VAULT` | the vault folder, e.g. `/home/workspace/Vaults/bot-memory`. Unset = off |
| `OBSIDIAN_SYNC_MINUTES` | background sync interval. Unset/0 = only "Sync now" in the Memory graph |
| `HINDSIGHT_URL` | default `http://127.0.0.1:8888` |

Before pointing it into the `zo-vaults` git repo, decide whether `Memory/` is committed. It holds what the bots remember (client names, deal facts) and would be pushed to GitHub. `bot-memory/Memory/` in `.gitignore` keeps it on Zo only.

API (session-gated, under `/api/revopt`): `GET /memory/banks`, `GET /memory/graph?bank=`, `GET /memory/entities/:id?bank=`, `GET /memory/ontology`, `GET /memory/obsidian`, `POST /memory/obsidian/sync` (202, poll the GET).

## Not done

- Gnoesis `policy.json` still lists only `hermes`, `research-agent` and `coding-agent`. Bot HQ enforces bank access itself; mirroring it into Gnoesis waits for the unified-memory auth work (DO-NOT-DEPLOY today).
- Deleting a bot or team leaves its bank in Hindsight.
- No UI yet for correcting an entity's type (the table supports `source='user'`).
