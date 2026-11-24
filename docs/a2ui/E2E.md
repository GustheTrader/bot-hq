# A2UI durable agent: crash E2E and latency measurement

PRD v1.1 Day 5. These scripts treat the real `bothq-a2ui-agent` binary as a black box. They
talk to it only through the wire contract in [CONTRACT.md](CONTRACT.md): WebSocket `/a2ui/ws`
carrying raw A2UI v1.0 frames, and `GET /a2ui/health`.

| File | Purpose |
|---|---|
| `scripts/a2ui-crash-e2e.mjs` | A scripted renderer. Runs the kill -9 test at three kill points, then prints a latency report. |
| `scripts/a2ui-latency.mjs` | Runs only the latency report (same as `--mode latency`). |
| `.github/workflows/a2ui-durable.yml` | CI. Runs `cargo test`, then a release build, then the web typecheck and renderer test, then the crash E2E against the release binary. |

## Running it

Prerequisites: Node 22 or newer (it uses the global `WebSocket` and `fetch`), and a built
agent. `npm ci` at the repo root is optional. If it has been run, the script finds `ajv` and
`ajv-formats` (web devDependencies) and also validates every frame against the full JSON
Schema.

```bash
cd agents/a2ui-durable && cargo build --release && cd ../..

node scripts/a2ui-crash-e2e.mjs                      # 3 kill points + latency report
node scripts/a2ui-crash-e2e.mjs --mode crash         # crash test only (the CI gate)
node scripts/a2ui-crash-e2e.mjs --points mid_edit    # a single kill point
node scripts/a2ui-latency.mjs --samples 100 --submits 50
```

| Option | Env | Default |
|---|---|---|
| `--bin <path>` | `BOTHQ_A2UI_BIN` | `agents/a2ui-durable/target/release/bothq-a2ui-agent`, then `target/debug/` |
| `--fixture <jsonl>` | `BOTHQ_A2UI_FIXTURE` | first `*.jsonl` found under `agents/a2ui-durable/fixtures/` (sorted) |
| `--mode all\|crash\|latency` | `A2UI_E2E_MODE` | `all` |
| `--points a,b` | `A2UI_E2E_POINTS` | `after_render,mid_edit,after_order_placed` |
| `--samples <n>` | `A2UI_LAT_SAMPLES` | 30 `/market` updates. The agent only pushes *changed* quotes, so a short fixture gives fewer; the report shows how many it got. |
| `--replay-interval-ms <n>` | `A2UI_LAT_REPLAY_MS` | 100. This is the agent's replay pace for the latency run only. The crash run keeps the agent default (1000). |
| `--submits <n>` | `A2UI_LAT_SUBMITS` | 20 submit round trips |
| `--keep` | | keep the temp DBs and agent logs (the path is printed; they are always kept on failure) |
| `--require-schema` | | exit 2 if `ajv` cannot be loaded, instead of falling back to shape checks (CI sets this) |
| | `A2UI_AGENT_ARGS` | extra agent flags, for example `--symbol KX...` |

Each run starts the agent with `--feed replay --replay-file <fixture> --db <fresh temp sqlite>
--listen 127.0.0.1:<free port>`, so it needs no network access and no Kalshi key. Exit code:
0 if every check passes, 1 if any crash check fails, 2 for a usage or setup error (for example,
no binary). The latency numbers never affect the exit code.

## What one kill point does

For each kill point, the script runs these steps:

1. Creates a fresh temp DB and a free port, then spawns the agent with `BOTHQ_A2UI_PAUSE_AT=<point>`.
2. Checks `/a2ui/health` (`orders=0`, `resumed=false`) and connects to `/a2ui/ws` as a renderer.
3. Drives the flow to the kill point:
   - `after_render`: connects and receives `createSurface`. It sends nothing else.
   - `mid_edit`: sends a `ticketEdited` action with a buy, quantity 3, and a limit at the
     market ask. These values are chosen to differ from the ticket defaults.
   - `after_order_placed`: sends the same edit, waits for the `/ticket` echo, then sends
     `callAgentFunction(submitOrder)` with a new uuid v4 `functionCallId`.

   Every submit carries `args.userActivation = {type:"click", isTrusted:true, timestamp:<now>}`.
   This is the catalog's `UserActivation` evidence for `requiresUserActivation: true`. The agent
   rejects a *new* call with `USER_ACTIVATION_REQUIRED` if the evidence is missing, untrusted,
   or older than 120 s. A repeated `functionCallId` is answered from the journal before that
   check, so the script re-sends the byte-identical stored frame, as `web/src/a2ui/client.ts`
   does.
4. Waits for `PAUSE_POINT <point>` on stderr, then sends **SIGKILL**.
5. Restarts the agent on the **same DB**, without `PAUSE_AT`, and opens a new socket (it retries
   the connection every 25 ms). It measures the time from spawn to receiving the replayed
   `createSurface`. The **budget is 5 s**.
6. Asserts the following:
   - The snapshot is a full OrderTicket: `catalogId`, a root `OrderTicket`, every `@path`
     binding, and `ticket`/`market`/`account` in the data model.
   - Exactly one `createSurface` arrives per surface.
   - The `surfaceId` and `sessionId` are unchanged, and `resumed=true` in both health and
     `/session/resumed`.
   - For `mid_edit` and `after_order_placed`, the edits are restored exactly.
7. Checks for duplicate orders:
   - `after_order_placed`: health reports `orders=1`. The script re-sends the **same**
     `functionCallId`, as the renderer does after a reconnect. The reply must be a value with
     `duplicate:true` (or the same `orderId`/`idempotencyKey` as a reply seen before the kill),
     with `idempotencyKey = <sessionId>:<frame>`. Health still reports `orders=1`.
   - `after_render` and `mid_edit`: health reports `orders=0`. The script then submits on the
     resumed session and checks the following:
     - the reply has an `orderId` and `duplicate:false`. The limit is re-priced to the latest
       ask + 0.02, because the paper adapter is IOC against the live quote.
     - a terminal `/ticket/status` (`filled`, `partially_filled` or `rejected`) arrives,
       carrying that `orderId`. The order's outcome is printed as an `info` row.
     - health reports `orders=1`
     - repeating the same call returns `duplicate:true` with the same `orderId`, and health
       still reports `orders=1`
8. Validates every frame, sent and received:
   - When ajv is available, it validates against the official
     `agent_to_renderer.json`/`renderer_to_agent.json`, with the agent's
     `catalog/bothq.trading.v0.json` registered as `catalog.json`. This is the same
     substitution `web/test/a2ui.test.ts` uses.
   - It always runs the shape check.
   - It scans every client-bound frame for key names that look like secrets or account ids
     (`apiKey`, `secret`, `privateKey`, `password`, `accountId`, and similar).

The script prints one row per check (`KILL POINT | CHECK | PASS/FAIL/info | detail`), then a
summary with the resume time for each kill point.

### What each kill point proves

| Kill point | Where the process dies | What survival proves |
|---|---|---|
| `after_render` | The surface is committed and rendered. The user has done nothing. | The surface store is persisted with the frame. Resume replays a complete snapshot (components and the current data model) onto a new socket. A fresh session can still take exactly one order. |
| `mid_edit` | A `ticketEdited` frame is committed, but the echo or next step has not happened. | User input is durable once the agent has committed it. The resumed ticket shows the user's values, not the defaults. |
| `after_order_placed` | The paper adapter has placed the order, but the `agentFunctionResponse` has not been sent. This is the most dangerous window. | FR-6: the renderer re-sends the call, which maps to the original frame, which maps to the same idempotency key. The UNIQUE key in the paper adapter returns the existing order. The user gets an answer, and `orders` stays at 1. |

## Mapping to the PRD success criteria (section 3)

| # | Criterion | Where it is proven |
|---|---|---|
| 1 | **Render**: `createSurface` with inline components and dataModel renders OrderTicket | Agent: `cargo test` lifecycle tests. Wire: every replayed `createSurface` passes `checkOrderTicket`. Browser: web renderer test (`npm run test:a2ui -w web`) and the live demo. |
| 2 | **Update**: live price through `updateDataModel` without rebuilding the surface | Wire: the latency run receives N `updateDataModel` frames on `/market...` from the replay feed, and the crash run asserts exactly one `createSurface` per surface on each socket. Browser: web renderer test. |
| 3 | **Submit**: click, then `callAgentFunction(submitOrder)`, then `agentFunctionResponse` shown on the ticket | Wire: the after-resume submit in `after_render` and `mid_edit` (reply value and `/ticket` status update). User activation and `allowedCallers` are catalog and renderer rules, covered by the Rust and web tests. |
| 4 | **Crash-resume**: kill -9 at three points, restored within 5 s, zero duplicate orders | `scripts/a2ui-crash-e2e.mjs --mode crash`, the CI gate. |
| 5 | **Valid**: every message passes the official A2UI v1.0 schemas | `cargo test` validates every frame the agent emits against `schemas/v1_0/*.json` with the `jsonschema` crate. The agent also validates before each commit. The E2E validates every frame that actually crossed the wire, in both directions, with ajv (draft 2020-12, with the `bothq.trading.v0` catalog substituted). `--require-schema` in CI makes this mandatory. |

**Validation scope.** Without `npm ci`, ajv is not installed and the E2E falls back to the
shape check alone. It prints `schema: shape checks only (...)` and adds an info row per kill
point. The shape check covers the following:

- the `version` const
- exactly one message key
- required fields and `additionalProperties:false` for each message type
- the `value`/`error` exclusivity in `agentFunctionResponse`
- no `callRendererFunction` (deferred)
- the OrderTicket bindings

CI always runs the full schema validation.

## Latency measurement (NFR, print-only)

The latency run uses one agent with no pause and a fresh DB.

- **Feed tick to client receive.** For each `/market` `updateDataModel`, the script reads a
  timestamp from the frame (`asOf`, or any `*At`/`*Time`/`*Ts` field) and subtracts it from the
  client's wall clock when the frame arrives. This only counts if the timestamp has sub-second
  precision and is within 60 s of the wall clock. In replay mode, `asOf` may be the fixture's
  original exchange time instead of the emit time. In that case the metric is reported as
  "not measurable" with the reason, rather than as a misleading number.
- **Submit WS round trip.** The time from sending `callAgentFunction` to receiving the matching
  `agentFunctionResponse`. It includes the journal commit (SQLite WAL, `synchronous=FULL`, one
  fsync per frame) and the paper fill. Samples come from the after-resume submits plus
  `--submits` extra submits.
- **Context only.** The inter-arrival time of `/market` updates, which shows the pacing of the
  replay feed.

Results are reported as p50, p95 and max against a **< 100 ms target, which is not a gate**
(PRD section 7 and section 4). A formal SLO is in the follow-up backlog.

## Last local run (2026-11-24, real binary, release build)

Command: `node scripts/a2ui-crash-e2e.mjs --require-schema`
Setup: fixture `kalshi_20261124_primary.jsonl` (68 real Kalshi responses); every frame validated
with ajv.

| Kill point | Result | Checks | Restart → replayed createSurface |
|---|---|---|---|
| after_render | PASS | 20/20 | 36 ms |
| mid_edit | PASS | 22/22 | 38 ms |
| after_order_placed | PASS | 22/22 | 64 ms |

Latency (print-only, target < 100 ms):

| Metric | n | p50 | p95 | max |
|---|---|---|---|---|
| submit WS round trip (`callAgentFunction` → `agentFunctionResponse`) | 22 | 45.2 ms | 57.4 ms | 57.9 ms |
| feed tick → client receive | not measurable | | | |

Feed tick to client receive could not be measured. In replay, `/market/asOf` is the recorded
exchange time (minutes old), and the frame carries no emit timestamp. Backlog B11 adds a
ms-precision `serverTime`.

Paper outcomes in this run were `rejected` ("no displayed size at the touch"). The first
seconds of the primary fixture quote an ask size of 0.01 contracts, which is less than one
whole contract, so the IOC fill rule correctly refuses. This does not affect any durability
check: the order is still placed once, journaled, deduplicated, and shown on the ticket.
