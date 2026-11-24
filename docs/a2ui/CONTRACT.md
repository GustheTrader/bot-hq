# A2UI OrderTicket wire contract (PRD v1.1, 1-week MVP)

Shared contract between the Rust durable agent (`agents/a2ui-durable/`) and the
React renderer (`web/src/a2ui/`). Change it only by editing this file first.

## Process + transport
- Binary: `bothq-a2ui-agent` (cargo package in `agents/a2ui-durable/`).
- Flags / env: `--db <path>` (`BOTHQ_A2UI_DB`, default `./data/a2ui-agent.sqlite`),
  `--listen <addr>` (`BOTHQ_A2UI_LISTEN`, default `127.0.0.1:8790`; 8787 is the Node server),
  `--feed kalshi|replay` (`BOTHQ_A2UI_FEED`), `--symbol <KALSHI_TICKER>`, `--replay-file <jsonl>`.
- WebSocket: `GET /a2ui/ws`. Each text frame is exactly ONE A2UI v1.0 message:
  agent→renderer frames validate against `schemas/v1_0/agent_to_renderer.json`,
  renderer→agent frames validate against `schemas/v1_0/renderer_to_agent.json`.
  No custom envelope. Invalid inbound frames get an A2UI `error` back is NOT possible
  (error is renderer→agent only), so the agent logs and drops them.
- Health: `GET /a2ui/health` → `{"sessionId","head","surfaces":[ids],"orders":n,"resumed":bool}`.
- Vite dev proxy: `/a2ui` → `http://127.0.0.1:8790` (ws: true).

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
`submitOrder` function definition: `allowedCallers: rendererOnly`-equivalent per
`catalog_definition.json`, `requiresUserActivation: true`, returns `object`.
(Use the exact field names the v1.0 catalog_definition schema defines.)

Data model (what the client sees — display values only, never account ids, API keys,
venue credentials or raw position records; asserted by tests):
```json
{"ticket":{"symbol":"KX…","side":"buy","quantity":1,"limitPrice":0.50,
           "status":{"state":"idle|editing|submitting|filled|rejected","message":"","orderId":null}},
 "market":{"lastPrice":0.51,"bid":0.50,"ask":0.52,"asOf":"RFC3339","source":"kalshi"},
 "account":{"buyingPower":1000.0,"position":0},
 "session":{"id":"…","resumed":false,"frame":12}}
```
`/account/*` is resolved server-side by the agent from its paper account; the agent
owns those paths and the renderer never writes them.

## Renderer → agent
- Field edits (mid-edit durability): debounced 150 ms `action`
  `{"name":"ticketEdited","surfaceId","sourceComponentId":"root","timestamp","context":{"side","quantity","limitPrice"}}`.
  The agent commits a journal frame, then echoes `updateDataModel` on `/ticket`.
- Submit: only from a real click (user activation):
  `{"version":"1.0","callAgentFunction":{"surfaceId","functionCallId":"<uuid v4>","callFunction":{"@call":"submitOrder","args":{…resolved values…}}}}`.
  If the socket drops before a response, the renderer re-sends the SAME functionCallId
  once after reconnect (the agent dedups).
- Agent reply: `{"version":"1.0","agentFunctionResponse":{"functionCallId","value":{"orderId","state","filledQty","avgPrice","idempotencyKey","duplicate":bool}}}`
  or `{…"error":{"code","message"}}`, plus `updateDataModel` on `/ticket/status` and `/account`.

## Idempotency (FR-6)
`idempotencyKey = "<sessionId>:<frameSequence>"`, where frameSequence is the journal
frame that committed the received call. A repeated functionCallId maps to its original
frame, so it yields the same key. The paper adapter has a UNIQUE index on the key.

## Crash test hooks
`BOTHQ_A2UI_PAUSE_AT=after_render|mid_edit|after_order_placed` makes the agent log
`PAUSE_POINT <name>` to stderr and sleep 30 s at that point, so a test can `kill -9` it there.
