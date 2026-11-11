# Architecture

A web app (`web/`) and a Node server (`server/`) sit in front of Hermes agents. Hermes owns each Bot's agent loop, history, memory and model. The server adds the things Hermes does not have: the chat interface, one screen per Bot on a shared Orgo computer, connected apps with approvals, routines, the Library, and voice.

```text
browser ── HTTP + SSE ──► server ── POST /v1/responses ──► Hermes gateway (one per Bot)
   │                        ▲                                   │
   └── WebSocket (VNC) ─────┤◄──────── MCP: POST /mcp/<bot> ────┘
                            └── Orgo computer: one X screen per Bot
```

## Components

| Piece | Where | What it does |
|---|---|---|
| API + realtime | `server/src/routes*.ts`, `lib/hub.ts` | JSON over HTTP, plus one Server-Sent Events stream per user (`GET /api/events`) carrying row updates, live state, roster changes and computer state |
| Turns | `server/src/agent/loop.ts` | Per-Bot serial queue. A turn posts the message to the Bot's Hermes gateway (`/v1/responses`, streaming) and turns the event stream into rows (messages, tool calls) and live state (what the Bot is doing now). Before each turn it makes sure the Bot's screen is ready |
| Engines | `server/src/engine.ts` | Which Hermes runs which Bot. The **primary** engine is the gateway that already runs on the computer; the app only calls its API. A **managed** engine is a Hermes home under `ENGINES_DIR/<botId>` with its own `hermes gateway run`, its own port (from 8650), credentials, model and browser helper (`BH_HOME`). Also: model and provider settings, and opening Hermes' subscription sign-in in a terminal on the Bot's screen |
| App tools | `server/src/mcp.ts`, `agent/tools.ts` | An MCP endpoint per Bot (`POST /mcp/<botId>`, `POST /mcp/primary`; bearer token derived from `SESSION_SECRET`). Tools: `x_search`, `save_file`, routines, tasks, check-ins, `send_to_bot`, group chats, `ask_user`, `request_app_connection`, plus the user's Composio tools |
| Memory | `server/src/engine-memory.ts` | Memory lives in each Bot's Hermes home (`memories/MEMORY.md`, `USER.md`). The app shows the entries and lets the user remove one |
| Screens | `server/src/computer.ts`, `desk.ts`, `box.ts`, `server/box/*` | One Orgo Linux computer; the primary Bot uses the default screen, every other Bot leases an Orgo screen (four per computer). `desk.ts` installs the scripts in `server/box/` under `/opt/hq` and calls them to dress a screen: wallpaper, dock, light theme, a Chrome with its own profile and DevTools port (9200 + display number), and a home screen as the new tab page. `box.ts` runs commands locally (`HQ_LOCAL=1`) or through Orgo's API |
| Viewer | `server/src/vnc.ts` | WebSocket relay between the browser (noVNC) and the screen's VNC server. The server does the VNC auth, so the computer's password never reaches the browser. In *watch* mode, keyboard, pointer and clipboard messages are dropped on the server |
| Apps | `server/src/composio.ts`, `triggers.ts` | Catalog, per-user sessions, connect links, tool execution, and triggers for event routines. Sign-in uses a Composio-managed Google connection |
| Scheduling | `server/src/routines.ts`, `proactive.ts` | Cron routines, event routines, and check-ins for the primary Bot. Each run is a turn |
| Voice | `server/src/voice.ts`, `web/src/voice/*` | Mints short-lived xAI realtime client secrets; the browser connects to xAI directly. The voice agent hands real work to the Bot's turn queue and speaks the result. Also proxies TTS previews and dictation |
| UI | `web/src` | React + zustand. Sidebar, chat with a "thinking" chip that follows the Bot's activity, details panel (screen preview, activity, tasks, Library, engine), settings, viewer, voice call bar |

## The primary engine

The first Bot is bound to a Hermes gateway the app did not start. The rules:

- The app never restarts it, stops it, or writes its `config.yaml`. Giving it the app's tools is a separate, explicit step (`scripts/add-hq-to-hermes.py`), which adds one `mcp_servers.hq` entry and keeps a copy of the file. Hermes loads the change without a restart.
- If that agent already has its own Chrome (`PRIMARY_CDP_URL`), the app never starts, stops or reconfigures it. The home screen still arrives there, through a Chrome policy that installs the home-screen extension.
- Its other sessions (iMessage, Telegram, cron) see the same tools. When one of those sessions calls a tool that needs approval, the card shows up in the app.

## Screens and browsers

Each managed Bot's Chrome is started by the app on that Bot's screen and its Hermes config points at that Chrome's DevTools port, so browsing is visible in the viewer. Two details matter:

- Hermes' browser tool finds its helper process under `BH_HOME`. Every managed gateway gets its own, otherwise all agents on the computer would drive one browser.
- A screen is dressed before the Bot's first turn (`screenForWork`), so the agent never finds an empty screen and starts a stray browser.

Hermes can also run a private "Bot Desktop" for an agent. While it is on, that agent's desktop work happens there and not on the screen the app shows; the engine panel reports this and offers a button to switch it off.

## Transcript model

A conversation is an append-mostly list of **rows**: `seq` (position), `updatedSeq` (a per-Bot revision counter), `kind` and a JSON `body`. A streaming reply is the same row rewritten with a higher `updatedSeq`, so clients upsert by `seq`. A per-Bot `generation` counter starts a new conversation (and a new Hermes session).

Row kinds: `message` (user or assistant, optionally from another Bot or a voice call), `tool-call` (shown as an activity line and a collapsible step list), `card` (approval, question, connect, draft), `event`, `notice`.

The model's own history is Hermes' business; the app keeps only what it shows.

## Approvals

Approvals happen inside the MCP call, so they work the same for every engine:

- Composio tools that only read run at once.
- Anything else posts an **approval card** and the tool call waits. **Allow** runs it once, **Always allow** stores a per-tool policy, **Don't allow** returns a refusal that tells the agent not to retry.
- A new user message, or no answer in time, closes the card and the call returns "skipped".

Not covered: what a Bot does through its browser or shell, and Hermes' own prompts for risky commands.

## Bots working together

- **`send_to_bot`** delivers a message to another Bot's queue; the reply comes back the same way.
- **Group chats** are a Bot row with `kind='room'` and a member list. A user message goes to the @mentioned members, or to all of them (up to 3).
- For work inside one task, Hermes' own delegation is used.

## Data

SQLite (`DB_PATH`, WAL): users and sessions, Bots, rows, approvals and policies, routines, tasks, skills, screen leases, Composio session ids. Each managed Bot's Hermes home is under `ENGINES_DIR`. On the computer: Chrome profiles in `/root/grokbot/profiles/<botId>`, Library files in `/root/grokbot/files/<botId>`. Deleting a Bot removes its gateway, home, profile, files and screen.

Secrets live in `.env` on the server and in each Hermes home.

## External services

| Service | Used for |
|---|---|
| Hermes Agent | The agent loop, tools, memory and model access for every Bot (API keys or subscription sign-ins) |
| Orgo | The computer, its screens, VNC, and a public URL for the app |
| Composio | Sign-in, connectors, triggers |
| xAI | Research on X (`x_search`), realtime voice, TTS, dictation |
