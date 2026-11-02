//! Built-in connectors to external databases: Postgres, MySQL/MariaDB, SQL Server, MongoDB.
use std::time::{Duration, Instant};

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use futures_util::TryStreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Column, Row};
use tokio_util::compat::TokioAsyncWriteCompatExt;

use crate::ctx::{err, json_response, require_service, AppState, ApiError, R};

const KINDS: [&str; 4] = ["postgres", "mysql", "mssql", "mongodb"];
const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ROWS: usize = 1000;

fn secret() -> String {
    ["ENCRYPTION_KEY", "CONNECTOR_KEY", "JWT_SECRET"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
        .unwrap_or_default()
}

fn bad(e: impl std::fmt::Display) -> ApiError {
    err(StatusCode::BAD_GATEWAY, e.to_string())
}

/// host[:port] for display, never the credentials.
pub fn host_hint(kind: &str, url: &str) -> String {
    if kind == "mssql" {
        return url
            .split(';')
            .find_map(|p| p.split_once('=').filter(|(k, _)| matches!(k.trim().to_ascii_lowercase().as_str(), "server" | "data source")).map(|(_, v)| v.trim().to_string()))
            .unwrap_or_default();
    }
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let host = rest.rsplit_once('@').map(|(_, h)| h).unwrap_or(rest);
    host.split(['/', '?']).next().unwrap_or_default().to_string()
}

pub async fn list(State(st): State<AppState>, headers: HeaderMap) -> R<Response> {
    require_service(&st.claims(&headers, None)?)?;
    let out: String = sqlx::query_scalar(
        "select coalesce(jsonb_agg(x order by x.name), '[]')::text from (
           select id, name, kind, host_hint, created_at from kodudb.connections) x",
    )
    .fetch_one(&st.pool)
    .await?;
    Ok(json_response(out))
}

#[derive(Deserialize)]
pub struct NewConn {
    name: String,
    kind: String,
    url: String,
}

pub async fn create(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<NewConn>) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    if !KINDS.contains(&b.kind.as_str()) {
        return Err(err(StatusCode::BAD_REQUEST, format!("kind must be one of {KINDS:?}")));
    }
    if b.name.trim().is_empty() || b.url.trim().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "name and url are required"));
    }
    let row: Value = sqlx::query_scalar(
        "insert into kodudb.connections (name, kind, url_encrypted, host_hint)
         values ($1, $2, pgp_sym_encrypt($3, $4), $5)
         returning jsonb_build_object('id', id, 'name', name, 'kind', kind, 'host_hint', host_hint, 'created_at', created_at)",
    )
    .bind(b.name.trim())
    .bind(&b.kind)
    .bind(b.url.trim())
    .bind(secret())
    .bind(host_hint(&b.kind, &b.url))
    .fetch_one(&st.pool)
    .await?;
    Ok(Json(row))
}

pub async fn remove(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> R<StatusCode> {
    require_service(&st.claims(&headers, None)?)?;
    let n = sqlx::query("delete from kodudb.connections where id = $1::uuid").bind(id).execute(&st.pool).await?.rows_affected();
    if n == 0 { Err(err(StatusCode::NOT_FOUND, "connection not found")) } else { Ok(StatusCode::NO_CONTENT) }
}

async fn load(st: &AppState, id: &str) -> R<(String, String)> {
    sqlx::query_as("select kind, pgp_sym_decrypt(url_encrypted, $2) from kodudb.connections where id = $1::uuid")
        .bind(id)
        .bind(secret())
        .fetch_optional(&st.pool)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "connection not found"))
}

/// Tabular result shared by every connector.
#[derive(Default)]
struct Table {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
}

impl Table {
    fn json(self, started: Instant) -> Value {
        let truncated = self.rows.len() >= MAX_ROWS;
        json!({ "columns": self.columns, "rows": self.rows, "row_count": self.rows.len(), "truncated": truncated, "ms": started.elapsed().as_millis() })
    }
}

// shortcut: a fresh connection per request; add per-connection pools if connectors see heavy traffic.
async fn run_sql_pg(url: &str, sql: &str) -> R<Table> {
    // A one-connection pool (not &mut PgConnection) keeps the handler future Send with raw_sql.
    let pool = sqlx::postgres::PgPoolOptions::new().max_connections(1).acquire_timeout(Duration::from_secs(10)).connect(url).await.map_err(bad)?;
    let rows = sqlx::raw_sql(sql).fetch_all(&pool).await.map_err(bad);
    pool.close().await;
    let rows = rows?;
    Ok(Table {
        columns: rows.first().map(|r| r.columns().iter().map(|c| c.name().to_string()).collect()).unwrap_or_default(),
        rows: rows
            .iter()
            .take(MAX_ROWS)
            .map(|r| (0..r.columns().len()).map(|i| r.try_get_unchecked::<Option<String>, _>(i).ok().flatten().map(Value::String).unwrap_or(Value::Null)).collect())
            .collect(),
    })
}

async fn run_sql_mysql(url: &str, sql: &str) -> R<Table> {
    let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(1).acquire_timeout(Duration::from_secs(10)).connect(url).await.map_err(bad)?;
    // Text protocol (raw_sql) returns every value as text, so any column type renders.
    let rows = sqlx::raw_sql(sql).fetch_all(&pool).await.map_err(bad);
    pool.close().await;
    let rows = rows?;
    Ok(Table {
        columns: rows.first().map(|r| r.columns().iter().map(|c| c.name().to_string()).collect()).unwrap_or_default(),
        rows: rows
            .iter()
            .take(MAX_ROWS)
            .map(|r| {
                (0..r.columns().len())
                    .map(|i| match r.try_get_unchecked::<Option<Vec<u8>>, _>(i) {
                        Ok(Some(b)) => Value::String(String::from_utf8_lossy(&b).into_owned()),
                        _ => Value::Null,
                    })
                    .collect()
            })
            .collect(),
    })
}

fn mssql_value(d: &tiberius::ColumnData<'_>) -> Value {
    use tiberius::ColumnData as C;
    match d {
        C::U8(v) => v.map(Value::from).unwrap_or(Value::Null),
        C::I16(v) => v.map(Value::from).unwrap_or(Value::Null),
        C::I32(v) => v.map(Value::from).unwrap_or(Value::Null),
        C::I64(v) => v.map(Value::from).unwrap_or(Value::Null),
        C::F32(v) => v.map(Value::from).unwrap_or(Value::Null),
        C::F64(v) => v.map(Value::from).unwrap_or(Value::Null),
        C::Bit(v) => v.map(Value::from).unwrap_or(Value::Null),
        C::String(v) => v.as_ref().map(|s| Value::String(s.to_string())).unwrap_or(Value::Null),
        C::Guid(v) => v.map(|g| Value::String(g.to_string())).unwrap_or(Value::Null),
        C::Numeric(v) => v.map(|n| Value::String(n.to_string())).unwrap_or(Value::Null),
        C::Binary(v) => v.as_ref().map(|b| Value::String(format!("<{} bytes>", b.len()))).unwrap_or(Value::Null),
        other => Value::String(format!("{other:?}")),
    }
}

async fn mssql_client(url: &str) -> R<tiberius::Client<tokio_util::compat::Compat<tokio::net::TcpStream>>> {
    let config = tiberius::Config::from_ado_string(url).map_err(bad)?;
    let tcp = tokio::net::TcpStream::connect(config.get_addr()).await.map_err(bad)?;
    tcp.set_nodelay(true).map_err(bad)?;
    tiberius::Client::connect(config, tcp.compat_write()).await.map_err(bad)
}

async fn run_sql_mssql(url: &str, sql: &str) -> R<Table> {
    let mut client = mssql_client(url).await?;
    let mut stream = client.simple_query(sql).await.map_err(bad)?;
    let mut t = Table::default();
    while let Some(item) = stream.try_next().await.map_err(bad)? {
        match item {
            tiberius::QueryItem::Metadata(m) if t.columns.is_empty() => {
                t.columns = m.columns().iter().map(|c| c.name().to_string()).collect();
            }
            tiberius::QueryItem::Row(r) if t.rows.len() < MAX_ROWS && r.result_index() == 0 => {
                t.rows.push(r.cells().map(|(_, d)| mssql_value(d)).collect());
            }
            _ => {}
        }
    }
    Ok(t)
}

#[derive(Deserialize)]
pub struct MongoQuery {
    collection: String,
    #[serde(default)]
    filter: Option<Value>,
    #[serde(default)]
    pipeline: Option<Vec<Value>>,
    #[serde(default)]
    limit: Option<i64>,
}

async fn mongo_db(url: &str) -> R<mongodb::Database> {
    let client = mongodb::Client::with_uri_str(url).await.map_err(bad)?;
    client.default_database().ok_or_else(|| err(StatusCode::BAD_REQUEST, "MongoDB URL must include a database name, e.g. mongodb://host/mydb"))
}

fn to_doc(v: Value) -> R<mongodb::bson::Document> {
    mongodb::bson::to_document(&v).map_err(|e| err(StatusCode::BAD_REQUEST, format!("invalid filter: {e}")))
}

async fn run_mongo(url: &str, q: MongoQuery) -> R<Table> {
    let db = mongo_db(url).await?;
    let coll = db.collection::<mongodb::bson::Document>(&q.collection);
    let limit = q.limit.unwrap_or(100).clamp(1, MAX_ROWS as i64);
    let docs: Vec<mongodb::bson::Document> = if let Some(p) = q.pipeline {
        let mut stages = p.into_iter().map(to_doc).collect::<R<Vec<_>>>()?;
        stages.push(mongodb::bson::doc! { "$limit": limit });
        coll.aggregate(stages).await.map_err(bad)?.try_collect().await.map_err(bad)?
    } else {
        let filter = to_doc(q.filter.unwrap_or_else(|| json!({})))?;
        coll.find(filter).limit(limit).await.map_err(bad)?.try_collect().await.map_err(bad)?
    };
    let mut columns: Vec<String> = Vec::new();
    for d in &docs {
        for k in d.keys() {
            if !columns.contains(k) {
                columns.push(k.clone());
            }
        }
    }
    let rows = docs
        .into_iter()
        .map(|d| {
            let v = mongodb::bson::Bson::Document(d).into_relaxed_extjson();
            columns.iter().map(|c| v.get(c).cloned().unwrap_or(Value::Null)).collect()
        })
        .collect();
    Ok(Table { columns, rows })
}

async fn with_timeout<T>(f: impl std::future::Future<Output = R<T>>) -> R<T> {
    tokio::time::timeout(TIMEOUT, f).await.map_err(|_| err(StatusCode::GATEWAY_TIMEOUT, "connector timed out after 30s"))?
}

pub async fn test(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    let (kind, url) = load(&st, &id).await?;
    let started = Instant::now();
    let version = with_timeout(async {
        let t = match kind.as_str() {
            "postgres" => run_sql_pg(&url, "select version()").await?,
            "mysql" => run_sql_mysql(&url, "select version()").await?,
            "mssql" => run_sql_mssql(&url, "select @@version").await?,
            _ => {
                let db = mongo_db(&url).await?;
                let info = db.run_command(mongodb::bson::doc! { "buildInfo": 1 }).await.map_err(bad)?;
                return Ok(Value::String(format!("MongoDB {}", info.get_str("version").unwrap_or("?"))));
            }
        };
        Ok(t.rows.first().and_then(|r| r.first()).cloned().unwrap_or(Value::Null))
    })
    .await?;
    Ok(Json(json!({ "ok": true, "version": version, "ms": started.elapsed().as_millis() })))
}

pub async fn objects(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    let (kind, url) = load(&st, &id).await?;
    let started = Instant::now();
    let t = with_timeout(async {
        match kind.as_str() {
            "postgres" => run_sql_pg(&url, "select table_schema as schema, table_name as name, table_type as type from information_schema.tables where table_schema not in ('pg_catalog','information_schema') order by 1, 2").await,
            "mysql" => run_sql_mysql(&url, "select table_schema as `schema`, table_name as name, table_type as type from information_schema.tables where table_schema = database() order by 2").await,
            "mssql" => run_sql_mssql(&url, "select table_schema as [schema], table_name as name, table_type as type from information_schema.tables order by 1, 2").await,
            _ => {
                let names = mongo_db(&url).await?.list_collection_names().await.map_err(bad)?;
                Ok(Table { columns: vec!["name".into()], rows: names.into_iter().map(|n| vec![Value::String(n)]).collect() })
            }
        }
    })
    .await?;
    Ok(Json(t.json(started)))
}

pub async fn query(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<Value>) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    let (kind, url) = load(&st, &id).await?;
    let started = Instant::now();
    let t = with_timeout(async {
        if kind == "mongodb" {
            let q: MongoQuery = serde_json::from_value(b).map_err(|e| err(StatusCode::BAD_REQUEST, format!("expected {{collection, filter?|pipeline?, limit?}}: {e}")))?;
            return run_mongo(&url, q).await;
        }
        let sql = b["query"].as_str().filter(|s| !s.trim().is_empty()).ok_or_else(|| err(StatusCode::BAD_REQUEST, "query is required"))?;
        match kind.as_str() {
            "postgres" => run_sql_pg(&url, sql).await,
            "mysql" => run_sql_mysql(&url, sql).await,
            _ => run_sql_mssql(&url, sql).await,
        }
    })
    .await?;
    Ok(Json(t.json(started)))
}

#[cfg(test)]
mod tests {
    use super::host_hint;

    #[test]
    fn host_hint_hides_credentials() {
        assert_eq!(host_hint("mysql", "mysql://root:secret@db.example.com:3306/app"), "db.example.com:3306");
        assert_eq!(host_hint("postgres", "postgres://u:p@10.0.0.5/app?sslmode=require"), "10.0.0.5");
        assert_eq!(host_hint("mongodb", "mongodb://u:p@mongo:27017/app"), "mongo:27017");
        assert_eq!(host_hint("mssql", "server=tcp:sql.local,1433;user=sa;password=secret;database=app"), "tcp:sql.local,1433");
        assert!(!host_hint("mysql", "mysql://root:secret@h/db").contains("secret"));
    }
}

