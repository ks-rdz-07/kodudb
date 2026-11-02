//! Realtime: Postgres NOTIFY -> broadcast channel -> WebSocket subscribers, filtered by RLS.
use std::{
    collections::{HashMap, HashSet, VecDeque},
    hash::{Hash, Hasher},
    sync::Arc,
};

use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, Query, State},
    http::{header, HeaderMap, HeaderValue},
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast::error::RecvError, OnceCell};

use crate::ctx::{ident, role, scoped, AppState, R};

pub const CHANNEL: &str = "kodudb_realtime";

#[derive(Deserialize)]
pub struct WsQuery {
    apikey: Option<String>,
    token: Option<String>,
}

/// Browsers cannot set WebSocket headers, so keys come as ?apikey=&token=.
pub async fn ws(State(st): State<AppState>, Query(q): Query<WsQuery>, upgrade: WebSocketUpgrade) -> R<Response> {
    let mut h = HeaderMap::new();
    if let Some(v) = q.token.and_then(|t| HeaderValue::from_str(&format!("Bearer {t}")).ok()) {
        h.insert(header::AUTHORIZATION, v);
    }
    let c = st.claims(&h, q.apikey.as_deref())?;
    Ok(upgrade.on_upgrade(move |sock| run(st, c, sock)))
}

#[derive(Deserialize)]
struct ClientMsg {
    #[serde(rename = "type")]
    kind: String,
    table: String,
}

async fn run(st: AppState, c: Value, sock: WebSocket) {
    let (mut out, mut inbox) = sock.split();
    let mut events = st.realtime.subscribe();
    let mut tables: HashSet<String> = HashSet::new();
    loop {
        tokio::select! {
            msg = inbox.next() => match msg {
                Some(Ok(Message::Text(t))) => {
                    let reply = match serde_json::from_str::<ClientMsg>(t.as_str()) {
                        Ok(m) if m.table == "*" || ident(&m.table).is_ok() => {
                            match m.kind.as_str() {
                                "subscribe" => { tables.insert(m.table.clone()); json!({"type": "subscribed", "table": m.table}) }
                                "unsubscribe" => { tables.remove(&m.table); json!({"type": "unsubscribed", "table": m.table}) }
                                _ => json!({"type": "error", "error": "type must be subscribe or unsubscribe"}),
                            }
                        }
                        _ => json!({"type": "error", "error": "expected {\"type\":\"subscribe\",\"table\":\"<name>|*\"}"}),
                    };
                    if out.send(Message::Text(reply.to_string().into())).await.is_err() { break; }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            ev = events.recv() => match ev {
                Ok(payload) => {
                    let Ok(v) = serde_json::from_str::<Value>(&payload) else { continue };
                    let table = v["table"].as_str().unwrap_or_default();
                    if v["schema"] != "public" || !(tables.contains(table) || tables.contains("*")) { continue; }
                    if visible(&st, &c, table, &v, &payload).await && out.send(Message::Text(payload.into())).await.is_err() { break; }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            },
        }
    }
}

/// Non-service subscribers only see rows their RLS policies let them select.
/// One visibility answer per (event, caller): every socket of the same user waits on a single check
/// instead of each running its own query.
#[derive(Default)]
pub struct VisibilityCache {
    /// Row-security checks actually run (reported in /meta/v1/stats as realtime_checks).
    pub checks: std::sync::atomic::AtomicU64,
    inner: tokio::sync::Mutex<(HashMap<(u64, String), Arc<OnceCell<bool>>>, VecDeque<(u64, String)>)>,
}

const CACHE_CAP: usize = 4096;

impl VisibilityCache {
    async fn cell(&self, key: (u64, String)) -> Arc<OnceCell<bool>> {
        let mut guard = self.inner.lock().await;
        let (map, order) = &mut *guard;
        if let Some(c) = map.get(&key) {
            return c.clone();
        }
        let c = Arc::new(OnceCell::new());
        map.insert(key.clone(), c.clone());
        order.push_back(key);
        while order.len() > CACHE_CAP {
            if let Some(old) = order.pop_front() {
                map.remove(&old);
            }
        }
        c
    }
}

async fn visible(st: &AppState, c: &Value, table: &str, ev: &Value, payload: &str) -> bool {
    if role(c) == "service_role" {
        return true;
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    payload.hash(&mut h);
    let caller = format!("{}:{}", role(c), c["sub"].as_str().unwrap_or(""));
    let cell = st.visibility.cell((h.finish(), caller)).await;
    *cell.get_or_init(|| check(st, c, table, ev)).await
}

async fn check(st: &AppState, c: &Value, table: &str, ev: &Value) -> bool {
    st.visibility.checks.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // shortcut: deleted rows can't be re-checked against RLS, so only service_role receives DELETE events.
    let id = &ev["record"]["id"];
    if ev["type"] == "DELETE" || id.is_null() || ident(table).is_err() {
        return false;
    }
    let id = id.as_str().map(str::to_string).unwrap_or_else(|| id.to_string());
    let Ok(mut tx) = scoped(&st.pool, c).await else { return false };
    let seen: Result<bool, _> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("select exists(select 1 from public.\"{table}\" where id::text = $1)")))
        .bind(id)
        .fetch_one(&mut *tx)
        .await;
    seen.unwrap_or(false)
}

/// LISTEN on a project's database and fan notifications out to WebSocket subscribers.
/// The returned task handle is aborted when the project is unloaded.
pub async fn spawn_listener(pool: &sqlx::PgPool) -> Result<(tokio::sync::broadcast::Sender<String>, tokio::task::JoinHandle<()>), sqlx::Error> {
    let (tx, _) = tokio::sync::broadcast::channel(1024);
    let mut listener = sqlx::postgres::PgListener::connect_with(pool).await?;
    listener.listen(CHANNEL).await?;
    let fanout = tx.clone();
    let handle = tokio::spawn(async move {
        loop {
            match listener.recv().await {
                Ok(n) => {
                    let _ = fanout.send(n.payload().to_string());
                }
                Err(e) => {
                    eprintln!("realtime listener: {e}");
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        }
    });
    Ok((tx, handle))
}
