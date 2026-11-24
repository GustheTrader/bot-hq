//! Spawns the real `bothq-a2ui-agent` binary on the committed REAL Kalshi
//! replay fixture, drives it over the WebSocket like the renderer, and kills
//! it with SIGKILL at the crash hooks.

use bothq_a2ui_agent::schema::schemas;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn fixture() -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path())
        .filter(|p| p.to_string_lossy().ends_with("_primary.jsonl")).collect();
    v.sort();
    v.pop().unwrap()
}

struct Agent {
    child: Child,
    port: u16,
    stderr: std::sync::mpsc::Receiver<String>,
}

impl Agent {
    fn spawn(db: &Path, port: u16, pause: Option<&str>) -> Self {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bothq-a2ui-agent"));
        cmd.args(["--feed", "replay", "--replay-interval-ms", "100", "--listen", &format!("127.0.0.1:{port}")])
            .arg("--replay-file").arg(fixture()).arg("--db").arg(db)
            .env("RUST_LOG", "info").env_remove("BOTHQ_A2UI_PAUSE_AT")
            .stdout(Stdio::null()).stderr(Stdio::piped());
        if let Some(p) = pause {
            cmd.env("BOTHQ_A2UI_PAUSE_AT", p);
        }
        let mut child = cmd.spawn().unwrap();
        let (tx, stderr) = std::sync::mpsc::channel();
        let pipe = child.stderr.take().unwrap();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });
        Self { child, port, stderr }
    }
    fn wait_stderr(&self, needle: &str, within: Duration) {
        let deadline = Instant::now() + within;
        while let Ok(line) = self.stderr.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            if line.contains(needle) {
                return;
            }
        }
        panic!("agent never printed {needle:?}");
    }
    fn kill9(mut self) {
        self.child.kill().unwrap(); // SIGKILL on Unix
        self.child.wait().unwrap();
    }
    async fn connect(&self) -> Ws {
        let url = format!("ws://127.0.0.1:{}/a2ui/ws", self.port);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match tokio_tungstenite::connect_async(&url).await {
                Ok((ws, _)) => return ws,
                Err(_) if Instant::now() < deadline => tokio::time::sleep(Duration::from_millis(25)).await,
                Err(e) => panic!("connect {url}: {e}"),
            }
        }
    }
    async fn health(&self) -> Value {
        reqwest::get(format!("http://127.0.0.1:{}/a2ui/health", self.port)).await.unwrap().json().await.unwrap()
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

async fn recv(ws: &mut Ws, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let msg = tokio::time::timeout(left, ws.next()).await
            .unwrap_or_else(|_| panic!("timed out waiting for {what}")).expect("socket closed").unwrap();
        if let Message::Text(t) = msg {
            let v: Value = serde_json::from_str(&t).unwrap();
            assert_eq!(schemas().validate_outbound(&v), Ok(()), "agent sent an invalid A2UI message: {v}");
            if pred(&v) {
                return v;
            }
        }
    }
}

async fn send(ws: &mut Ws, v: Value) {
    assert_eq!(schemas().validate_inbound(&v), Ok(()));
    ws.send(Message::Text(v.to_string().into())).await.unwrap();
}

fn edit(sid: &str, qty: i64, price: f64) -> Value {
    json!({"version": "1.0", "action": {"name": "ticketEdited", "surfaceId": sid, "sourceComponentId": "root",
        "timestamp": chrono::Utc::now().to_rfc3339(), "context": {"side": "buy", "quantity": qty, "limitPrice": price}}})
}

fn submit(sid: &str, symbol: &Value, call_id: &str, qty: i64, price: f64) -> Value {
    json!({"version": "1.0", "callAgentFunction": {"surfaceId": sid, "functionCallId": call_id,
        "callFunction": {"@call": "submitOrder", "args": {"symbol": symbol, "side": "buy", "quantity": qty, "limitPrice": price,
            "userActivation": {"type": "click", "isTrusted": true, "timestamp": chrono::Utc::now().to_rfc3339()}}}}})
}

fn is_create(v: &Value) -> bool {
    v.get("createSurface").is_some()
}

fn response_for(id: &str) -> impl Fn(&Value) -> bool + '_ {
    move |v| v["agentFunctionResponse"]["functionCallId"] == id
}

#[tokio::test(flavor = "multi_thread")]
async fn render_price_update_submit_over_websocket() {
    let dir = tempfile::tempdir().unwrap();
    let agent = Agent::spawn(&dir.path().join("a.sqlite"), free_port(), None);
    let mut ws = agent.connect().await;
    let create = recv(&mut ws, "createSurface", is_create).await;
    let cs = &create["createSurface"];
    let sid = cs["surfaceId"].as_str().unwrap().to_owned();
    assert_eq!(cs["catalogId"], "bothq.trading.v0");
    assert_eq!(cs["components"][0]["component"], "OrderTicket");
    let symbol = cs["dataModel"]["ticket"]["symbol"].clone();
    let update = recv(&mut ws, "/market update", |v| v["updateDataModel"]["path"] == "/market").await;
    assert!(update["updateDataModel"]["value"]["ask"].as_f64().unwrap() > 0.0);
    send(&mut ws, edit(&sid, 1, 0.99)).await;
    let echo = recv(&mut ws, "/ticket echo", |v| v["updateDataModel"]["path"] == "/ticket").await;
    assert_eq!(echo["updateDataModel"]["value"]["limitPrice"], 0.99);
    let id = "11111111-2222-4333-8444-555555555555";
    let sent = Instant::now();
    send(&mut ws, submit(&sid, &symbol, id, 1, 0.99)).await;
    let r = recv(&mut ws, "agentFunctionResponse", response_for(id)).await;
    eprintln!("submit round trip {:?}: {}", sent.elapsed(), r);
    let v = &r["agentFunctionResponse"]["value"];
    assert!(v["orderId"].as_str().unwrap().starts_with("paper-"));
    assert_eq!(v["duplicate"], false);
    assert!(["filled", "partially_filled", "rejected"].contains(&v["state"].as_str().unwrap()));
    recv(&mut ws, "/ticket/status", |v| v["updateDataModel"]["path"] == "/ticket/status").await;
    assert_eq!(agent.health().await["orders"], 1);
    drop(ws);
    // Sequential reconnects each get exactly one snapshot of the live surface.
    for _ in 0..3 {
        let mut ws = agent.connect().await;
        let snap = recv(&mut ws, "snapshot", is_create).await;
        assert_eq!(snap["createSurface"]["surfaceId"], json!(sid));
        assert_eq!(snap["createSurface"]["dataModel"]["ticket"]["limitPrice"], 0.99);
    }
}

/// Kill -9 at a crash hook, restart on the same DB, check resume + no duplicate order.
async fn crash_case(point: &str) {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("a.sqlite");
    let port = free_port();
    let agent = Agent::spawn(&db, port, Some(point));
    let mut ws = agent.connect().await;
    let create = recv(&mut ws, "createSurface", is_create).await;
    let sid = create["createSurface"]["surfaceId"].as_str().unwrap().to_owned();
    let session = create["createSurface"]["dataModel"]["session"]["id"].clone();
    let symbol = create["createSurface"]["dataModel"]["ticket"]["symbol"].clone();
    let id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let call = submit(&sid, &symbol, id, 3, 0.99);
    match point {
        "after_render" => {}
        "mid_edit" => send(&mut ws, edit(&sid, 3, 0.99)).await,
        _ => send(&mut ws, call.clone()).await,
    }
    agent.wait_stderr(&format!("PAUSE_POINT {point}"), Duration::from_secs(15));
    agent.kill9();

    let started = Instant::now();
    let agent = Agent::spawn(&db, port, None);
    let mut ws = agent.connect().await;
    let snap = recv(&mut ws, "snapshot", is_create).await;
    let resume = started.elapsed();
    eprintln!("{point}: restart -> snapshot in {resume:?}");
    assert!(resume < Duration::from_secs(5), "{point}: resume took {resume:?}");
    let cs = &snap["createSurface"];
    assert_eq!(cs["surfaceId"], json!(sid));
    assert_eq!(cs["dataModel"]["session"]["id"], session);
    assert_eq!(cs["dataModel"]["session"]["resumed"], true);
    let h = agent.health().await;
    assert_eq!(h["resumed"], true);
    match point {
        "after_render" => assert_eq!(h["orders"], 0),
        "mid_edit" => {
            assert_eq!(cs["dataModel"]["ticket"]["quantity"], 3);
            assert_eq!(cs["dataModel"]["ticket"]["limitPrice"], 0.99);
            assert_eq!(h["orders"], 0);
        }
        _ => {
            // after_call_received: completes once the resumed feed delivers a quote.
            // after_order_placed: answered from the existing order on open.
            let deadline = Instant::now() + Duration::from_secs(10);
            while agent.health().await["orders"] != 1 && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert_eq!(agent.health().await["orders"], 1, "{point}: exactly one order after resume");
        }
    }
    // The renderer re-sends the same functionCallId after reconnecting (or submits fresh).
    send(&mut ws, call.clone()).await;
    let r = recv(&mut ws, "agentFunctionResponse", response_for(id)).await;
    let v = &r["agentFunctionResponse"]["value"];
    let frame_key = v["idempotencyKey"].as_str().unwrap();
    assert!(frame_key.starts_with(&format!("{}:", session.as_str().unwrap())));
    if matches!(point, "after_render" | "mid_edit") {
        assert_eq!(v["duplicate"], false);
        send(&mut ws, call).await;
        let again = recv(&mut ws, "repeat response", response_for(id)).await;
        assert_eq!(again["agentFunctionResponse"]["value"]["duplicate"], true);
        assert_eq!(again["agentFunctionResponse"]["value"]["orderId"], v["orderId"]);
    } else {
        assert_eq!(v["duplicate"], true, "{point}: {r}");
    }
    assert_eq!(agent.health().await["orders"], 1, "{point}: zero duplicate orders");
}

#[tokio::test(flavor = "multi_thread")]
async fn crash_after_render() {
    crash_case("after_render").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn crash_mid_edit() {
    crash_case("mid_edit").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn crash_after_call_received() {
    crash_case("after_call_received").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn crash_after_order_placed() {
    crash_case("after_order_placed").await;
}
