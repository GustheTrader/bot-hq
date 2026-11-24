//! Offline tests over the committed REAL Kalshi fixtures (fixtures/*.jsonl).

use crate::agent::{kind, validate_edit, Agent, Event, Outbound, Pause, State};
use crate::author::set_pointer;
use crate::broker::{fill, Account, OrderRequest};
use crate::catalog::{authorize, function_policy, order_ticket_components, Caller};
use crate::feed::{parse_market, pick_market, read_replay, Quote, Tick};
use crate::journal::{pragmas, Journal, SYNCHRONOUS_FULL};
use crate::schema::{schemas, AGENT_TO_RENDERER, CATALOG, CATALOG_URI, COMMON_TYPES};
use chrono::Utc;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Instant;
use tokio::sync::mpsc::{channel, Receiver};

fn fixture(suffix: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    let mut found: Vec<PathBuf> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path())
        .filter(|p| p.to_string_lossy().ends_with(suffix)).collect();
    found.sort();
    found.pop().unwrap_or_else(|| panic!("no fixture *{suffix} in {}", dir.display()))
}

/// Real recorded quotes, re-observed now (as the replay feed does).
fn quotes(suffix: &str) -> Vec<Quote> {
    read_replay(&fixture(suffix)).unwrap().iter()
        .map(|r| parse_market(&r.body, r.received_at, "kalshi-replay").unwrap()).collect()
}

fn tick(q: &Quote) -> Event {
    let mut q = q.clone();
    q.observed_at = Utc::now();
    Event::Tick(Tick { quote: q, received: Instant::now() })
}

struct Client {
    rx: Receiver<Outbound>,
}

impl Client {
    fn connect(agent: &mut Agent, id: u64) -> Self {
        let (tx, rx) = channel(4096);
        agent.handle(Event::Connect { client: id, tx }).unwrap();
        Self { rx }
    }
    /// Everything delivered since the last drain.
    fn drain(&mut self) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(o) = self.rx.try_recv() {
            out.push(serde_json::from_str::<Value>(&o.text).unwrap());
        }
        out
    }
}

fn open(db: &Path) -> Agent {
    Agent::open(db, Pause::none()).unwrap()
}

fn surface_id(agent: &Agent) -> String {
    agent.state.surfaces.keys().next().unwrap().clone()
}

fn edit(sid: &str, side: &str, qty: i64, price: f64) -> Value {
    json!({"version": "1.0", "action": {"name": "ticketEdited", "surfaceId": sid, "sourceComponentId": "root",
        "timestamp": Utc::now().to_rfc3339(), "context": {"side": side, "quantity": qty, "limitPrice": price}}})
}

fn submit(sid: &str, call_id: &str, agent: &Agent) -> Value {
    let t = &agent.state.surfaces[sid].data_model["ticket"];
    json!({"version": "1.0", "callAgentFunction": {"surfaceId": sid, "functionCallId": call_id,
        "callFunction": {"@call": "submitOrder", "args": {
            "symbol": t["symbol"], "side": t["side"], "quantity": t["quantity"], "limitPrice": t["limitPrice"],
            "userActivation": {"type": "click", "isTrusted": true, "timestamp": Utc::now().to_rfc3339()}}}}})
}

fn send(agent: &mut Agent, client: u64, msg: &Value) {
    assert_eq!(schemas().validate_inbound(msg), Ok(()), "test inbound must be schema-valid: {msg}");
    agent.handle(Event::Inbound { client, text: msg.to_string() }).unwrap();
}

fn responses(msgs: &[Value]) -> Vec<Value> {
    msgs.iter().filter_map(|m| m.get("agentFunctionResponse").cloned()).collect()
}

fn journal_effects(db: &Path) -> Vec<Value> {
    let (_, frames) = Journal::open(db).unwrap();
    frames.iter().flat_map(|f| f.payload["effects"].as_array().cloned().unwrap_or_default()).collect()
}

/// ag-ui-a2ui 1.0.0's SchemaValidator over the same official envelope with our catalog.
fn second_opinion() -> ag_ui_a2ui::schema_validation::SchemaValidator {
    let bundle = ag_ui_a2ui::schema::SchemaBundle {
        s2c: serde_json::from_str(AGENT_TO_RENDERER).unwrap(),
        common_types: serde_json::from_str(COMMON_TYPES).unwrap(),
        catalog: serde_json::from_str(CATALOG).unwrap(),
    };
    ag_ui_a2ui::schema_validation::SchemaValidator::new(&bundle, &Default::default()).unwrap()
}

fn kind_of(m: &Value) -> &'static str {
    ["createSurface", "updateComponents", "updateDataModel", "deleteSurface", "agentFunctionResponse", "callRendererFunction"]
        .into_iter().find(|k| m.get(*k).is_some()).unwrap_or("?")
}

// ---------------------------------------------------------------- schemas

#[test]
fn catalog_conforms_to_catalog_definition_and_enforces_its_rules() {
    let s = schemas();
    assert_eq!(s.validate_catalog(&s.catalog), Ok(()));
    let f = &s.catalog["functions"]["submitOrder"];
    assert_eq!(f["allowedCallers"], "rendererOnly");
    assert_eq!(f["requiresUserActivation"], true);
    // The schema itself forbids requiresUserActivation with a non-renderer caller.
    let mut bad = s.catalog.clone();
    bad["functions"]["submitOrder"]["allowedCallers"] = json!("agentOnly");
    assert!(s.validate_catalog(&bad).is_err());
    let mut bad = s.catalog.clone();
    bad["functions"]["submitOrder"]["allowedCaller"] = json!("rendererOnly"); // misspelt field
    assert!(s.validate_catalog(&bad).is_err());
}

#[test]
fn custom_catalog_replaces_basic_catalog_in_the_envelope() {
    let s = schemas();
    let create = json!({"version": "1.0", "createSurface": {"surfaceId": "s", "catalogId": "bothq.trading.v0",
        "components": order_ticket_components(), "dataModel": {}}});
    assert_eq!(s.validate_outbound(&create), Ok(()));
    let mut wrong = create.clone();
    wrong["createSurface"]["components"][0]["component"] = json!("Text");
    assert!(s.validate_outbound(&wrong).is_err(), "basic-catalog components are not in bothq.trading.v0");
    let mut extra = create.clone();
    extra["createSurface"]["components"][0]["apiKey"] = json!("x");
    assert!(s.validate_outbound(&extra).is_err(), "unevaluatedProperties:false");
    let mut side = create;
    side["createSurface"]["components"][0]["side"] = json!("sideways");
    assert!(s.validate_outbound(&side).is_err());
    assert!(CATALOG_URI.ends_with("/v1_0/catalog.json"));
}

#[test]
fn inbound_submit_args_are_validated_against_the_catalog_function() {
    let s = schemas();
    let call = |args: Value| json!({"version": "1.0", "callAgentFunction": {"surfaceId": "s", "functionCallId": "c",
        "callFunction": {"@call": "submitOrder", "args": args}}});
    assert_eq!(s.validate_inbound(&call(json!({"symbol": "X", "side": "buy", "quantity": 2, "limitPrice": 0.4}))), Ok(()));
    assert!(s.validate_inbound(&call(json!({"symbol": "X", "side": "sideways", "quantity": 2, "limitPrice": 0.4}))).is_err());
    assert!(s.validate_inbound(&call(json!({"symbol": "X", "side": "buy", "quantity": 0, "limitPrice": 0.4}))).is_err());
    assert!(s.validate_inbound(&call(json!({"symbol": "X", "side": "buy", "quantity": 2, "limitPrice": 1.5}))).is_err());
    assert!(s.validate_inbound(&call(json!({"symbol": "X", "side": "buy", "quantity": 2, "limitPrice": 0.4, "idempotencyKey": "k"}))).is_err());
    let unknown = json!({"version": "1.0", "callAgentFunction": {"surfaceId": "s", "functionCallId": "c",
        "callFunction": {"@call": "transferFunds", "args": {}}}});
    assert!(s.validate_inbound(&unknown).is_err());
}

// ---------------------------------------------------------------- lifecycle

#[test]
fn full_order_ticket_lifecycle_emits_only_schema_valid_messages() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("a.sqlite");
    let primary = quotes("_primary.jsonl");
    let secondary = quotes("_secondary.jsonl");
    let mut all_out = Vec::new();
    let mut inbound = Vec::new();
    {
        let mut agent = open(&db);
        let mut c = Client::connect(&mut agent, 1);
        agent.handle(tick(&primary[0])).unwrap();
        for q in &primary[1..] {
            agent.handle(tick(q)).unwrap();
        }
        let sid = surface_id(&agent);
        let ask = primary.last().unwrap().ask;
        let e = edit(&sid, "buy", 2, ask);
        send(&mut agent, 1, &e);
        let s = submit(&sid, "6f1d2c1e-0000-4000-8000-000000000001", &agent);
        send(&mut agent, 1, &s);
        send(&mut agent, 1, &s); // repeated functionCallId
        inbound.extend([e, s]);
        agent.handle(tick(&secondary[0])).unwrap(); // market change: delete + create
        all_out.extend(c.drain());
        let mut c2 = Client::connect(&mut agent, 2); // reconnect snapshot
        all_out.extend(c2.drain());
    }
    {
        // An older build's component tree in the journal: resume re-asserts it with updateComponents.
        let (mut j, frames) = Journal::open(&db).unwrap();
        let state = State::replay(&frames);
        let sid = state.surfaces.keys().next().unwrap().clone();
        let mut old = order_ticket_components();
        old[0]["position"] = json!({"@path": "/account/legacyPosition"});
        j.commit(kind::SURFACE_COMPONENTS, json!({"surfaceId": sid, "effects": [
            {"version": "1.0", "updateComponents": {"surfaceId": sid, "components": old}}]})).unwrap();
    }
    let mut agent = open(&db);
    let mut c = Client::connect(&mut agent, 3);
    all_out.extend(c.drain());
    all_out.extend(journal_effects(&db));

    let kinds: std::collections::BTreeSet<_> = all_out.iter().map(kind_of).collect();
    for k in ["createSurface", "updateComponents", "updateDataModel", "deleteSurface", "agentFunctionResponse"] {
        assert!(kinds.contains(k), "lifecycle never emitted {k}: {kinds:?}");
    }
    let other = second_opinion();
    for m in &all_out {
        assert_eq!(m["version"], "1.0");
        assert_eq!(schemas().validate_outbound(m), Ok(()), "invalid outbound: {m}");
        other.validate_message(m).unwrap_or_else(|e| panic!("ag-ui-a2ui rejects {m}: {e}"));
    }
    for m in &inbound {
        assert_eq!(schemas().validate_inbound(m), Ok(()));
    }
    assert!(all_out.len() > 20, "expected a full lifecycle, got {} messages", all_out.len());
    eprintln!("validated {} outbound + {} inbound messages: {kinds:?}", all_out.len(), inbound.len());
}

#[test]
fn live_price_reaches_ticket_via_update_data_model_without_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let mut agent = open(&dir.path().join("a.sqlite"));
    let mut c = Client::connect(&mut agent, 1);
    let qs = quotes("_primary.jsonl");
    for q in &qs {
        agent.handle(tick(q)).unwrap();
    }
    let out = c.drain();
    assert_eq!(out.iter().filter(|m| m.get("createSurface").is_some()).count(), 1);
    let updates: Vec<&Value> = out.iter().filter(|m| m["updateDataModel"]["path"] == "/market").collect();
    let changes = qs.windows(2).filter(|w| !w[0].same_book(&w[1])).count();
    assert_eq!(updates.len(), changes, "one /market update per real book change");
    assert!(!updates.is_empty(), "fixture has price changes");
    let last = qs.last().unwrap();
    let model = &agent.state.surfaces[&surface_id(&agent)].data_model;
    assert_eq!(model["market"]["bid"], json!(last.bid));
    assert_eq!(model["market"]["ask"], json!(last.ask));
    assert_eq!(model["market"]["lastPrice"], json!(last.display_price()));
}

// ---------------------------------------------------------------- durability

#[test]
fn journal_is_wal_with_synchronous_full() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("a.sqlite");
    let agent = open(&db);
    // A fresh connection has exactly SqliteBackend's (unconfigured) settings.
    assert_eq!(pragmas(&db).unwrap(), ("wal".to_string(), SYNCHRONOUS_FULL));
    assert_eq!(agent.broker().synchronous().unwrap(), SYNCHRONOUS_FULL);
    let conn = rusqlite::Connection::open(&db).unwrap();
    let opts: Vec<String> = conn.prepare("PRAGMA compile_options").unwrap()
        .query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    // Compiled-in defaults that SqliteBackend's own connection runs with: 2 = FULL.
    for opt in ["DEFAULT_SYNCHRONOUS=2", "DEFAULT_WAL_SYNCHRONOUS=2"] {
        assert!(opts.iter().any(|o| o == opt), "bundled SQLite lacks {opt}: {opts:?}");
    }
    // While the agent holds the database open after committing, the WAL file is on disk.
    assert!(agent.state.head >= 1);
    assert!(db.with_extension("sqlite-wal").exists(), "no -wal file next to {}", db.display());
}

#[test]
fn restart_from_journal_restores_surfaces_and_edits() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("a.sqlite");
    let qs = quotes("_primary.jsonl");
    let (sid, session, before) = {
        let mut agent = open(&db);
        agent.handle(tick(&qs[0])).unwrap();
        let sid = surface_id(&agent);
        send(&mut agent, 1, &edit(&sid, "sell", 7, 0.42));
        (sid, agent.state.session_id.clone(), agent.state.surfaces.clone())
    }; // dropped without any shutdown step: what a kill leaves behind
    let mut agent = open(&db);
    assert!(agent.resumed());
    assert_eq!(agent.state.session_id, session);
    assert_eq!(agent.state.surfaces, before);
    let mut c = Client::connect(&mut agent, 9);
    let snap = c.drain();
    assert_eq!(snap.len(), 1);
    let cs = &snap[0]["createSurface"];
    assert_eq!(cs["surfaceId"], json!(sid));
    assert_eq!(cs["catalogId"], "bothq.trading.v0");
    assert_eq!(cs["components"], json!(order_ticket_components()));
    let t = &cs["dataModel"]["ticket"];
    assert_eq!((t["side"].as_str(), t["quantity"].as_i64(), t["limitPrice"].as_f64()), (Some("sell"), Some(7), Some(0.42)));
    assert_eq!(t["status"]["state"], "editing");
    assert_eq!(cs["dataModel"]["session"]["resumed"], true);
    assert_eq!(cs["dataModel"]["session"]["id"], json!(session));
    assert!(agent.health().read().unwrap().resumed);
}

#[test]
fn repeated_call_id_and_journal_replay_never_place_a_second_order() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("a.sqlite");
    let qs = quotes("_primary.jsonl");
    let call_id = "0b7f8a5e-1111-4aaa-8bbb-000000000002";
    let first = {
        let mut agent = open(&db);
        let mut c = Client::connect(&mut agent, 1);
        agent.handle(tick(&qs[0])).unwrap();
        let sid = surface_id(&agent);
        send(&mut agent, 1, &edit(&sid, "buy", 1, qs[0].ask));
        let call = submit(&sid, call_id, &agent);
        send(&mut agent, 1, &call);
        let r = responses(&c.drain());
        assert_eq!(r.len(), 1);
        assert_eq!(r[0]["value"]["duplicate"], false);
        assert_eq!(agent.broker().count().unwrap(), 1);
        send(&mut agent, 1, &call); // renderer re-sends after a reconnect
        let again = responses(&c.drain());
        assert_eq!(again.len(), 1);
        assert_eq!(again[0]["value"]["duplicate"], true);
        assert_eq!(again[0]["value"]["orderId"], r[0]["value"]["orderId"]);
        assert_eq!(again[0]["value"]["idempotencyKey"], r[0]["value"]["idempotencyKey"]);
        assert_eq!(agent.broker().count().unwrap(), 1);
        (r[0].clone(), call)
    };
    let (resp, call) = first;
    let key = resp["value"]["idempotencyKey"].as_str().unwrap().to_owned();
    for _ in 0..2 {
        // Replay the whole journal (incl. the submit frame) in a new process.
        let mut agent = open(&db);
        assert_eq!(agent.broker().count().unwrap(), 1);
        let frame = agent.state.calls[call_id].frame;
        assert_eq!(key, format!("{}:{frame}", agent.state.session_id));
        let mut c = Client::connect(&mut agent, 2);
        c.drain();
        send(&mut agent, 2, &call);
        let r = responses(&c.drain());
        assert_eq!(r[0]["value"]["duplicate"], true);
        assert_eq!(r[0]["value"]["idempotencyKey"], json!(key));
        assert_eq!(agent.broker().count().unwrap(), 1);
    }
}

#[test]
fn call_committed_but_unanswered_before_crash_is_answered_on_resume_once() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("a.sqlite");
    let qs = quotes("_primary.jsonl");
    let call_id = "5c3e1d2a-2222-4ccc-9ddd-000000000003";
    {
        let mut agent = open(&db);
        agent.handle(tick(&qs[0])).unwrap();
    }
    {
        // Restarted process, no live quote yet: the call is committed, then the process dies.
        let mut agent = open(&db);
        let mut c = Client::connect(&mut agent, 1);
        let sid = surface_id(&agent);
        let call = submit(&sid, call_id, &agent);
        send(&mut agent, 1, &call);
        assert!(responses(&c.drain()).is_empty());
        assert!(agent.state.calls[call_id].response.is_none());
        assert_eq!(agent.broker().count().unwrap(), 0);
    }
    let mut agent = open(&db);
    assert!(agent.state.calls[call_id].response.is_none(), "still pending until a live quote");
    let mut c = Client::connect(&mut agent, 2);
    agent.handle(tick(&qs[1])).unwrap();
    let r = responses(&c.drain());
    assert_eq!(r.len(), 1, "answered exactly once on resume");
    assert_eq!(r[0]["functionCallId"], call_id);
    assert_eq!(r[0]["value"]["duplicate"], false);
    assert_eq!(agent.broker().count().unwrap(), 1);
    agent.handle(tick(&qs[2])).unwrap();
    assert!(responses(&c.drain()).is_empty(), "never answered twice");
    drop(agent);
    let agent = open(&db);
    assert_eq!(agent.broker().count().unwrap(), 1);
    assert!(agent.state.calls[call_id].response.is_some());
}

#[test]
fn order_placed_but_unanswered_before_crash_is_answered_from_the_existing_order() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("a.sqlite");
    let qs = quotes("_primary.jsonl");
    let call_id = "9a8b7c6d-3333-4eee-afff-000000000004";
    {
        let mut agent = open(&db);
        agent.handle(tick(&qs[0])).unwrap();
    }
    let order_id = {
        let mut agent = open(&db);
        let sid = surface_id(&agent);
        let call = submit(&sid, call_id, &agent);
        send(&mut agent, 1, &call); // committed, waiting for a quote
        let rec = agent.state.calls[call_id].clone();
        drop(agent);
        // The crash window: the order reached the paper adapter, the answer was never committed.
        let mut broker = crate::broker::PaperBroker::open(&db).unwrap();
        let (o, dup) = broker.place(rec.key.as_deref().unwrap(), call_id, rec.request.as_ref().unwrap(), Some(&{
            let mut q = qs[0].clone(); q.observed_at = Utc::now(); q }), Utc::now()).unwrap();
        assert!(!dup);
        o.order_id
    };
    let mut agent = open(&db); // answers on open: the order exists, no quote needed
    assert_eq!(agent.broker().count().unwrap(), 1);
    let resp = agent.state.calls[call_id].response.clone().expect("answered on resume");
    assert_eq!(resp["agentFunctionResponse"]["value"]["orderId"], json!(order_id));
    assert_eq!(resp["agentFunctionResponse"]["value"]["duplicate"], true);
    let mut c = Client::connect(&mut agent, 5);
    c.drain();
    let sid = surface_id(&agent);
    let mut again = submit(&sid, call_id, &agent);
    again["callAgentFunction"]["callFunction"]["args"]["userActivation"]["timestamp"] = json!("2020-01-01T00:00:00Z");
    send(&mut agent, 5, &again); // dedup happens before activation freshness
    let r = responses(&c.drain());
    assert_eq!(r[0]["value"]["orderId"], json!(order_id));
    assert_eq!(agent.broker().count().unwrap(), 1);
}

// ---------------------------------------------------------------- safety

#[test]
fn no_secrets_keys_or_account_ids_in_client_bound_messages() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("a.sqlite");
    let qs = quotes("_primary.jsonl");
    let mut agent = open(&db);
    let account_id = agent.broker().account_id().to_owned();
    let mut c = Client::connect(&mut agent, 1);
    for q in &qs[..10] {
        agent.handle(tick(q)).unwrap();
    }
    let sid = surface_id(&agent);
    send(&mut agent, 1, &edit(&sid, "buy", 3, qs[9].ask));
    let call = submit(&sid, "aaaaaaaa-4444-4444-8444-000000000005", &agent);
        send(&mut agent, 1, &call);
    let mut bad = submit(&sid, "aaaaaaaa-4444-4444-8444-000000000006", &agent);
    bad["callAgentFunction"]["callFunction"]["args"].as_object_mut().unwrap().remove("userActivation");
    send(&mut agent, 1, &bad);
    drop(agent);
    let mut agent = open(&db);
    let mut c2 = Client::connect(&mut agent, 2);
    let mut all = c.drain();
    all.extend(c2.drain());
    all.extend(journal_effects(&db));
    assert!(all.len() > 10);
    const DENY: [&str; 10] = ["secret", "password", "apikey", "api_key", "token", "accountid", "account_id", "privatekey", "credential", "authorization"];
    fn walk(v: &Value, f: &mut dyn FnMut(&str, &Value)) {
        match v {
            Value::Object(m) => m.iter().for_each(|(k, x)| { f(k, x); walk(x, f) }),
            Value::Array(a) => a.iter().for_each(|x| walk(x, f)),
            _ => {}
        }
    }
    for m in &all {
        let text = m.to_string();
        assert!(!text.contains(&account_id), "paper account id leaked: {text}");
        assert!(!text.contains("paper-acct-"), "account id prefix leaked: {text}");
        assert!(!text.contains("Bearer ") && !text.contains("-----BEGIN"), "credential material: {text}");
        walk(m, &mut |k, _| {
            let k = k.to_ascii_lowercase();
            assert!(!DENY.iter().any(|d| k.contains(d)), "forbidden key {k:?} in {text}");
        });
        if let Some(acct) = m["updateDataModel"].get("value").filter(|_| m["updateDataModel"]["path"] == "/account") {
            let keys: Vec<&String> = acct.as_object().unwrap().keys().collect();
            assert_eq!(keys, ["buyingPower", "position"], "/account carries display values only");
        }
    }
}

#[test]
fn calls_violating_caller_or_user_activation_rules_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let qs = quotes("_primary.jsonl");
    let mut agent = open(&dir.path().join("a.sqlite"));
    let mut c = Client::connect(&mut agent, 1);
    agent.handle(tick(&qs[0])).unwrap();
    let sid = surface_id(&agent);
    c.drain();
    type Mutate = Box<dyn Fn(&mut Value)>;
    let variants: Vec<(&str, Mutate)> = vec![
        ("USER_ACTIVATION_REQUIRED", Box::new(|a| { a.as_object_mut().unwrap().remove("userActivation"); })),
        ("USER_ACTIVATION_REQUIRED", Box::new(|a| a["userActivation"]["isTrusted"] = json!(false))),
        ("USER_ACTIVATION_REQUIRED", Box::new(|a| a["userActivation"]["timestamp"] = json!("2026-01-01T00:00:00Z"))),
        ("INVALID_ARGS", Box::new(|a| a["side"] = json!({"@path": "/ticket/side"}))),
        ("SYMBOL_MISMATCH", Box::new(|a| a["symbol"] = json!("KXSOMETHINGELSE"))),
    ];
    for (n, (code, mutate)) in variants.iter().enumerate() {
        let mut call = submit(&sid, &format!("bbbbbbbb-5555-4555-8555-00000000000{n}"), &agent);
        mutate(&mut call["callAgentFunction"]["callFunction"]["args"]);
        send(&mut agent, 1, &call);
        let out = c.drain();
        let r = responses(&out);
        assert_eq!(r.len(), 1, "{code}");
        assert_eq!(r[0]["error"]["code"], *code, "{}", r[0]);
        assert!(out.iter().any(|m| m["updateDataModel"]["value"]["state"] == "rejected"));
    }
    let mut wrong_surface = submit(&sid, "bbbbbbbb-5555-4555-8555-000000000009", &agent);
    wrong_surface["callAgentFunction"]["surfaceId"] = json!("nope");
    send(&mut agent, 1, &wrong_surface);
    assert_eq!(responses(&c.drain())[0]["error"]["code"], "UNKNOWN_SURFACE");
    // Schema-invalid frames are logged and dropped: no response, no frame.
    let head = agent.state.head;
    let mut invalid = submit(&sid, "bbbbbbbb-5555-4555-8555-00000000000a", &agent);
    invalid["callAgentFunction"]["callFunction"]["args"]["side"] = json!("sideways");
    agent.handle(Event::Inbound { client: 1, text: invalid.to_string() }).unwrap();
    agent.handle(Event::Inbound { client: 1, text: "not json".into() }).unwrap();
    assert!(c.drain().is_empty());
    assert_eq!(agent.state.head, head);
    // rendererOnly: the agent itself may not invoke submitOrder.
    let args = submit(&sid, "x", &agent)["callAgentFunction"]["callFunction"]["args"].clone();
    assert_eq!(authorize(Caller::Agent, "submitOrder", &args, Utc::now()).unwrap_err().code, "CALLER_NOT_ALLOWED");
    assert!(authorize(Caller::Renderer, "submitOrder", &args, Utc::now()).is_ok());
    let body = submit(&sid, "x", &agent)["callAgentFunction"].clone();
    assert_eq!(agent.check_call(Caller::Agent, &body).unwrap_err().code, "CALLER_NOT_ALLOWED");
    assert!(function_policy("submitOrder").unwrap().requires_user_activation);
    assert_eq!(agent.broker().count().unwrap(), 0, "no rejected call placed an order");
}

// ---------------------------------------------------------------- units

#[test]
fn paper_fill_rule_on_real_quotes() {
    let mut q = quotes("_primary.jsonl").into_iter().find(|q| q.ask_size >= 5.0 && q.bid_size >= 5.0).unwrap();
    q.observed_at = Utc::now();
    let acct = Account { buying_power: 1000.0, position: 0 };
    let req = |side: &str, qty, px| OrderRequest { symbol: q.ticker.clone(), side: side.into(), quantity: qty, limit_price: px };
    let (s, n, px, why) = fill(&req("buy", 1, q.ask), Some(&q), acct, Utc::now());
    assert_eq!((s, n, px), ("filled", 1, Some(q.ask)), "{why} {q:?}");
    let (s, ..) = fill(&req("buy", 1, q.bid), Some(&q), acct, Utc::now());
    assert_eq!(s, "rejected", "limit below ask is not marketable (IOC)");
    let big = q.ask_size.floor() as i64 + 5;
    let (s, n, ..) = fill(&req("buy", big, q.ask), Some(&q), acct, Utc::now());
    assert_eq!((s, n), ("partially_filled", q.ask_size.floor() as i64));
    let (s, ..) = fill(&req("sell", 1, q.bid), Some(&q), acct, Utc::now());
    assert_eq!(s, "rejected", "long-only");
    let (s, n, px, _) = fill(&req("sell", 1, q.bid), Some(&q), Account { position: 3, ..acct }, Utc::now());
    assert_eq!((s, n, px), ("filled", 1, Some(q.bid)));
    let thin = Quote { ask_size: 0.01, ..q.clone() }; // real Kalshi books show fractional sizes
    assert_eq!(fill(&req("buy", 1, q.ask), Some(&thin), acct, Utc::now()).0, "rejected");
    let (s, _, _, why) = fill(&req("buy", 1, q.ask), Some(&q), acct, Utc::now() + chrono::Duration::seconds(120));
    assert!(s == "rejected" && why.contains("old"));
    let (s, ..) = fill(&req("buy", 1, q.ask), Some(&q), Account { buying_power: 0.0, position: 0 }, Utc::now());
    assert_eq!(s, "rejected");
}

#[test]
fn kalshi_parsing_uses_dollar_strings_and_picker_selects_a_live_market() {
    let rec = &read_replay(&fixture("_primary.jsonl")).unwrap()[0];
    let m = &rec.body["market"];
    let q = parse_market(&rec.body, rec.received_at, "kalshi").unwrap();
    assert_eq!(q.bid, m["yes_bid_dollars"].as_str().unwrap().parse::<f64>().unwrap());
    assert_eq!(q.ask, m["yes_ask_dollars"].as_str().unwrap().parse::<f64>().unwrap());
    assert_eq!(q.last_trade, m["last_price_dollars"].as_str().unwrap().parse::<f64>().unwrap());
    assert!(parse_market(&json!({"market": {"ticker": "X", "yes_bid_dollars": 41}}), Utc::now(), "k").is_err(), "legacy int cents rejected");
    let page: Value = serde_json::from_str(&std::fs::read_to_string(fixture("_markets_open.json")).unwrap()).unwrap();
    let at = page["markets"][0]["created_time"].as_str().map(|_| rec.received_at).unwrap();
    let pick = pick_market(&page, at).expect("a liquid market in the recorded page");
    let chosen = page["markets"].as_array().unwrap().iter().find(|x| x["ticker"] == pick.as_str()).unwrap();
    let px = |k: &str| chosen[k].as_str().unwrap().parse::<f64>().unwrap();
    assert!(px("yes_bid_dollars") > 0.0 && px("yes_ask_dollars") > px("yes_bid_dollars"));
    assert_eq!(chosen["status"], "active");
}

#[test]
fn edits_and_pointers() {
    assert_eq!(validate_edit(&json!({"side": "buy", "quantity": 3, "limitPrice": 0.07})), Ok(("buy".into(), 3, 0.07)));
    assert!(validate_edit(&json!({"side": "buy", "quantity": 3.5, "limitPrice": 0.07})).is_err());
    assert!(validate_edit(&json!({"side": "buy", "quantity": 3, "limitPrice": 0.075})).is_err());
    assert!(validate_edit(&json!({"side": "hold", "quantity": 3, "limitPrice": 0.07})).is_err());
    let mut v = json!({"a": {"b": 1}});
    set_pointer(&mut v, "/a/c/d", json!(2)).unwrap();
    set_pointer(&mut v, "/a/b", Value::Null).unwrap();
    assert_eq!(v, json!({"a": {"c": {"d": 2}}}));
    // Empty segments are RFC 6901 "" keys, not dropped.
    set_pointer(&mut v, "/a/", json!(3)).unwrap();
    assert_eq!(v["a"][""], 3);
    set_pointer(&mut v, "/x~1y/~0z", json!(4)).unwrap();
    assert_eq!(v["x/y"]["~z"], 4);
    // Malformed or clobbering paths are refused and change nothing.
    let before = v.clone();
    assert!(set_pointer(&mut v, "ticket", json!(1)).is_err());
    assert!(set_pointer(&mut v, "ticket/side", json!(1)).is_err());
    assert!(set_pointer(&mut v, "/a/c/d/e", json!(1)).is_err(), "d holds a number");
    assert!(set_pointer(&mut v, "/a/c/d/e/f", json!(1)).is_err());
    assert_eq!(v, before);
    set_pointer(&mut v, "/", json!({"x": 1})).unwrap();
    assert_eq!(v, json!({"x": 1}));
    set_pointer(&mut v, "", json!({"y": 1})).unwrap();
    assert_eq!(v, json!({"y": 1}));
}

// ---------------------------------------------------------------- review fixes

#[test]
fn new_call_while_one_is_in_flight_is_rejected_and_same_id_still_dedupes() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("a.sqlite");
    let qs = quotes("_primary.jsonl");
    {
        let mut agent = open(&db);
        agent.handle(tick(&qs[0])).unwrap();
    }
    // Restarted, no live quote yet: the first call is accepted and stays in flight.
    let mut agent = open(&db);
    let mut c = Client::connect(&mut agent, 1);
    c.drain();
    let sid = surface_id(&agent);
    let (a, b, d) = ("cccccccc-6666-4666-8666-00000000000a", "cccccccc-6666-4666-8666-00000000000b", "cccccccc-6666-4666-8666-00000000000d");
    let call_a = submit(&sid, a, &agent);
    send(&mut agent, 1, &call_a);
    assert!(responses(&c.drain()).is_empty());
    assert_eq!(agent.state.surfaces[&sid].data_model["ticket"]["status"]["state"], "submitting");
    let call_b = submit(&sid, b, &agent);
    send(&mut agent, 1, &call_b);
    let out = c.drain();
    let r = responses(&out);
    assert_eq!(r.len(), 1);
    assert_eq!(r[0]["functionCallId"], b);
    assert_eq!(r[0]["error"]["code"], "ORDER_IN_FLIGHT");
    assert!(!out.iter().any(|m| m["updateDataModel"]["path"] == "/ticket/status"), "in-flight status untouched");
    assert_eq!(agent.state.surfaces[&sid].data_model["ticket"]["status"]["state"], "submitting");
    // Same id re-sent while executing: deduped, no second record, no response yet.
    send(&mut agent, 1, &call_a);
    assert!(responses(&c.drain()).is_empty());
    assert_eq!(agent.broker().count().unwrap(), 0);
    // The first live quote executes A exactly once.
    agent.handle(tick(&qs[1])).unwrap();
    let r = responses(&c.drain());
    assert_eq!(r.len(), 1);
    assert_eq!(r[0]["functionCallId"], a);
    assert_eq!(agent.broker().count().unwrap(), 1);
    // Re-sending A returns the original answer; a fresh id is now accepted.
    send(&mut agent, 1, &call_a);
    let again = responses(&c.drain());
    assert_eq!(again[0]["value"]["duplicate"], true);
    let call_d = submit(&sid, d, &agent);
    send(&mut agent, 1, &call_d);
    let r = responses(&c.drain());
    assert_eq!(r[0]["functionCallId"], d);
    assert!(r[0].get("value").is_some(), "{}", r[0]);
    assert_eq!(agent.broker().count().unwrap(), 2);
}

#[test]
fn schema_invalid_or_unappliable_effects_are_refused_before_the_journal() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("a.sqlite");
    let qs = quotes("_primary.jsonl");
    let mut agent = open(&db);
    agent.handle(tick(&qs[0])).unwrap();
    let sid = surface_id(&agent);
    let head = agent.state.head;
    let frames = Journal::open(&db).unwrap().1.len();
    let invalid = json!({"version": "1.0", "createSurface": {"surfaceId": "x", "catalogId": "bothq.trading.v0",
        "components": [{"id": "root", "component": "Text"}], "dataModel": {}}});
    assert!(agent.commit("test.invalid", json!({}), vec![invalid]).is_err());
    let clobber = json!({"version": "1.0", "updateDataModel": {"surfaceId": sid, "path": "/ticket/symbol/x", "value": 1}});
    assert_eq!(schemas().validate_outbound(&clobber), Ok(()));
    assert!(agent.commit("test.clobber", json!({}), vec![clobber]).is_err());
    assert_eq!(agent.state.head, head);
    assert_eq!(Journal::open(&db).unwrap().1.len(), frames, "nothing journaled");
    assert!(agent.state.surfaces[&sid].data_model["ticket"]["symbol"].is_string());
}

#[test]
fn a_client_whose_outbound_queue_is_full_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let qs = quotes("_primary.jsonl");
    let mut agent = open(&dir.path().join("a.sqlite"));
    agent.handle(tick(&qs[0])).unwrap();
    let (tx, mut rx) = channel(1);
    agent.handle(Event::Connect { client: 9, tx }).unwrap(); // snapshot fills the queue
    let changes: Vec<&Quote> = qs.windows(2).filter(|w| !w[0].same_book(&w[1])).map(|w| &w[1]).take(3).collect();
    assert!(!changes.is_empty());
    for q in changes {
        agent.handle(tick(q)).unwrap();
    }
    assert!(rx.try_recv().unwrap().text.contains("createSurface"));
    assert!(matches!(rx.try_recv(), Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)), "slow client's queue was closed");
}

#[test]
fn staleness_and_activation_windows_are_not_truncated_to_whole_seconds() {
    let mut q = quotes("_primary.jsonl").into_iter().find(|q| q.ask_size >= 1.0).unwrap();
    let t0 = Utc::now();
    q.observed_at = t0;
    let acct = Account { buying_power: 1000.0, position: 0 };
    let req = OrderRequest { symbol: q.ticker.clone(), side: "buy".into(), quantity: 1, limit_price: q.ask };
    let ms = chrono::Duration::milliseconds;
    assert_ne!(fill(&req, Some(&q), acct, t0 + ms(30_000)).0, "rejected", "exactly 30 s is still fresh");
    let (s, _, _, why) = fill(&req, Some(&q), acct, t0 + ms(30_001));
    assert!(s == "rejected" && why.contains("old"), "{why}");
    let (s, _, _, why) = fill(&req, Some(&q), acct, t0 - ms(5_000));
    assert!(s == "rejected" && why.contains("future"), "{why}");
    assert_ne!(fill(&req, Some(&q), acct, t0 - ms(500)).0, "rejected", "sub-second skew tolerated");

    let args = |at: chrono::DateTime<Utc>| json!({"symbol": "X", "side": "buy", "quantity": 1, "limitPrice": 0.5,
        "userActivation": {"type": "click", "isTrusted": true, "timestamp": at.to_rfc3339()}});
    assert!(authorize(Caller::Renderer, "submitOrder", &args(t0 - ms(120_000)), t0).is_ok());
    assert!(authorize(Caller::Renderer, "submitOrder", &args(t0 - ms(120_500)), t0).is_err(), "120.5 s is stale");
    assert!(authorize(Caller::Renderer, "submitOrder", &args(t0 + ms(30_500)), t0).is_err(), "30.5 s in the future");
}

#[test]
fn missing_dollar_fields_are_errors_and_null_is_an_empty_side() {
    let rec = &read_replay(&fixture("_primary.jsonl")).unwrap()[0];
    let mut body = rec.body.clone();
    body["market"]["yes_bid_dollars"] = Value::Null;
    assert_eq!(parse_market(&body, rec.received_at, "k").unwrap().bid, 0.0);
    body["market"].as_object_mut().unwrap().remove("yes_ask_dollars");
    let err = parse_market(&body, rec.received_at, "k").unwrap_err().to_string();
    assert!(err.contains("yes_ask_dollars"), "{err}");
}

#[test]
fn catalog_submit_must_be_a_submit_order_function_call() {
    let s = schemas();
    let mut create = json!({"version": "1.0", "createSurface": {"surfaceId": "s", "catalogId": "bothq.trading.v0",
        "components": order_ticket_components(), "dataModel": {}}});
    assert_eq!(s.validate_outbound(&create), Ok(()));
    create["createSurface"]["components"][0]["submit"] = json!({"event": {"name": "submitOrder"}});
    assert!(s.validate_outbound(&create).is_err(), "an event action is not a submitOrder call");
}
