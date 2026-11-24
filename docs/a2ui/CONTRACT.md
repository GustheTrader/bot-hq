# A2UI OrderTicket wire contract (PRD v1.1, 1-week MVP)

Shared contract between the Rust durable agent (`agents/a2ui-durable/`) and the
React renderer (`web/src/a2ui/`). Change it only by editing this file first.

## Process + transport
- Binary: `bothq-a2ui-agent` (cargo package in `agents/a2ui-durable/`).
- Flags / env: `--db <path>` (`BOTHQ_A2UI_DB`, default `./data/a2ui-agent.sqlite`),
  `--listen <addr>` (`BOTHQ_A2UI_LISTEN`, default `127.0.0.1:8790`; 8787 is the Node server),
  `--feed kalshi|replay` (`BOTHQ_A2UI_FEED`, default `kalshi`), `--symbol <KALSHI_TICKER>`, `--replay-file <jsonl>`.
  Extras (agent side): `--poll-ms` (Kalshi poll, default 1000), `--replay-interval-ms` (default 1000),
  subcommand `record --out <jsonl> [--symbol] [--count] [--interval-ms]` to record real Kalshi responses.
- WebSocket: `GET /a2ui/ws`. Each text frame is exactly ONE A2UI v1.0 message:
  agent→renderer frames validate against `schemas/v1_0/agent_to_renderer.json`,
  renderer→agent frames validate against `schemas/v1_0/renderer_to_agent.json`.
  No custom envelope. Invalid inbound frames get an A2UI `error` back is NOT possible
  (error is renderer→agent only), so the agent logs and drops them.
- Health: `GET /a2ui/health` → `{"sessionId","head","surfaces":[ids],"orders":n,"resumed":bool}`.
- Vite dev proxy: `/a2ui/` → `http://127.0.0.1:8790` (ws: true).
- Production: the Node server (`server/src/a2ui-relay.ts`) relays `/a2ui/ws` and `/a2ui/health` to
  `BOTHQ_A2UI_AGENT_URL` (default `http://127.0.0.1:8790`), verbatim, and only for signed-in users (401 otherwise).

## Reconnect / snapshot replay (FR-5)
- On every new socket the agent sends, per live surface: one `createSurface`
  carrying `catalogId`, the full current `components` and the full current `dataModel`.
- The renderer, on every (re)connect, DROPS all locally held surfaces before applying
  messages from the new socket. So a replayed `createSurface` never duplicates a ticket.
- Renderer reconnects with backoff (250 ms → 2 s cap) forever.

## Catalog `bothq.trading.v0` (FR-4)
One component, `OrderTicket`, always with `id: "root"`:
```json
{"id":"root","component":"OrderTicket",
 "symbol":{"@path":"/ticket/symbol"},
 "side":{"@path":"/ticket/side"},              // "buy" | "sell"  (YES contracts)
 "quantity":{"@path":"/ticket/quantity"},      // integer contracts
 "limitPrice":{"@path":"/ticket/limitPrice"},  // dollars, 0.01..0.99
 "livePrice":{"@path":"/market/lastPrice"},    // dollars (YES mid from the feed)
 "buyingPower":{"@path":"/account/buyingPower"},
 "position":{"@path":"/account/position"},
 "status":{"@path":"/ticket/status"},          // object, see below
 "submit":{"functionCall":{"@call":"submitOrder","args":{
     "symbol":{"@path":"/ticket/symbol"},"side":{"@path":"/ticket/side"},
     "quantity":{"@path":"/ticket/quantity"},"limitPrice":{"@path":"/ticket/limitPrice"}}}}}
```
`submitOrder` function definition (`agents/a2ui-durable/catalog/bothq.trading.v0.json`):
`"allowedCallers": "rendererOnly"`, `"requiresUserActivation": true`, `"returnType": "object"`
(the exact v1.0 `catalog_definition.json` field names; the catalog validates against it in `cargo test`).
The catalog has no `$id`: it is registered in place of the envelope's sibling `catalog.json`.

If the feed's market changes (for example a different `--symbol` after a restart), the agent sends
`deleteSurface` for the old ticket and `createSurface` for a new `surfaceId`. On resume, a surface whose
journaled component tree differs from the current build gets an `updateComponents`.

Data model (what the client sees — display values only, never account ids, API keys,
venue credentials or raw position records; asserted by tests):
```json
{"ticket":{"symbol":"KX…","side":"buy","quantity":1,"limitPrice":0.50,
           "status":{"state":"idle|editing|submitting|filled|rejected","message":"","orderId":null}},
 "market":{"lastPrice":0.51,"bid":0.50,"ask":0.52,"asOf":"RFC3339","source":"kalshi"},   // source "kalshi-replay" in replay
 "account":{"buyingPower":1000.0,"position":0},
 "session":{"id":"…","resumed":false,"frame":12}}
```
`/account/*` is resolved server-side by the agent from its paper account; the agent
owns those paths and the renderer never writes them.
`market.lastPrice` is the YES mid when the book is two-sided, else Kalshi's last trade. `asOf` is when
the quote was observed (in replay: when it was recorded, not when it was replayed).

## Renderer → agent
- Field edits (mid-edit durability): debounced 150 ms `action`
  `{"name":"ticketEdited","surfaceId","sourceComponentId":"root","timestamp","context":{"side","quantity","limitPrice"}}`.
  The agent commits a journal frame, then echoes `updateDataModel` on `/ticket`.
- Submit: only from a real click (user activation):
  `{"version":"1.0","callAgentFunction":{"surfaceId","functionCallId":"<uuid v4>","callFunction":{"@call":"submitOrder","args":{…resolved values…,"userActivation":{…}}}}}`.
  **User-activation evidence (required, agent-enforced).** The agent cannot observe a click over a
  WebSocket, and the v1.0 schemas leave no other field for it (`callAgentFunction` and `FunctionCall`
  are closed), so the catalog's `submitOrder.args` defines an optional `userActivation` object that the
  renderer fills from the trusted DOM event of the click: `{"type":"click","isTrusted":true,"timestamp":"RFC3339"}`
  (`type` is one of `click|keydown|pointerup|touchend`). It is not one of the component's bound args.
  The agent rejects a new call without it, with `isTrusted` not `true`, or with a timestamp more than
  120 s old (or 30 s in the future): `error.code = "USER_ACTIVATION_REQUIRED"`. A re-sent
  `functionCallId` is deduplicated *before* this check, so the once-after-reconnect re-send still gets
  its original answer. Other agent-side error codes: `CALLER_NOT_ALLOWED` (rendererOnly; the agent never
  invokes it), `UNKNOWN_SURFACE`, `SYMBOL_MISMATCH`, `INVALID_ARGS` (args must be resolved literals),
  `CATALOG_MISMATCH`, `UNKNOWN_FUNCTION`.
  If the socket drops before a response, the renderer re-sends the SAME functionCallId
  once after reconnect (the agent dedups).
- Agent reply: `{"version":"1.0","agentFunctionResponse":{"functionCallId","value":{"orderId","state","filledQty","avgPrice","idempotencyKey","duplicate":bool,"message"}}}`
  (`state` = `filled|partially_filled|rejected`, the paper fill decision; `message` = its reason;
  `/ticket/status.state` becomes `filled` when `filledQty > 0`, else `rejected`)
  or `{…"error":{"code","message"}}`, plus `updateDataModel` on `/ticket/status` and `/account`.

## Idempotency (FR-6)
`idempotencyKey = "<sessionId>:<frameSequence>"`, where frameSequence is the journal
frame that committed the received call. A repeated functionCallId maps to its original
frame, so it yields the same key. The paper adapter has a UNIQUE index on the key.

## Crash test hooks
`BOTHQ_A2UI_PAUSE_AT=after_render|mid_edit|after_order_placed` makes the agent log
`PAUSE_POINT <name>` to stderr and sleep 30 s at that point, so a test can `kill -9` it there.
Each fires once per process. `after_render`: a `createSurface` was handed to a connected socket.
`mid_edit`: a `ticketEdited` frame is committed, echo not yet sent. `after_order_placed`: the paper order
row exists, the answer frame is not committed. Extension: `after_call_received` (the call frame is
committed, no order placed yet). `BOTHQ_A2UI_PAUSE_SECS` overrides the 30 s.
