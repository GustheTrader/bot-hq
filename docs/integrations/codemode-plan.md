# Code Mode for Bot HQ's MCP tool loops

Status: **pilot built 2026-11-24** on branch `claude/codemode-pilot`, not deployed to Bot HQ yet.
- Executor: Zo process service `bothq-codemode` (`svc_0PQTPbgoCOo`), `wrangler dev` on **127.0.0.1:8792** (8790 is taken by another app), calling Bot HQ back on 8797. Secret in `/root/.codemode/secret`.
- Checked in a real isolate: typed API generated, scripts run, tool callbacks work, `fetch()` is blocked, unknown tools and wrong secrets refused.
- Bot HQ side: `server/src/codemode.ts`, `mcp.ts` (run_code + `POST /mcp/:bot/inner`), `bots.code_mode`, Engine panel switch. 9/9 tests in `server/test/codemode.test.ts` pass on Zo.
- To turn on: deploy Bot HQ, add `CODEMODE_URL=http://127.0.0.1:8792` and `CODEMODE_SECRET_FILE=/root/.codemode/secret` to its `.env`, then switch Code Mode on for one bot.
- Differences from the plan below: the types come from the executor (the codemode package imports `cloudflare:workers`, so Node can't load it); Composio meta-tools stay listed directly **and** are callable from scripts, but an app action whose policy is "ask" is refused inside a script.

Written 2026-11-24.

## The idea (Cloudflare "Code Mode")

The usual setup gives the model every tool and calls them one at a time: model → tool → result back into context → model → next tool. Code Mode gives the model **one tool, `run_code`**, together with a TypeScript description of all the tools (`declare const hq: { buildflow_jobs(input: {...}): Promise<...>; ... }`). The model writes a short script that chains, loops and filters tool calls. The script runs in a sandbox, and only its final `return` value goes back to the model.

Why it helps Bot HQ in particular:
- `/mcp/<botId>` lists all of the app's ~30 tools **plus every Composio tool** the user has connected. That's a lot of JSON schema sent on every turn, and Code Mode replaces it with one compact typed API.
- Multi-step work (for example "find every job with no daily log this week and draft a log for each") is one model step instead of N loop round-trips.
- It fits with 9Router: the open-weight `hq-free` / `hq-smart` models are much better at writing TypeScript than at long chains of tool calls.

Cloudflare package: `@cloudflare/codemode` (labelled **experimental**). The relevant pieces:
- `generateTypesFromJsonSchema(tools)` builds the TypeScript declarations.
- `DynamicWorkerExecutor({ loader, timeout, globalOutbound: null })` runs code in a fresh V8 isolate with no network access.
- `ToolDispatcher` (Workers RPC) is how sandboxed code calls back into the host.
- `codeMcpServer({ server, executor })` wraps an MCP SDK server in a single `code` tool.

The sandbox requires the **Worker Loader** binding (`"worker_loaders": [{ "binding": "LOADER" }]`). It runs on Cloudflare, or locally under `wrangler dev` / `workerd`. Last public word: closed beta, pricing not set. Check current status before relying on the hosted version.

## Where it plugs in

Every harness (Hermes, Claude Code, Codex, Pi, OpenCode) reaches the app's tools through **one place**: `server/src/mcp.ts` (`tools/list` → `listTools`, `tools/call` → `callTool`). Code Mode added there works for all bots and all harnesses at once, with no harness changes.

```
Harness loop ──tools/call run_code {code}──▶ Bot HQ /mcp/<botId>
                                               │ POST {code, types, callToken}
                                               ▼
                                    codemode Worker (workerd on Zo → later Cloudflare)
                                      DynamicWorkerExecutor, globalOutbound:null
                                      sandbox: hq.buildflow_jobs(...) ──RPC──▶ host Worker
                                               │ POST /mcp/<botId>/inner  (per-run token)
                                               ▼
                                    Bot HQ callTool(...)  (same policy/approvals/rows)
```

## Design decisions

1. **Per-bot switch, off by default.** A `bots.code_mode` column. When it's on, `tools/list` returns `run_code` plus a few **direct** tools that must stay direct: `ask_user`, `stay_silent`, `request_app_connection`, and every tool whose `policyFor` is `ask`. Approvals can wait for minutes, longer than a sandbox run, so anything that needs approval stays a normal tool call the user sees.
2. **Types are generated in Bot HQ** from the same list `listTools` builds, cached per bot plus Composio connection set. Composio tools go in under `apps.*` and the app's own under `hq.*`. If the declarations get too long, `run_code` lists only names and one-line descriptions, and the sandbox gets `hq.describe(name)` to fetch one tool's full type on demand.
3. **Inner calls need their own path.** `callTool` → `claimToolRow` waits up to 600 ms for a tool-call row that Hermes streamed. Calls made from inside a script have no such row, so each one would stall 600 ms and leave no trace. Add `callToolInner(botId, parentSeq, name, args)`: it skips the claim, appends the inner call as a child line on the `run_code` row ("ran 7 tools: buildflow_jobs ×1, buildflow_add_daily_log ×6"), and keeps `policyFor` / `block` checks.
4. **Callback auth:** each `run_code` mints a short-lived HMAC token (bot id + run id + expiry, signed with `sessionSecret`), accepted only by `POST /mcp/<botId>/inner`. The bot's long-lived MCP token never leaves Bot HQ.
5. **Limits:** 30 s timeout, at most 50 inner calls per run, 20 KB cap on the returned value (larger results are truncated with a note), `console.log` output returned as `logs`.

## Executor: run it on Zo first, Cloudflare later

| Option | Isolation | Cost / risk | Verdict |
|---|---|---|---|
| A. `workerd` on Zo (process service, 127.0.0.1) running the codemode Worker | Real V8 isolates, network blocked | Free, no Cloudflare account; Worker Loader is supported locally | **Start here** |
| B. Same Worker deployed to Cloudflare | Same, plus Cloudflare's edge | Beta/pricing unknown; each inner call goes Worker → Vercel → Zo | Switch by changing `CODEMODE_URL` once the GA terms are known |
| C. In-process Node sandbox (QuickJS/isolated-vm) | Weaker, runs in Bot HQ's process | No extra service | Fallback only |

A and B run **the same Worker code**. Bot HQ only knows `CODEMODE_URL` + `CODEMODE_SECRET`.

## Build steps

1. `codemode/` (new Wrangler project): a host Worker with `worker_loaders` + `DynamicWorkerExecutor`, a `ToolDispatcher` that forwards `call(name, args)` to `POST {HQ}/mcp/<botId>/inner` with the run token, and `POST /run {code, types, botId, token}` → `{result, error, logs}`. Pin `@cloudflare/codemode` and `wrangler` versions.
2. Zo: `npx wrangler dev --ip 127.0.0.1 --port 8790` (or plain `workerd serve`) as process service `codemode`. This uses no web-service slot.
3. `server/src/codemode.ts`: type generation + cache, run-token mint/verify, `runCode(botId, parentSeq, code)` → HTTP to the executor.
4. `server/src/mcp.ts`: `listTools` returns the code-mode set when `code_mode` is on, `run_code` is handled in `callTool`, and the new route is `POST /mcp/:bot/inner`.
5. `server/src/agent/loop.ts` / `tools.ts`: `callToolInner` + child lines on the `run_code` row; `activityFor('run_code')` → "Running a script".
6. Settings → bot's Engine panel: a "Code Mode" toggle.
7. Tests: types generated for app tools plus a fake Composio tool; an expired or wrong run token is rejected; an inner call to a `block` tool returns DECLINED; an inner call to an `ask` tool is refused with "call it directly"; and an end-to-end script on a test bot gets its inner calls attached to the parent row.

## Open questions

- The exact export path of `DynamicWorkerExecutor` and `generateTypesFromJsonSchema` in the current `@cloudflare/codemode` release. The docs list the names but not every import path. Confirm on install.
- Whether `workerd`'s Worker Loader works outside `wrangler dev` in the pinned version.
- Whether to pilot on one bot with an `hq-smart` model first and compare tokens per turn against direct tool calls before rolling it out.
