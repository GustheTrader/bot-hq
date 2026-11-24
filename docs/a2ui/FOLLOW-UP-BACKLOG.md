# A2UI durable agents: follow-up backlog (post-MVP)

This backlog comes from PRD v1.1. It covers the section 4 "Deferred to Follow-up" list and the
section 10 "Follow-up Backlog". Each item is an addition on top of the pipeline the MVP proved:

durable loop → surface store → Axum WS → React renderer → crash E2E

Each item lists the parts of that pipeline it reuses, the new work it needs, and when it is done.
Nothing here needs new infrastructure unless the item says so.

The MVP pipeline pieces referred to below:

- **Journal**: the agent's own deterministic event loop (rpi-harness was evaluated and not used, see ADR-001) that commits every frame to rpi-durable (SQLite, WAL,
  `synchronous=FULL`) before it acts.
- **Emitter**: the authoring layer behind one internal trait. It emits serde types and is
  validated against `schemas/v1_0` in `cargo test`.
- **Surface store**: the last committed A2UI state for each surface, plus the snapshot replay
  (one `createSurface` with the full components and dataModel) on every new socket.
- **Catalog**: `bothq.trading.v0` with server-side `@path` bindings. The agent owns `/account/*`.
- **Function calls**: `callAgentFunction`/`agentFunctionResponse` with `allowedCallers` and
  `requiresUserActivation`, and the `functionCallId` mapped to a frame, which maps to an
  idempotency key.
- **Transport**: Axum WS on `/a2ui/ws` (raw A2UI frames) and `/a2ui/health`.
- **Renderer**: `web/src/a2ui/`, which maps catalog entries to DOM grid primitives and drops
  surfaces on reconnect.
- **Crash E2E**: `scripts/a2ui-crash-e2e.mjs`, which runs pause hooks, SIGKILL, a restart on
  the same DB, and the 5 s / zero-duplicate assertions, plus the CI workflow.

---

## B1. RegimeDashboard component (about 1 to 2 days)
- **Reuses:** the Catalog (add an entry to `bothq.trading.v0`), the Emitter, the Surface store
  and snapshot replay unchanged, the Transport, and the Renderer's catalog resolver.
- **New work:**
  - the component schema
  - the data-model paths (for example `/regime/*`, bound with `@path`)
  - a renderer mapping to the existing grid primitives
  - schema tests for a full lifecycle
- **Done when:** `cargo test` validates the new frames. The crash E2E gets a fourth case that
  kills the agent after a dashboard update and asserts that the dashboard data model is
  restored.

## B2. PositionGrid component (about 1 to 2 days)
- **Reuses:**
  - the Catalog and Emitter
  - the `/account/*` server-side resolution, which already keeps raw position records off the
    wire
  - the secret and account-id scan in the crash E2E
- **New work:**
  - a list-shaped data model (rows bound with `@path`, display values only)
  - the renderer grid
  - an incremental `updateDataModel` on a row path, rather than resending the whole grid
- **Done when:** the E2E asserts that the grid is restored after a crash and that no position
  ids or account ids appear in the frames.

## B3. ChartSurface component (about 1 to 2 days)
- **Reuses:** the Emitter, and `updateDataModel` on `/market` (the same feed path as the
  ticket's live price). The latency harness in `scripts/a2ui-crash-e2e.mjs --mode latency`
  measures its update rate.
- **New work:**
  - a bounded series in the data model (a ring buffer server-side, so the snapshot replay stays
    small)
  - the renderer chart mapping
- **Done when:** the snapshot replay of a chart surface stays below an agreed size, and the
  latency report covers chart updates.

## B4. Multi-catalog mixing (`@catalogId`)
- **Reuses:** the Emitter (the per-component `@catalogId` is already in the v1.0 schema), the
  Surface store, and the Renderer resolver.
- **New work:**
  - a catalog registry on both sides
  - Rust schema-test fixtures that substitute more than one catalog
  - a renderer fallback for an unknown catalog: report an A2UI `error` with
    `VALIDATION_FAILED`
- **Done when:** one surface mixes `bothq.trading.v0` with a second catalog and validates.

## B5. `callRendererFunction` / `rendererFunctionResponse` (agent-initiated UI calls)
- **Reuses:**
  - the Function-call plumbing: the `functionCallId` correlation and the frame-before-act
    journal discipline
  - the Transport
  - the inbound `rendererFunctionResponse` parsing, which the schema already defines
- **New work:**
  - the agent side: a pending-call table that is persisted in the journal, so that a crash
    between the call and the response re-issues the call or resolves it after resume
  - the renderer side: the function implementations and `allowedCallers` enforcement in the
    other direction
  - removing the E2E rule that "no `callRendererFunction` is emitted"
- **Done when:** a new E2E kill point `after_renderer_call` proves that the call is answered
  exactly once after a restart.

## B6. AG-UI transport
- **Reuses:**
  - the Emitter output, because A2UI frames are carried as AG-UI events and not re-authored
  - the Surface store snapshot, which is sent as the AG-UI state snapshot
  - the internal trait boundary set on Day 1
- **New work:**
  - an AG-UI adapter (evaluate `ag-ui-a2ui` again now that it is not on the critical path)
  - an SSE or HTTP endpoint next to `/a2ui/ws`
- **Done when:** the crash E2E passes over both transports, with the transport chosen by a flag.

## B7. JSONL storage backend
- **Reuses:** the rpi-durable storage trait, every journal and surface-store call site, and the
  crash E2E. Run it with `--db` pointed at the JSONL backend.
- **New work:**
  - the backend implementation, with `fsync` for each frame to match the WAL plus
    `synchronous=FULL` guarantee
  - an equivalent of the idempotency UNIQUE index, so the backend refuses a duplicate key on
    append
- **Done when:** all three E2E kill points pass on both backends in CI (a matrix job).

## B8. adk-ui helpers
- **Reuses:** the Emitter trait, because the helpers sit on top of it and do not replace it.
- **New work:** builder helpers for common component patterns, and a test proving that the
  helper output matches the hand-built frames byte for byte.
- **Done when:** the OrderTicket emitter is ported to the helpers with no change in the
  `cargo test` schema results.

## B9. Session branching
- **Reuses:** the Journal (frames are already sequenced), the Surface store keyed by session,
  and the idempotency key `<sessionId>:<frame>`, which is already unique per branch if each
  branch gets its own session id.
- **New work:**
  - a fork API (branch at frame N) and branch-aware resume
  - a rule that a branch cannot re-place an order its parent already placed: carry the parent's
    idempotency keys forward
- **Done when:** an E2E forks after `after_order_placed`, replays the submit on the branch, and
  sees `orders=1`.

## B10. Multi-client attachment
- **Reuses:** the snapshot replay on every new socket (each new client already gets a full
  `createSurface`) and the renderer's drop-on-reconnect behaviour.
- **New work:**
  - fan-out of `updateDataModel` to N sockets
  - an edit conflict policy, such as last-writer-wins by frame sequence
  - `functionCallId` dedup across clients, which already works because dedup is per call id
- **Done when:** an E2E attaches two scripted renderers, edits from one, asserts the echo on
  both, and submits from both with orders staying at 1.

## B11. Formal latency SLO
- **Reuses:** `scripts/a2ui-crash-e2e.mjs --mode latency` (p50, p95 and max for feed-to-client
  and for the submit round trip).
- **New work:**
  - an emit timestamp in `/market`, for example a `serverTime` with ms precision, since a
    fixture `asOf` cannot measure feed-to-client latency in replay
  - a set threshold (for example p95 < 100 ms locally)
  - making the latency mode a CI gate, with a margin for runner noise
- **Done when:** CI fails on a p95 regression.

## B12. Queryable observability store
- **Reuses:** the structured `tracing` logs the MVP already emits for frame commits, the surface
  lifecycle and function-call outcomes.
- **New work:**
  - a sink for those logs (an OTLP exporter or a SQLite events table next to the journal)
  - queries for:
    - resume time per restart
    - duplicate rejections
    - the latency histogram
- **Done when:** the numbers the crash E2E prints can be queried from the store after a run.

## B13. Live-trading readiness review (gate before real order routing)
- **Reuses:**
  - the compile-time `live-routing` feature flag (off)
  - FR-6 idempotency
  - the paper adapter's UNIQUE key semantics
  - the crash E2E as the acceptance test
- **New work:**
  - extract a trait from `PaperBroker` (a concrete struct today, there is no adapter trait yet),
    so the live adapter implements the same interface with the same UNIQUE key semantics
  - a written review covering:
    - the venue order-id reconciliation on resume (query the venue by client order id =
      idempotency key before re-placing anything)
    - kill switches and position limits
    - how credentials stay server-side
    - a testnet or demo-account run of all three kill points
- **Done when:** the review is signed off and the E2E passes against a venue demo
  environment. Until then the `live-routing` feature stays off.
