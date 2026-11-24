# bothq-a2ui-agent

The Rust side of PRD v1.1 ("A2UI 1.0 with durable agents"). It is a durable agent that does the following:

- **Journal.** Commits every inbound event and every outbound A2UI effect to an `rpi-durable`
  SQLite journal (WAL, `synchronous=FULL`) before it acts.
- **OrderTicket surface.** Drives one A2UI v1.0 `OrderTicket` surface (catalog `bothq.trading.v0`)
  over an Axum WebSocket.
- **Live prices.** Prices come from the public Kalshi REST API, or from a replay of recorded real
  Kalshi responses.
- **Paper orders.** Fills **paper** orders, deduplicated on `<sessionId>:<frameSequence>`.

The wire contract is in [`docs/a2ui/CONTRACT.md`](../../docs/a2ui/CONTRACT.md). The Day-1 decision
(why `rpi-durable` is used directly and the emitter is hand-rolled) is in
[`docs/a2ui/ADR-001-authoring-layer.md`](../../docs/a2ui/ADR-001-authoring-layer.md).

## Run

```bash
cd agents/a2ui-durable
cargo run --release                                   # live Kalshi, auto-picks a liquid open market
cargo run --release -- --symbol KXNCAAMBGAME-26NOV24PROVARIZ-ARIZ
cargo run --release -- --feed replay --replay-file fixtures/kalshi_20261124_primary.jsonl   # offline
cargo run --release -- record --out my.jsonl --count 60 --interval-ms 2000 [--symbol T]       # record real responses
curl -s 127.0.0.1:8790/a2ui/health
```

| Flag | Env | Default |
|---|---|---|
| `--db <path>` | `BOTHQ_A2UI_DB` | `./data/a2ui-agent.sqlite` (journal and `paper_orders` in one file) |
| `--listen <addr>` | `BOTHQ_A2UI_LISTEN` | `127.0.0.1:8790` |
| `--feed kalshi\|replay` | `BOTHQ_A2UI_FEED` | `kalshi` |
| `--symbol <ticker>` | `BOTHQ_A2UI_SYMBOL` | the resumed ticket's market, else the open two-sided binary market with the highest 24h volume that closes more than 1 h from now (`GET /markets?status=open&mve_filter=exclude`). In replay it filters the file. |
| `--replay-file <jsonl>` | `BOTHQ_A2UI_REPLAY_FILE` | (required for replay) |
| `--poll-ms` / `--replay-interval-ms` | `BOTHQ_A2UI_POLL_MS` / `BOTHQ_A2UI_REPLAY_INTERVAL_MS` | 1000 / 1000 |
| `--kalshi-base` | `BOTHQ_A2UI_KALSHI_BASE` | `https://api.elections.kalshi.com/trade-api/v2` |
| crash hooks | `BOTHQ_A2UI_PAUSE_AT`, `BOTHQ_A2UI_PAUSE_SECS` | off, 30 s |
| logs | `RUST_LOG`, `BOTHQ_A2UI_LOG_FORMAT=json` | `info`, text on stderr |

The Kalshi feed needs no key. Prices are read from the `*_dollars` strings (`yes_bid_dollars`,
`yes_ask_dollars`, `last_price_dollars`) and sizes from the `*_fp` strings. Legacy integer cents are
rejected. Retries cover this API's occasional connection resets. A quote is journaled and pushed
(`updateDataModel` on `/market`) only when the book changes.

## How durability works

- **Frames carry their effects.** Each journal frame (`a2ui.*` kinds, `src/agent.rs`) stores the
  exact `agent_to_renderer` messages it causes, in `effects`.
- **One fold for live and replay.** The surface store, ticket edits and function calls are rebuilt
  by folding the frames (`State::apply`). The same fold runs live and on restart.
- **Snapshot on connect.** A new socket gets one `createSurface` per live surface, carrying the
  full components and the current data model. `/session/resumed` is `true` after a restart.
- **The call frame names the key.** `submitOrder` commits `a2ui.inbound.call` first. That frame's
  sequence forms the idempotency key, and only then does the paper adapter run. A crash between the
  steps is finished on the next start:
  - If the order row exists, the call is answered from it (`duplicate:true`).
  - If not, the order is placed on the first live quote. It is placed exactly once.
- **Repeated calls.** A repeated `functionCallId` is answered from the journal with
  `duplicate:true`.

## Paper fill rule (honest, simple)

The rule is immediate-or-cancel against the latest real quote this process has observed:

- **Buy.** It fills at the ask if `limit >= ask`.
- **Sell.** It fills at the bid if `limit <= bid`, and it is long-only.
- **Size.** It fills `min(quantity, floor(displayed size))`. The remainder is cancelled. Real Kalshi
  books often show fractional sizes such as `0.01`, which leads to a rejection.
- **Rejections.** The order is rejected if any of these hold:
  - the quote is more than 30 s old
  - the market is not `active`
  - the buying power is insufficient. The paper account starts at $1000.
- **Not modelled.** There are no fees, queues or resting orders.

Live routing sits behind `--features live-routing`, which is a `compile_error!`.

## User activation

`submitOrder` is `rendererOnly` with `requiresUserActivation:true`. The renderer must put
`args.userActivation = {type, isTrusted:true, timestamp}` from the click's DOM event. The agent
rejects a new call that lacks it, or whose evidence is untrusted or stale. See CONTRACT.md.

## Tests

```bash
cargo test              # 15 unit/component tests + 5 tests that spawn the real binary, all offline
cargo clippy --all-targets
```

Everything runs on the committed real fixtures in `fixtures/`:

- Kalshi `GET /markets/{ticker}` responses recorded on 2026-11-24:
  - `*_primary.jsonl` (90 lines)
  - `*_secondary.jsonl` (5 lines, a second market)
- a `GET /markets?status=open` page (`*_markets_open.json`)

Coverage:

- **Schemas:**
  - The full lifecycle emits only schema-valid messages. It covers `createSurface`,
    `updateComponents`, `updateDataModel`, `deleteSurface` and `agentFunctionResponse`, plus
    snapshots and the journal effects. Every message is checked by both our `jsonschema` validator
    and `ag-ui-a2ui`'s.
  - The catalog conforms to `catalog_definition.json`.
- **Durability:**
  - WAL and FULL are asserted.
  - A restart restores the surfaces and edits.
  - A repeated call id, or a journal replay, places no second order.
  - A call that was committed but unanswered is answered once on resume. So is a placed but
    unanswered order.
- **Safety:**
  - No secrets, key-like names or account ids appear in any client-bound JSON.
  - Calls that break the caller or user-activation rules are rejected.
- **Units:** the paper fill rule, Kalshi parsing and market picking.
- **`tests/ws_e2e.rs`:**
  - render → price update → submit over a real WebSocket, plus 3 sequential reconnects
  - kill -9 at `after_render`, `mid_edit`, `after_call_received` and `after_order_placed`: restart in
    under 5 s with zero duplicate orders

The black-box crash E2E in `scripts/a2ui-crash-e2e.mjs` (see `docs/a2ui/E2E.md`) also runs against
this binary.
