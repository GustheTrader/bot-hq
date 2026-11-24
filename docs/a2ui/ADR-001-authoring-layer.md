# ADR-001: Session loop and A2UI authoring layer (Day-1 spike)

- Status: accepted, 2026-11-24
- Scope: `agents/a2ui-durable/` (PRD v1.1, Day 1, time-boxed to 3 h; the spike took about 1 h)

## Decision

| Concern | Choice | Pinned version |
|---|---|---|
| Durable journal | `rpi-durable` `DurableService<SqliteBackend>` used directly | `rpi-durable =0.27.1` (feature `sqlite`) |
| Session loop | Own deterministic event loop (one actor thread), **not** `rpi-harness`'s `AgentHarness` | (`rpi-harness 0.27.1` evaluated, not a dependency) |
| A2UI authoring | Hand-rolled `serde_json` emitter behind the `A2uiAuthoring` trait (`src/author.rs`) | n/a |
| Schema validation | `jsonschema` against the official v1.0 schemas with our catalog substituted for `catalog.json`, both directions | `jsonschema =0.61.2` (the version `ag-ui-a2ui 1.0.0` pins), no default features |
| Second-opinion validator (tests only) | `ag-ui-a2ui` `SchemaValidator` over the same bundle | `ag-ui-a2ui =1.0.0` (dev-dependency, features `agent`, `schema-validation`) |
| SQLite | the bundled SQLite that `rpi-durable` brings | `rusqlite =0.31.0` / `libsqlite3-sys 0.28.0` (SQLite 3.45.0) |

## What was tried

A throwaway crate depending on `rpi-harness =0.27.1` (`durable-sqlite`), `rpi-durable =0.27.1`
(`sqlite`), `rpi-ai`/`rpi-agent =0.27.1`, `ag-ui-a2ui =1.0.0` (`agent`, `schema-validation`) and
`a2ui-runtime =0.3.0`. Everything **compiled** on cargo/rustc 1.91.1 (1 min 26 s cold, 322 crates;
`rpi-harness` alone pulls 289, including `reqwest`, `hyper`, `image` and `fast_image_resize`).

### rpi-harness: can it run the session loop without an LLM provider or credentials?

- `AgentHarness::create(AgentHarnessOptions { session, ..Default::default() })` with **no models**:
  succeeds.
- `harness.send_message(user "hi")` with no provider: returns `Appended { entry_id }`. It appends a
  user entry; **no turn runs**. Running a turn needs an `rpi_ai::Provider`. The only one that needs no
  credentials is `rpi_ai::providers::faux::FauxProvider`, a scripted test double. Driving the trading
  workflow through a scripted fake LLM would be pretending, so this path is rejected.
- Durability: the harness `Session` persists through its `SessionStorage` (in-memory or JSONL). SQLite
  is an opt-in side channel, `Session::new_with_durable_writer` plus `append_*_to_durable`. The source
  says: "Standard Session writes still use `storage`; callers opt into the capability through
  `append_*_to_durable` until the typed backends are migrated". Writing a `CustomEntry` through it to
  `SqliteBackend` worked (`seq=1 kind=session.entry.custom`). That writer is a thin layer over the same
  `rpi_durable::runtime::DurableService<SqliteBackend>` that we now use directly.

**Result: no-go for the MVP session loop.** The OrderTicket workflow is event-driven (feed ticks,
renderer actions, function calls), with no LLM turn in it. We keep `rpi-durable` as the journal and
use a deterministic loop. When an LLM turn enters the workflow, wrap the harness `Session` over the
same SQLite file through `DurableSessionWriter`. The frame kinds are already namespaced (`a2ui.*`),
so they will not collide with `session.*`.

### ag-ui-a2ui 1.0.0: can it be the authoring layer for a custom catalog?

- `SchemaValidator::new(&SchemaBundle { s2c: v1.0 agent_to_renderer, common_types, catalog: ours }, ..)`:
  **works**. It validated an OrderTicket `createSurface`, rejected an unknown component, and on a
  partial component reported our catalog's own `required` list. So it reads the substituted catalog.
  It is now the second-opinion validator in `cargo test`.
- `ClientSchemaValidator::for_version(V1_0)` (renderer → agent): it registers a permissive "any
  catalog" in place of `catalog.json`. It **accepted** `submitOrder` with `side:"sideways"`,
  `quantity:-3` and an unknown arg, so it cannot enforce our function's args on inbound calls.
- `SchemaBundle::from_inline_catalog` is v0.9-family only (`call`, `functions` as an array).
- `A2uiAuthor` generates surfaces from an LLM: prompt, async `generate` callback, correction
  retries. It has no deterministic builder for a custom catalog's component.

### a2ui-runtime 0.3.0

This is a renderer-side runtime: data model, expressions, surfaces, catalog loading. It sits on the
wrong side of the wire for authoring, so it is not used. Our agent needs only a JSON Pointer write
for its surface store (`author::set_pointer`).

## Why hand-rolled + jsonschema

The PRD fallback applies. Five message builders are about 40 lines (`JsonAuthor`). All of them sit
behind `trait A2uiAuthoring`, so a crate can replace them later without touching the agent.
Correctness comes from validating 100% of the messages in tests against the official schemas. This
covers both directions, with `bothq.trading.v0` registered at
`https://a2ui.org/specification/v1_0/catalog.json`, the URI the envelope's relative `catalog.json` ref
resolves to. At runtime every outbound message is validated before its frame is committed: a
failure is a `debug_assert!` and an `error` log in release builds. Every inbound frame is validated,
and invalid ones are logged and dropped.

## Schemas checked against upstream

The 2026-11-24 check used the `google/A2UI` repo, which redirects to `a2ui-project/a2ui`, at commit
`c26be2dd087b541c46e0296c164ae13bf35f7836`. All seven files in `specification/v1_0/json/` are
**byte-identical** to `agents/a2ui-durable/schemas/v1_0/`:
- `agent_capabilities`
- `agent_to_renderer`
- `catalog_definition`
- `common_types`
- `renderer_capabilities`
- `renderer_data_model`
- `renderer_to_agent`

The bundled `catalog.json` is byte-identical to upstream `catalogs/basic/v1/catalog.json`. Nothing
was replaced.

## SQLite WAL + synchronous=FULL

`SqliteBackend::open` keeps its `Connection` private and sets no pragmas.

- `journal_mode=WAL` persists in the database file, so `journal::prepare_sqlite` sets it on our own
  connection before the backend opens the file.
- `synchronous` is per connection and cannot be set from outside. The only SQLite in the binary is
  the bundled 3.45.0 (`links = "sqlite3"`), built without overriding the defaults. `PRAGMA
  compile_options` reports `DEFAULT_SYNCHRONOUS=2` and `DEFAULT_WAL_SYNCHRONOUS=2`, which is FULL.
- `prepare_sqlite` refuses to start unless a fresh, unconfigured connection reports `wal` and `2`,
  since that is what the backend's connection gets. The paper-orders connection sets
  `synchronous=FULL` explicitly.
- `journal_is_wal_with_synchronous_full` asserts all of the above.

## Known costs

- `SqliteBackend::append` re-reads and re-validates the **whole** journal inside every append
  transaction, so appends are O(frames). To bound growth, the agent journals a quote only when the
  book changes. Compaction or snapshot frames are follow-up work.
- An `rpi-durable` minor bump could change frame validation. The exact pins (`=0.27.1`) keep the
  build reproducible.
