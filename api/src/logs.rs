//! Request logging middleware, batched writer, metrics and log/history queries.
use std::time::{Duration, Instant};

use axum::{
    extract::{MatchedPath, Query, Request, State},
    http::HeaderMap,
    middleware::Next,
    response::Response,
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use sqlx::PgPool;
use tokio::sync::mpsc;

use axum::extract::FromRequestParts;

use crate::ctx::{ClientIp, ident, json_response, require_service, AppState, R};

pub struct Entry {
    project: String,
    method: String,
    path: String,
    route: Option<String>,
    status: i32,
    ms: f32,
    ip: Option<String>,
}

const BATCH: usize = 500;
const RETENTION_DAYS: i32 = 14;

/// Paths not worth logging: health checks and the observability endpoints themselves.
fn skip(path: &str) -> bool {
    path == "/health" || path.starts_with("/meta/v1/logs") || path.starts_with("/meta/v1/metrics")
}

pub async fn middleware(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let started = Instant::now();
    let method = req.method().to_string();
    let path = req.uri().path().to_string();
    let route = req.extensions().get::<MatchedPath>().map(|m| m.as_str().to_string());
    let (mut parts, body) = req.into_parts();
    let ClientIp(ip) = ClientIp::from_request_parts(&mut parts, &()).await.unwrap_or(ClientIp(None));
    let req = Request::from_parts(parts, body);
    let res = next.run(req).await;
    if !skip(&path) && st.settings.read().unwrap().request_logging {
        // Dropping entries under extreme load beats slowing requests down.
        let _ = st.logs.try_send(Entry { project: st.project.clone(), method, path, route, status: res.status().as_u16() as i32, ms: started.elapsed().as_secs_f32() * 1000.0, ip });
    }
    res
}

/// Delete rows older than their project's retention (default 14 days), for one project or all.
pub async fn prune(pool: &PgPool, project: Option<&str>) {
    let r = sqlx::query(
        "delete from kodudb.request_log l where ($2::text is null or l.project = $2) and l.at < now() - make_interval(days =>
           coalesce((select (p.settings->>'log_retention_days')::int from platform.projects p where p.slug = l.project), $1))",
    )
    .bind(RETENTION_DAYS)
    .bind(project)
    .execute(pool)
    .await;
    if let Err(e) = r {
        eprintln!("request log prune failed: {e}");
    }
}

/// Writes log entries in batches (up to BATCH or every second) and prunes old rows hourly.
pub fn spawn_writer(pool: PgPool) -> mpsc::Sender<Entry> {
    let (tx, mut rx) = mpsc::channel::<Entry>(10_000);
    tokio::spawn(async move {
        let mut buf = Vec::with_capacity(BATCH);
        let mut last_prune = Instant::now() - Duration::from_secs(3600);
        loop {
            let got = tokio::time::timeout(Duration::from_secs(1), rx.recv_many(&mut buf, BATCH)).await;
            if matches!(got, Ok(0)) {
                break; // channel closed
            }
            if !buf.is_empty() {
                let rows = std::mem::take(&mut buf);
                let r = sqlx::query(
                    "insert into kodudb.request_log (method, path, route, status, ms, ip, project)
                     select * from unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::real[], $6::text[], $7::text[])",
                )
                .bind(rows.iter().map(|e| e.method.clone()).collect::<Vec<_>>())
                .bind(rows.iter().map(|e| e.path.clone()).collect::<Vec<_>>())
                .bind(rows.iter().map(|e| e.route.clone()).collect::<Vec<_>>())
                .bind(rows.iter().map(|e| e.status).collect::<Vec<_>>())
                .bind(rows.iter().map(|e| e.ms).collect::<Vec<_>>())
                .bind(rows.iter().map(|e| e.ip.clone()).collect::<Vec<_>>())
                .bind(rows.iter().map(|e| e.project.clone()).collect::<Vec<_>>())
                .execute(&pool)
                .await;
                if let Err(e) = r {
                    eprintln!("request log write failed: {e}");
                }
            }
            if last_prune.elapsed() > Duration::from_secs(3600) {
                last_prune = Instant::now();
                prune(&pool, None).await;
            }
        }
    });
    tx
}

#[derive(Deserialize)]
pub struct MetricsQuery {
    minutes: Option<i32>,
}

pub async fn metrics(State(st): State<AppState>, headers: HeaderMap, Query(q): Query<MetricsQuery>) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    let minutes = q.minutes.unwrap_or(60).clamp(5, 60 * 24 * RETENTION_DAYS);
    // Bucket size scales with the window so charts stay around 60-170 points.
    let bucket_secs = match minutes { m if m <= 180 => 60, m if m <= 1440 => 600, _ => 3600 };
    let v: Value = sqlx::query_scalar(
        "with w as (select * from kodudb.request_log where project = $3 and at > now() - make_interval(mins => $1))
         select jsonb_build_object(
           'minutes', $1, 'bucket_seconds', $2,
           'series', (select coalesce(jsonb_agg(s order by s.t), '[]') from (
              select to_timestamp(floor(extract(epoch from at) / $2) * $2) t, count(*) n,
                     count(*) filter (where status >= 500) e5, count(*) filter (where status between 400 and 499) e4,
                     round(percentile_cont(0.5) within group (order by ms)::numeric, 2) p50,
                     round(percentile_cont(0.95) within group (order by ms)::numeric, 2) p95
              from w group by 1) s),
           'totals', (select jsonb_build_object('requests', count(*), 'errors', count(*) filter (where status >= 500),
                     'client_errors', count(*) filter (where status between 400 and 499),
                     'p50', round(coalesce(percentile_cont(0.5) within group (order by ms), 0)::numeric, 2),
                     'p95', round(coalesce(percentile_cont(0.95) within group (order by ms), 0)::numeric, 2),
                     'p99', round(coalesce(percentile_cont(0.99) within group (order by ms), 0)::numeric, 2),
                     'unique_ips', count(distinct ip)) from w),
           'status', (select coalesce(jsonb_agg(x order by x.class), '[]') from (
              select (status / 100) || 'xx' class, count(*) n from w group by 1) x),
           'services', (select coalesce(jsonb_agg(x order by x.n desc), '[]') from (
              select coalesce(nullif(split_part(path, '/', 2), ''), 'root') service, count(*) n,
                     round(avg(ms)::numeric, 2) avg_ms from w group by 1) x),
           'top_routes', (select coalesce(jsonb_agg(x order by x.n desc), '[]') from (
              select method, coalesce(route, path) route, count(*) n, count(*) filter (where status >= 400) errors,
                     round(percentile_cont(0.95) within group (order by ms)::numeric, 2) p95
              from w group by 1, 2 order by n desc limit 10) x),
           'slowest', (select coalesce(jsonb_agg(x order by x.ms desc), '[]') from (
              select at, method, path, status, round(ms::numeric, 2) ms from w order by ms desc limit 8) x),
           'db', '{}'::jsonb, 'table_sizes', '[]'::jsonb)",
    )
    .bind(minutes)
    .bind(bucket_secs as f64)
    .bind(&st.project)
    .fetch_one(&st.platform)
    .await?;
    let db: Value = sqlx::query_scalar(DB_STATS).fetch_one(&st.pool).await?;
    let mut v = v;
    v["db"] = db["db"].clone();
    v["table_sizes"] = db["table_sizes"].clone();
    Ok(Json(v))
}

const DB_STATS: &str = "select jsonb_build_object(
   'db', (select jsonb_build_object(
             'cache_hit_pct', round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2),
             'commits', xact_commit, 'rollbacks', xact_rollback, 'deadlocks', deadlocks,
             'rows_read', tup_returned, 'rows_written', tup_inserted + tup_updated + tup_deleted,
             'connections', numbackends, 'size', pg_database_size(datname))
          from pg_stat_database where datname = current_database()),
   'table_sizes', (select coalesce(jsonb_agg(x order by x.bytes desc), '[]') from (
      select c.relname as name, pg_total_relation_size(c.oid) bytes, greatest(c.reltuples, 0)::bigint as rows
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') order by 2 desc limit 8) x))";

#[derive(Deserialize)]
pub struct LogQuery {
    limit: Option<i64>,
    status: Option<String>,
    method: Option<String>,
    q: Option<String>,
    before: Option<i64>,
}

pub async fn list(State(st): State<AppState>, headers: HeaderMap, Query(q): Query<LogQuery>) -> R<Response> {
    require_service(&st.claims(&headers, None)?)?;
    // status filter: "2xx".."5xx", "errors" (>=400) or an exact code.
    let (lo, hi) = match q.status.as_deref() {
        Some("errors") => (400, 599),
        Some(s) if s.len() == 3 && s.ends_with("xx") => {
            let d: i32 = s[..1].parse().unwrap_or(0);
            (d * 100, d * 100 + 99)
        }
        Some(s) => s.parse().map(|c: i32| (c, c)).unwrap_or((0, 999)),
        None => (0, 999),
    };
    let out: String = sqlx::query_scalar(
        "select coalesce(jsonb_agg(x order by x.id desc), '[]')::text from (
           select * from kodudb.request_log
           where project = $7 and status between $1 and $2 and ($3::text is null or method = $3)
             and ($4::text is null or path ilike '%' || $4 || '%') and ($5::bigint is null or id < $5)
           order by id desc limit $6) x",
    )
    .bind(lo)
    .bind(hi)
    .bind(q.method.filter(|m| !m.is_empty()))
    .bind(q.q.filter(|s| !s.is_empty()))
    .bind(q.before)
    .bind(q.limit.unwrap_or(200).clamp(1, 1000))
    .bind(&st.project)
    .fetch_one(&st.platform)
    .await?;
    Ok(json_response(out))
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    table: Option<String>,
    limit: Option<i64>,
}

pub async fn history(State(st): State<AppState>, headers: HeaderMap, Query(q): Query<HistoryQuery>) -> R<Response> {
    require_service(&st.claims(&headers, None)?)?;
    let table = q.table.filter(|t| !t.is_empty());
    if let Some(t) = &table {
        ident(t)?;
    }
    let out: String = sqlx::query_scalar(
        "select coalesce(jsonb_agg(x order by x.id desc), '[]')::text from (
           select c.*, u.email as actor_email from history.changes c left join auth.users u on u.id = c.actor
           where $1::text is null or c.table_name = $1 order by c.id desc limit $2) x",
    )
    .bind(table)
    .bind(q.limit.unwrap_or(200).clamp(1, 2000))
    .fetch_one(&st.pool)
    .await?;
    Ok(json_response(out))
}

#[cfg(test)]
mod tests {
    use super::skip;

    #[test]
    fn skips_noise_paths() {
        assert!(skip("/health"));
        assert!(skip("/meta/v1/metrics"));
        assert!(!skip("/rest/v1/todos"));
    }
}
