//! Axum transport: `GET /a2ui/ws` (one raw A2UI v1.0 message per text frame)
//! and `GET /a2ui/health`.

use crate::agent::{Event, Health, Outbound};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

#[derive(Clone)]
pub struct App {
    pub events: UnboundedSender<Event>,
    pub health: Arc<RwLock<Health>>,
    next_client: Arc<AtomicU64>,
}

impl App {
    pub fn new(events: UnboundedSender<Event>, health: Arc<RwLock<Health>>) -> Self {
        Self { events, health, next_client: Arc::new(AtomicU64::new(1)) }
    }
}

pub fn router(app: App) -> Router {
    Router::new().route("/a2ui/ws", get(ws)).route("/a2ui/health", get(health)).with_state(app)
}

async fn health(State(app): State<App>) -> Json<Health> {
    Json(app.health.read().unwrap().clone())
}

async fn ws(ws: WebSocketUpgrade, State(app): State<App>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| client(socket, app))
}

async fn client(socket: WebSocket, app: App) {
    let client = app.next_client.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = unbounded_channel::<Outbound>();
    if app.events.send(Event::Connect { client, tx }).is_err() {
        return;
    }
    let (mut sink, mut stream) = socket.split();
    let writer = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            if sink.send(Message::Text(out.text.into())).await.is_err() {
                break;
            }
            if let Some(t) = out.feed_received {
                tracing::info!(target: "a2ui::latency", client, us = t.elapsed().as_micros() as u64, "feed receive -> ws send");
            }
        }
    });
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => {
                if app.events.send(Event::Inbound { client, text: text.to_string() }).is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    let _ = app.events.send(Event::Disconnect { client });
    writer.abort();
}
