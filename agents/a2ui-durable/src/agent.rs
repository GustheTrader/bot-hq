//! The durable agent: one sequential actor that commits every inbound event
//! and every outbound A2UI effect to the journal *before* acting on it.
//!
//! Each journal frame carries `effects`: the exact agent_to_renderer messages
//! the frame causes. The surface store is the fold of those effects
//! ([`State::apply`]), used identically live and on replay, so a resumed
//! process holds exactly the committed surfaces, data model, ticket edits and
//! function calls. Sending an effect to a socket happens only after its frame
//! is committed; a reconnecting socket gets a snapshot of the store instead.

use crate::author::{apply_to_store, A2uiAuthoring, JsonAuthor, Surface};
use crate::broker::{Order, OrderRequest, PaperBroker};
use crate::catalog::{self, authorize, Caller, FnError, CATALOG_ID, SUBMIT_ORDER};
use crate::feed::{Quote, Tick};
use crate::journal::Journal;
use crate::schema::schemas;
use anyhow::Result;
use chrono::Utc;
use rpi_durable::storage::JournalFrame;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

pub mod kind {
    pub const SESSION_STARTED: &str = "a2ui.session.started";
    pub const SESSION_RESUMED: &str = "a2ui.session.resumed";
    pub const SURFACE_CREATED: &str = "a2ui.surface.created";
    pub const SURFACE_COMPONENTS: &str = "a2ui.surface.components";
    pub const SURFACE_DELETED: &str = "a2ui.surface.deleted";
    pub const MARKET_QUOTE: &str = "a2ui.market.quote";
    pub const INBOUND_ACTION: &str = "a2ui.inbound.action";
    pub const INBOUND_CALL: &str = "a2ui.inbound.call";
    pub const INBOUND_CALL_REPEAT: &str = "a2ui.inbound.call_repeat";
    pub const INBOUND_OTHER: &str = "a2ui.inbound.other";
    pub const CALL_REJECTED: &str = "a2ui.call.rejected";
    pub const CALL_ANSWERED: &str = "a2ui.call.answered";
}

pub type ClientId = u64;

pub enum Event {
    Connect { client: ClientId, tx: UnboundedSender<Outbound> },
    Disconnect { client: ClientId },
    Inbound { client: ClientId, text: String },
    Tick(Tick),
}

/// One WebSocket text frame; `feed_received` is set for market updates so the
/// socket writer can log feed-receive → WS-send latency.
pub struct Outbound {
    pub text: String,
    pub feed_received: Option<Instant>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub session_id: String,
    pub head: u64,
    pub surfaces: Vec<String>,
    pub orders: u64,
    pub resumed: bool,
}

#[derive(Clone, Debug)]
pub struct CallRecord {
    /// Journal frame that committed the received call.
    pub frame: u64,
    pub surface_id: String,
    pub request: Option<OrderRequest>,
    /// `<sessionId>:<frame>` for accepted calls; None for rejected ones.
    pub key: Option<String>,
    /// The committed agentFunctionResponse message, once answered.
    pub response: Option<Value>,
}

/// Everything rebuilt from the journal.
#[derive(Clone, Debug, Default)]
pub struct State {
    pub session_id: String,
    pub head: u64,
    pub surfaces: BTreeMap<String, Surface>,
    pub calls: BTreeMap<String, CallRecord>,
    pub last_quote: Option<Quote>,
    pub surfaces_created: u64,
}

impl State {
    pub fn replay(frames: &[JournalFrame]) -> Self {
        let mut s = Self::default();
        frames.iter().for_each(|f| s.apply(f));
        s
    }

    pub fn apply(&mut self, f: &JournalFrame) {
        let p = &f.payload;
        self.head = f.sequence;
        match f.kind.as_str() {
            kind::SESSION_STARTED => self.session_id = p["sessionId"].as_str().unwrap_or_default().to_owned(),
            kind::SURFACE_CREATED => self.surfaces_created += 1,
            kind::INBOUND_CALL | kind::CALL_REJECTED => {
                let accepted = f.kind == kind::INBOUND_CALL;
                self.calls.insert(p["functionCallId"].as_str().unwrap_or_default().to_owned(), CallRecord {
                    frame: f.sequence,
                    surface_id: p["surfaceId"].as_str().unwrap_or_default().to_owned(),
                    request: serde_json::from_value(p["request"].clone()).ok(),
                    key: accepted.then(|| format!("{}:{}", self.session_id, f.sequence)),
                    response: None,
                });
            }
            _ => {}
        }
        if let Ok(q) = serde_json::from_value::<Quote>(p["quote"].clone()) {
            self.last_quote = Some(q);
        }
        for e in p["effects"].as_array().into_iter().flatten() {
            if let Some(r) = e.get("agentFunctionResponse") {
                if let Some(c) = r["functionCallId"].as_str().and_then(|id| self.calls.get_mut(id)) {
                    c.response = Some(e.clone());
                }
            } else {
                apply_to_store(&mut self.surfaces, e);
            }
        }
    }

    fn surface_for_symbol(&self, symbol: &str) -> Option<String> {
        self.surfaces.iter().find(|(_, s)| s.data_model["ticket"]["symbol"] == symbol).map(|(id, _)| id.clone())
    }
}

/// `BOTHQ_A2UI_PAUSE_AT` crash hooks: log `PAUSE_POINT <name>` to stderr and
/// sleep, once per process, so a test can `kill -9` there.
pub struct Pause {
    at: Option<String>,
    secs: u64,
    fired: bool,
}

impl Pause {
    pub const POINTS: [&'static str; 4] = ["after_render", "mid_edit", "after_order_placed", "after_call_received"];
    pub fn none() -> Self {
        Self { at: None, secs: 0, fired: false }
    }
    pub fn from_env() -> Self {
        let at = std::env::var("BOTHQ_A2UI_PAUSE_AT").ok().filter(|s| !s.is_empty());
        if let Some(p) = &at {
            if !Self::POINTS.contains(&p.as_str()) {
                tracing::warn!(point = %p, "unknown BOTHQ_A2UI_PAUSE_AT value; it will never fire");
            }
        }
        let secs = std::env::var("BOTHQ_A2UI_PAUSE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(30);
        Self { at, secs, fired: false }
    }
    fn hit(&mut self, point: &str) {
        if !self.fired && self.at.as_deref() == Some(point) {
            self.fired = true;
            eprintln!("PAUSE_POINT {point}");
            tracing::warn!(target: "a2ui::crash", point, secs = self.secs, "pausing at crash hook");
            std::thread::sleep(Duration::from_secs(self.secs));
        }
    }
}

pub struct Agent {
    journal: Journal,
    broker: PaperBroker,
    author: Box<dyn A2uiAuthoring>,
    pub state: State,
    clients: Vec<(ClientId, UnboundedSender<Outbound>)>,
    /// Latest quote observed by *this process* (not journaled when unchanged);
    /// the paper fill rule only trades against it.
    fresh_quote: Option<Quote>,
    resumed: bool,
    pause: Pause,
    health: Arc<RwLock<Health>>,
}

impl Agent {
    /// Opens the journal, replays it, and finishes any call that was committed
    /// but not answered before the last process died.
    pub fn open(db: &Path, pause: Pause) -> Result<Self> {
        let started = Instant::now();
        let (journal, frames) = Journal::open(db)?;
        let broker = PaperBroker::open(db)?;
        let state = State::replay(&frames);
        let resumed = !state.session_id.is_empty();
        let mut agent = Self {
            journal, broker, author: Box::new(JsonAuthor), state, clients: Vec::new(), fresh_quote: None,
            resumed, pause, health: Arc::default(),
        };
        if resumed {
            agent.commit(kind::SESSION_RESUMED, json!({"fromHead": agent.state.head, "pid": std::process::id()}), vec![])?;
            agent.reconcile_components()?;
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            agent.commit(kind::SESSION_STARTED, json!({"sessionId": id, "catalogId": CATALOG_ID}), vec![])?;
        }
        agent.resume_pending_calls()?;
        agent.refresh_health();
        tracing::info!(target: "a2ui::session", session = %agent.state.session_id, resumed, frames = frames.len(),
            surfaces = agent.state.surfaces.len(), orders = agent.broker.count()?, ms = started.elapsed().as_millis() as u64,
            db = %agent.journal.path().display(), "session open");
        Ok(agent)
    }

    pub fn health(&self) -> Arc<RwLock<Health>> {
        self.health.clone()
    }
    pub fn broker(&self) -> &PaperBroker {
        &self.broker
    }
    pub fn resumed(&self) -> bool {
        self.resumed
    }
    pub fn ticket_symbol(&self) -> Option<String> {
        self.state.surfaces.values().next().and_then(|s| s.data_model["ticket"]["symbol"].as_str().map(str::to_owned))
    }

    /// Runs the actor on the current (dedicated) thread until all senders drop.
    pub fn run(mut self, mut rx: UnboundedReceiver<Event>) {
        while let Some(ev) = rx.blocking_recv() {
            if let Err(e) = self.handle(ev) {
                tracing::error!(target: "a2ui::agent", error = %format!("{e:#}"), "event failed");
            }
        }
    }

    pub fn handle(&mut self, ev: Event) -> Result<()> {
        match ev {
            Event::Connect { client, tx } => self.connect(client, tx),
            Event::Disconnect { client } => {
                self.clients.retain(|(id, _)| *id != client);
                tracing::info!(target: "a2ui::transport", client, "renderer disconnected");
            }
            Event::Inbound { client, text } => self.inbound(client, &text)?,
            Event::Tick(t) => self.tick(t)?,
        }
        self.refresh_health();
        Ok(())
    }

    fn refresh_health(&self) {
        let h = Health {
            session_id: self.state.session_id.clone(),
            head: self.state.head,
            surfaces: self.state.surfaces.keys().cloned().collect(),
            orders: self.broker.count().unwrap_or(0),
            resumed: self.resumed,
        };
        *self.health.write().unwrap() = h;
    }

    /// Validates effects, commits the frame, folds it into state. Nothing is
    /// sent before this returns Ok.
    fn commit(&mut self, kind: &str, mut payload: Value, effects: Vec<Value>) -> Result<Vec<Value>> {
        for e in &effects {
            if let Err(err) = schemas().validate_outbound(e) {
                tracing::error!(target: "a2ui::schema", %err, msg = %e, "outbound message fails A2UI v1.0 schema");
                debug_assert!(false, "outbound message fails A2UI v1.0 schema: {err}\n{e}");
            }
        }
        payload["effects"] = Value::Array(effects);
        let frame = self.journal.commit(kind, payload)?;
        self.state.apply(&frame);
        Ok(frame.payload["effects"].as_array().cloned().unwrap_or_default())
    }

    fn send(&mut self, only: Option<ClientId>, msgs: &[Value], feed: Option<Instant>) {
        if msgs.is_empty() {
            return;
        }
        let mut rendered = false;
        self.clients.retain(|(id, tx)| {
            if only.is_some_and(|o| o != *id) {
                return true;
            }
            msgs.iter().all(|m| {
                rendered |= m.get("createSurface").is_some();
                tx.send(Outbound { text: m.to_string(), feed_received: feed }).is_ok()
            })
        });
        if rendered {
            self.pause.hit("after_render");
        }
    }

    fn connect(&mut self, client: ClientId, tx: UnboundedSender<Outbound>) {
        self.clients.push((client, tx));
        let session = json!({"id": self.state.session_id, "resumed": self.resumed, "frame": self.state.head});
        let snapshot: Vec<Value> = self
            .state
            .surfaces
            .iter()
            .map(|(id, s)| {
                let mut dm = s.data_model.clone();
                dm["session"] = session.clone();
                self.author.create_surface(id, &s.catalog_id, &s.components, &dm)
            })
            .collect();
        tracing::info!(target: "a2ui::transport", client, surfaces = snapshot.len(), head = self.state.head, "renderer connected; snapshot replayed");
        for m in &snapshot {
            debug_assert!(schemas().validate_outbound(m).is_ok(), "snapshot fails schema");
        }
        self.send(Some(client), &snapshot, None);
    }

    /// Re-asserts the current component tree on surfaces restored from an
    /// older build of the agent (component drift across restarts).
    fn reconcile_components(&mut self) -> Result<()> {
        let want = catalog::order_ticket_components();
        let stale: Vec<String> =
            self.state.surfaces.iter().filter(|(_, s)| s.components != want).map(|(id, _)| id.clone()).collect();
        for id in stale {
            let msg = self.author.update_components(&id, &want);
            self.commit(kind::SURFACE_COMPONENTS, json!({"surfaceId": id}), vec![msg])?;
            tracing::info!(target: "a2ui::surface", surface = %id, "components updated on resume");
        }
        Ok(())
    }

    fn tick(&mut self, t: Tick) -> Result<()> {
        let q = t.quote;
        self.fresh_quote = Some(q.clone());
        match self.state.surface_for_symbol(&q.ticker) {
            None => {
                let others: Vec<String> = self.state.surfaces.keys().cloned().collect();
                for id in others {
                    let msg = self.author.delete_surface(&id);
                    let fx = self.commit(kind::SURFACE_DELETED, json!({"surfaceId": id, "reason": format!("market changed to {}", q.ticker)}), vec![msg])?;
                    tracing::info!(target: "a2ui::surface", surface = %id, "surface deleted");
                    self.send(None, &fx, None);
                }
                let sid = format!("ticket-{}-{}", &self.state.session_id[..8], self.state.surfaces_created + 1);
                let account = self.broker.account(&q.ticker)?;
                let limit = if q.two_sided() { (q.ask * 100.0).round().clamp(1.0, 99.0) / 100.0 } else { 0.5 };
                let dm = json!({
                    "ticket": {"symbol": q.ticker, "side": "buy", "quantity": 1, "limitPrice": limit,
                               "status": {"state": "idle", "message": "", "orderId": null}},
                    "market": q.market_model(),
                    "account": account,
                    "session": {"id": self.state.session_id, "resumed": self.resumed, "frame": self.state.head + 1},
                });
                let msg = self.author.create_surface(&sid, CATALOG_ID, &catalog::order_ticket_components(), &dm);
                let fx = self.commit(kind::SURFACE_CREATED, json!({"surfaceId": sid, "quote": q}), vec![msg])?;
                tracing::info!(target: "a2ui::surface", surface = %sid, symbol = %q.ticker, "surface created");
                self.send(None, &fx, Some(t.received));
            }
            Some(sid) => {
                if self.state.last_quote.as_ref().is_none_or(|l| !l.same_book(&q)) {
                    let msg = self.author.update_data_model(&sid, "/market", q.market_model());
                    let fx = self.commit(kind::MARKET_QUOTE, json!({"quote": q}), vec![msg])?;
                    self.send(None, &fx, Some(t.received));
                }
            }
        }
        self.resume_pending_calls()
    }

    fn inbound(&mut self, client: ClientId, text: &str) -> Result<()> {
        let msg: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(target: "a2ui::transport", client, error = %e, "dropped non-JSON frame");
                return Ok(());
            }
        };
        if let Err(err) = schemas().validate_inbound(&msg) {
            tracing::warn!(target: "a2ui::schema", client, %err, "dropped inbound frame failing renderer_to_agent.json");
            return Ok(());
        }
        if msg.get("action").is_some() {
            self.action(msg)
        } else if msg.get("callAgentFunction").is_some() {
            self.call(client, msg)
        } else {
            tracing::info!(target: "a2ui::transport", client, msg = %msg, "renderer message recorded");
            self.commit(kind::INBOUND_OTHER, json!({"message": msg}), vec![]).map(drop)
        }
    }

    fn action(&mut self, msg: Value) -> Result<()> {
        let a = &msg["action"];
        let sid = a["surfaceId"].as_str().unwrap_or_default().to_owned();
        let Some(surface) = self.state.surfaces.get(&sid) else {
            self.commit(kind::INBOUND_ACTION, json!({"message": msg, "accepted": false, "reason": "unknown surface"}), vec![])?;
            return Ok(());
        };
        if a["name"] != "ticketEdited" {
            self.commit(kind::INBOUND_ACTION, json!({"message": msg, "accepted": false, "reason": "unknown action"}), vec![])?;
            return Ok(());
        }
        let mut ticket = surface.data_model["ticket"].clone();
        let (accepted, reason) = match validate_edit(&a["context"]) {
            Ok((side, qty, price)) => {
                ticket["side"] = json!(side);
                ticket["quantity"] = json!(qty);
                ticket["limitPrice"] = json!(price);
                ticket["status"] = json!({"state": "editing", "message": "", "orderId": ticket["status"]["orderId"]});
                (true, String::new())
            }
            Err(why) => {
                ticket["status"]["message"] = json!(format!("edit rejected: {why}"));
                (false, why)
            }
        };
        let echo = self.author.update_data_model(&sid, "/ticket", ticket);
        let fx = self.commit(kind::INBOUND_ACTION, json!({"message": msg, "accepted": accepted, "reason": reason}), vec![echo])?;
        tracing::info!(target: "a2ui::surface", surface = %sid, accepted, %reason, "ticket edited");
        if accepted {
            self.pause.hit("mid_edit");
        }
        self.send(None, &fx, None);
        Ok(())
    }

    fn call(&mut self, client: ClientId, msg: Value) -> Result<()> {
        let c = &msg["callAgentFunction"];
        let id = c["functionCallId"].as_str().unwrap_or_default().to_owned();
        let sid = c["surfaceId"].as_str().unwrap_or_default().to_owned();
        if let Some(rec) = self.state.calls.get(&id).cloned() {
            self.commit(kind::INBOUND_CALL_REPEAT, json!({"functionCallId": id, "originalFrame": rec.frame}), vec![])?;
            match rec.response {
                Some(mut resp) => {
                    if resp["agentFunctionResponse"]["value"].is_object() {
                        resp["agentFunctionResponse"]["value"]["duplicate"] = json!(true);
                    }
                    tracing::info!(target: "a2ui::call", call = %id, frame = rec.frame, "repeated functionCallId answered from journal");
                    self.send(Some(client), &[resp], None);
                }
                None => tracing::info!(target: "a2ui::call", call = %id, "repeated functionCallId still executing"),
            }
            return Ok(());
        }
        match self.check_call(Caller::Renderer, c) {
            Err(e) => {
                tracing::warn!(target: "a2ui::call", call = %id, code = e.code, message = %e.message, "function call rejected");
                let mut fx = vec![self.author.function_response(&id, Err(e.clone()))];
                if self.state.surfaces.contains_key(&sid) {
                    fx.push(self.author.update_data_model(&sid, "/ticket/status",
                        json!({"state": "rejected", "message": e.message, "orderId": null})));
                }
                let fx = self.commit(kind::CALL_REJECTED,
                    json!({"message": msg, "functionCallId": id, "surfaceId": sid, "error": {"code": e.code, "message": e.message}}), fx)?;
                self.send(None, &fx, None);
            }
            Ok(req) => {
                let status = self.author.update_data_model(&sid, "/ticket/status", json!({"state": "submitting", "message": "", "orderId": null}));
                let fx = self.commit(kind::INBOUND_CALL,
                    json!({"message": msg, "functionCallId": id, "surfaceId": sid, "request": req}), vec![status])?;
                tracing::info!(target: "a2ui::call", call = %id, frame = self.state.head, "function call accepted");
                self.send(None, &fx, None);
                self.pause.hit("after_call_received");
                self.execute(&id)?;
            }
        }
        Ok(())
    }

    /// Catalog rules + argument checks for one callAgentFunction body.
    pub fn check_call(&self, caller: Caller, c: &Value) -> Result<OrderRequest, FnError> {
        let f = &c["callFunction"];
        let name = f["@call"].as_str().unwrap_or_default();
        let args = f.get("args").cloned().unwrap_or_else(|| json!({}));
        authorize(caller, name, &args, Utc::now())?;
        if f.get("catalogId").is_some_and(|id| id != CATALOG_ID) {
            return Err(FnError::new("CATALOG_MISMATCH", format!("{name} is served by {CATALOG_ID}")));
        }
        if name != SUBMIT_ORDER {
            return Err(FnError::new("UNKNOWN_FUNCTION", format!("{name} is not executed by this agent")));
        }
        let sid = c["surfaceId"].as_str().unwrap_or_default();
        let surface = self.state.surfaces.get(sid)
            .ok_or_else(|| FnError::new("UNKNOWN_SURFACE", format!("no live surface {sid}")))?;
        let (side, quantity, limit_price) = validate_edit(&args).map_err(|e| FnError::new("INVALID_ARGS", e))?;
        let symbol = args["symbol"].as_str().ok_or_else(|| FnError::new("INVALID_ARGS", "symbol must be a resolved string"))?;
        if surface.data_model["ticket"]["symbol"] != symbol {
            return Err(FnError::new("SYMBOL_MISMATCH", format!("surface {sid} trades {}", surface.data_model["ticket"]["symbol"])));
        }
        Ok(OrderRequest { symbol: symbol.to_owned(), side, quantity, limit_price })
    }

    fn resume_pending_calls(&mut self) -> Result<()> {
        let mut pending: Vec<(u64, String)> = self.state.calls.iter()
            .filter(|(_, c)| c.response.is_none() && c.key.is_some())
            .map(|(id, c)| (c.frame, id.clone()))
            .collect();
        pending.sort();
        for (_, id) in pending {
            self.execute(&id)?;
        }
        Ok(())
    }

    /// Places the paper order for an accepted call (deduplicated on its
    /// idempotency key) and commits the answer. Returns false if it has to
    /// wait for this process's first quote.
    fn execute(&mut self, id: &str) -> Result<bool> {
        let rec = self.state.calls[id].clone();
        let (Some(key), Some(req)) = (rec.key.clone(), rec.request.clone()) else { return Ok(false) };
        let (order, duplicate) = match self.broker.get(&key)? {
            Some(o) => (o, true),
            None if self.fresh_quote.is_none() => {
                tracing::info!(target: "a2ui::call", call = %id, "waiting for a live quote before executing");
                return Ok(false);
            }
            None => {
                let placed = self.broker.place(&key, id, &req, self.fresh_quote.as_ref(), Utc::now())?;
                self.pause.hit("after_order_placed");
                placed
            }
        };
        self.answer(id, &rec.surface_id, &key, &order, duplicate)?;
        Ok(true)
    }

    fn answer(&mut self, id: &str, sid: &str, key: &str, order: &Order, duplicate: bool) -> Result<()> {
        let value = json!({
            "orderId": order.order_id, "state": order.state, "filledQty": order.filled_qty,
            "avgPrice": order.avg_price, "idempotencyKey": key, "duplicate": duplicate, "message": order.reason,
        });
        let mut fx = vec![self.author.function_response(id, Ok(value))];
        if self.state.surfaces.contains_key(sid) {
            let state = if order.filled_qty > 0 { "filled" } else { "rejected" };
            fx.push(self.author.update_data_model(sid, "/ticket/status",
                json!({"state": state, "message": order.reason, "orderId": order.order_id})));
            let account = self.broker.account(&order.symbol)?;
            fx.push(self.author.update_data_model(sid, "/account", serde_json::to_value(account)?));
        }
        let fx = self.commit(kind::CALL_ANSWERED, json!({"functionCallId": id, "orderId": order.order_id, "idempotencyKey": key}), fx)?;
        tracing::info!(target: "a2ui::call", call = %id, order = %order.order_id, key, state = %order.state, duplicate, "function call answered");
        self.send(None, &fx, None);
        Ok(())
    }
}

/// Validates ticket fields as resolved literals: side buy|sell, quantity a
/// whole number 1..=10000, limitPrice on the cent grid in 0.01..=0.99.
pub fn validate_edit(ctx: &Value) -> Result<(String, i64, f64), String> {
    let side = match ctx["side"].as_str() {
        Some(s @ ("buy" | "sell")) => s.to_owned(),
        _ => return Err(format!("side must be \"buy\" or \"sell\", got {}", ctx["side"])),
    };
    let qty = ctx["quantity"].as_f64().filter(|q| q.fract() == 0.0 && (1.0..=10000.0).contains(q))
        .ok_or_else(|| format!("quantity must be a whole number 1..10000, got {}", ctx["quantity"]))? as i64;
    let price = ctx["limitPrice"].as_f64().filter(|p| (0.01 - 1e-9..=0.99 + 1e-9).contains(p))
        .ok_or_else(|| format!("limitPrice must be 0.01..0.99, got {}", ctx["limitPrice"]))?;
    let cents = (price * 100.0).round();
    if (price * 100.0 - cents).abs() > 1e-6 {
        return Err(format!("limitPrice must be whole cents, got {price}"));
    }
    Ok((side, qty, cents / 100.0))
}
