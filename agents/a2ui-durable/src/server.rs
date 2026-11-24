//! Axum transport: `GET /a2ui/ws` (one raw A2UI v1.0 message per text frame)
//! and `GET /a2ui/health`.
//!
//! Access: when a token is configured (`BOTHQ_A2UI_TOKEN` / `--token`), both
//! routes require the header `x-bothq-a2ui-token: <token>` (constant-time
//! compare) and answer HTTP 401 before any upgrade otherwise. `main` refuses
//! to listen on a non-loopback address without a token.
//!
//! Back-pressure policy (all queues are bounded):
//! - Inbound frames larger than [`MAX_INBOUND_BYTES`] are refused by the
//!   WebSocket layer (the connection is closed).
//! - The agent's event queue holds [`EVENT_QUEUE`] events. If it is full when a
//!   client frame arrives, that client is flooding (or the agent is stuck): the
//!   frame is dropped and the client is disconnected. It gets a fresh snapshot
//!   when it reconnects.
//! - Each client's outbound queue holds [`CLIENT_QUEUE`] messages. A client
//!   that falls that far behind is dropped by the agent (its queue is closed,
//!   which closes the socket); a send that takes longer than [`SEND_TIMEOUT`]
//!   also closes it. A reconnect gets a snapshot, so nothing is lost but
//!   intermediate updates.

use crate::agent::{Event, Health, Outbound};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::sync::mpsc::{self, error::TrySendError, Sender};

pub const TOKEN_HEADER: &str = "x-bothq-a2ui-token";
/// Largest accepted inbound WebSocket message / frame.
pub const MAX_INBOUND_BYTES: usize = 64 * 1024;
/// Capacity of the agent's event queue (all clients plus the feed).
pub const EVENT_QUEUE: usize = 1024;
/// Capacity of one client's outbound queue.
pub const CLIENT_QUEUE: usize = 256;
/// Longest a single WebSocket send may take before the client is dropped.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct App {
    pub events: Sender<Event>,
    pub health: Arc<RwLock<Health>>,
    token: Option<Arc<str>>,
    next_client: Arc<AtomicU64>,
}

impl App {
    /// `token`: when `Some`, every request must carry it in [`TOKEN_HEADER`].
    pub fn new(events: Sender<Event>, health: Arc<RwLock<Health>>, token: Option<String>) -> Self {
        Self { events, health, token: token.filter(|t| !t.is_empty()).map(Into::into), next_client: Arc::new(AtomicU64::new(1)) }
    }

    fn authorized(&self, headers: &HeaderMap) -> bool {
        let Some(want) = &self.token else { return true };
        headers.get(TOKEN_HEADER).is_some_and(|got| constant_time_eq(got.as_bytes(), want.as_bytes()))
    }
}

/// Compares in time independent of where the inputs differ (the length is not
/// secret: it only leaks whether the lengths match).
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn router(app: App) -> Router {
    Router::new().route("/a2ui/ws", get(ws)).route("/a2ui/health", get(health)).with_state(app)
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, format!("missing or wrong {TOKEN_HEADER}\n")).into_response()
}

async fn health(State(app): State<App>, headers: HeaderMap) -> Response {
    if !app.authorized(&headers) {
        return unauthorized();
    }
    Json(app.health.read().unwrap().clone()).into_response()
}

async fn ws(State(app): State<App>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    if !app.authorized(&headers) {
        tracing::warn!(target: "a2ui::transport", "rejected WebSocket upgrade without a valid token");
        return unauthorized();
    }
    ws.max_message_size(MAX_INBOUND_BYTES)
        .max_frame_size(MAX_INBOUND_BYTES)
        .on_upgrade(move |socket| client(socket, app))
        .into_response()
}

async fn client(socket: WebSocket, app: App) {
    let client = app.next_client.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::channel::<Outbound>(CLIENT_QUEUE);
    if app.events.send(Event::Connect { client, tx }).await.is_err() {
        return;
    }
    let (mut sink, mut stream) = socket.split();
    let mut writer = tokio::spawn(async move {
        // Ends when the agent drops this client's queue (slow client), a send
        // fails, or a send times out.
        while let Some(out) = rx.recv().await {
            match tokio::time::timeout(SEND_TIMEOUT, sink.send(Message::Text(out.text.into()))).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => return,
                Err(_) => {
                    tracing::warn!(target: "a2ui::transport", client, "send timed out; dropping client");
                    return;
                }
            }
            if let Some(t) = out.feed_received {
                tracing::info!(target: "a2ui::latency", client, us = t.elapsed().as_micros() as u64, "feed receive -> ws send");
            }
        }
    });
    let mut writer_done = false;
    loop {
        tokio::select! {
            _ = &mut writer => { writer_done = true; break }
            msg = stream.next() => match msg {
                Some(Ok(Message::Text(text))) => {
                    match app.events.try_send(Event::Inbound { client, text: text.to_string() }) {
                        Ok(()) => {}
                        Err(TrySendError::Full(_)) => {
                            tracing::warn!(target: "a2ui::transport", client, "agent event queue full; dropping frame and client");
                            break;
                        }
                        Err(TrySendError::Closed(_)) => break,
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
        }
    }
    // Deregister so the agent stops queueing for this client, then drop both
    // socket halves, which closes the connection.
    let _ = app.events.send(Event::Disconnect { client }).await;
    if !writer_done {
        writer.abort();
    }
}
