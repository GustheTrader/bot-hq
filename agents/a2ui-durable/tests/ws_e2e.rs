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

fn agent_cmd() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_bothq-a2ui-agent"));
    for v in ["BOTHQ_A2UI_PAUSE_AT", "BOTHQ_A2UI_TOKEN", "BOTHQ_A2UI_LISTEN", "BOTHQ_A2UI_DB", "BOTHQ_A2UI_FEED", "BOTHQ_A2UI_POLL_MS"] {
        cmd.env_remove(v);
    }
    cmd.env("RUST_LOG", "info");
    cmd
}

impl Agent {
    /// Binds port 0 and learns the real port from the agent's `LISTENING <addr>`
    /// line, so concurrently running tests can never collide on a port.
    fn spawn(db: &Path, pause: Option<&str>) -> Self {
        Self::spawn_with(db, pause, None)
    }
    fn spawn_with(db: &Path, pause: Option<&str>, token: Option<&str>) -> Self {
        let mut cmd = agent_cmd();
        cmd.args(["--feed", "replay", "--replay-interval-ms", "100", "--listen", "127.0.0.1:0"])
            .arg("--replay-file").arg(fixture()).arg("--db").arg(db)
            .stdout(Stdio::null()).stderr(Stdio::piped());
        if let Some(p) = pause {
            cmd.env("BOTHQ_A2UI_PAUSE_AT", p);
        }
        if let Some(t) = token {
            cmd.env("BOTHQ_A2UI_TOKEN", t);
        }
        let mut child = cmd.spawn().unwrap();
        let (tx, stderr) = std::sync::mpsc::channel();
        let pipe = child.stderr.take().unwrap();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });
        let deadline = Instant::now() + Duration::from_secs(15);
        let port = loop {
            let line = stderr.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|_| panic!("agent never printed LISTENING"));
            if let Some(addr) = line.strip_prefix("LISTENING ") {
                break addr.trim().parse::<std::net::SocketAddr>().unwrap().port();
            }
        };
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
    let agent = Agent::spawn(&dir.path().join("a.sqlite"), None);
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
        // Keep reading briefly: no second createSurface may follow.
        let until = Instant::now() + Duration::from_millis(400);
        while let Ok(Some(Ok(msg))) = tokio::time::timeout(until.saturating_duration_since(Instant::now()), ws.next()).await {
            if let Message::Text(t) = msg {
                let v: Value = serde_json::from_str(&t).unwrap();
                assert!(!is_create(&v), "second createSurface on one connection: {v}");
            }
        }
    }
}

/// Kill -9 at a crash hook, restart on the same DB, check resume + no duplicate order.
async fn crash_case(point: &str) {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("a.sqlite");
    let agent = Agent::spawn(&db, Some(point));
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
    let agent = Agent::spawn(&db, None);
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

#[tokio::test(flavor = "multi_thread")]
async fn token_is_required_on_both_routes_when_configured() {
    let dir = tempfile::tempdir().unwrap();
    let token = "test-token-0123456789";
    let agent = Agent::spawn_with(&dir.path().join("a.sqlite"), None, Some(token));
    let base = format!("http://127.0.0.1:{}", agent.port);
    let http = reqwest::Client::new();
    assert_eq!(http.get(format!("{base}/a2ui/health")).send().await.unwrap().status(), 401);
    let wrong = http.get(format!("{base}/a2ui/health")).header("x-bothq-a2ui-token", "test-token-0123456780").send().await.unwrap();
    assert_eq!(wrong.status(), 401);
    let ok = http.get(format!("{base}/a2ui/health")).header("x-bothq-a2ui-token", token).send().await.unwrap();
    assert_eq!(ok.status(), 200);
    let url = format!("ws://127.0.0.1:{}/a2ui/ws", agent.port);
    match tokio_tungstenite::connect_async(&url).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(r)) => assert_eq!(r.status(), 401),
        other => panic!("upgrade without a token must be refused with 401, got {:?}", other.map(|_| ())),
    }
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut req = url.into_client_request().unwrap();
    req.headers_mut().insert("x-bothq-a2ui-token", token.parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    recv(&mut ws, "createSurface", is_create).await;
}

#[test]
fn refuses_non_loopback_without_token_and_zero_poll_period() {
    let dir = tempfile::tempdir().unwrap();
    let out = agent_cmd()
        .args(["--feed", "replay", "--listen", "0.0.0.0:0"]).arg("--replay-file").arg(fixture())
        .arg("--db").arg(dir.path().join("a.sqlite")).output().unwrap();
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("BOTHQ_A2UI_TOKEN"), "{err}");
    assert!(!dir.path().join("a.sqlite").exists(), "refused before opening the database");
    let out = agent_cmd().args(["--poll-ms", "0", "--db"]).arg(dir.path().join("b.sqlite")).output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("--poll-ms"));
}
