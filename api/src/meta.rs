//! Database introspection and SQL runner for the console (secret key only).
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Column, Row};

use crate::ctx::{err, ident, json_response, require_service, AppState, R};

const CATALOG: &[(&str, &str)] = &[
    ("schemas", "select nspname as name, pg_get_userbyid(nspowner) as owner from pg_namespace
        where nspname not like 'pg\\_%' and nspname <> 'information_schema' order by 1"),
    ("tables", "select c.relname as name, c.relrowsecurity as rls_enabled, greatest(c.reltuples, 0)::bigint as rows_estimate,
        pg_total_relation_size(c.oid) as bytes,
        exists(select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'kodudb_realtime') as realtime,
        exists(select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'kodudb_history') as history,
        obj_description(c.oid, 'pg_class') as comment
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1"),
    ("policies", "select schemaname as schema, tablename as table, policyname as name, permissive, roles, cmd, qual, with_check
        from pg_policies order by 1, 2, 3"),
    ("functions", "select n.nspname as schema, p.proname as name, pg_get_function_arguments(p.oid) as args,
        format_type(p.prorettype, null) as returns, l.lanname as language, p.prosecdef as security_definer
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
        where n.nspname in ('public', 'auth', 'storage', 'realtime') and p.prokind = 'f' order by 1, 2"),
    ("triggers", "select event_object_schema as schema, event_object_table as table, trigger_name as name,
        string_agg(event_manipulation, ' OR ') as events, action_timing as timing, action_statement as action
        from information_schema.triggers group by 1, 2, 3, 5, 6 order by 1, 2, 3"),
    ("extensions", "select e.name, e.default_version, x.extversion as installed_version, e.comment
        from pg_available_extensions e left join pg_extension x on x.extname = e.name
        order by (x.extversion is null), e.name"),
    ("roles", "select rolname as name, rolsuper as superuser, rolcanlogin as can_login, rolbypassrls as bypass_rls
        from pg_roles where rolname not like 'pg\\_%' order by 1"),
    ("indexes", "select schemaname as schema, tablename as table, indexname as name, indexdef as definition
        from pg_indexes where schemaname not in ('pg_catalog', 'information_schema') order by 1, 2, 3"),
    ("types", "select n.nspname as schema, t.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as values
        from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
        group by 1, 2 order by 1, 2"),
];

pub async fn catalog(State(st): State<AppState>, headers: HeaderMap, Path(kind): Path<String>) -> R<Response> {
    require_service(&st.claims(&headers, None)?)?;
    let sql = CATALOG
        .iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, s)| *s)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("unknown catalog: {kind}")))?;
    let out: String = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("select coalesce(jsonb_agg(x), '[]')::text from ({sql}) x")))
        .fetch_one(&st.pool)
        .await?;
    Ok(json_response(out))
}

pub async fn columns(State(st): State<AppState>, headers: HeaderMap, Path(table): Path<String>) -> R<Response> {
    require_service(&st.claims(&headers, None)?)?;
    ident(&table)?;
    let out: String = sqlx::query_scalar(
        "select coalesce(jsonb_agg(x order by x.position), '[]')::text from (
           select a.attnum as position, a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
                  not a.attnotnull as nullable, pg_get_expr(d.adbin, d.adrelid) as default,
                  coalesce(a.attnum = any(i.indkey), false) as primary_key
           from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
           left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
           left join pg_index i on i.indrelid = c.oid and i.indisprimary
           where n.nspname = 'public' and c.relname = $1 and a.attnum > 0 and not a.attisdropped) x",
    )
    .bind(&table)
    .fetch_one(&st.pool)
    .await?;
    Ok(json_response(out))
}

#[derive(Deserialize)]
pub struct SqlReq {
    query: String,
}

/// Runs arbitrary SQL as the database owner. Simple-query protocol returns text values, so any type renders.
pub async fn query(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<SqlReq>) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    let started = std::time::Instant::now();
    // A script can leave its connection in an open or failed transaction ("begin; ...") or change session
    // state (SET ROLE, search_path, temp tables). Run it on its own connection and close that afterwards, so
    // nothing it leaves behind reaches the shared pool. A one-connection pool keeps this future Send.
    let own = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect_with((*st.pool.connect_options()).clone())
        .await?;
    let rows = sqlx::raw_sql(sqlx::AssertSqlSafe(b.query.as_str())).fetch_all(&own).await;
    own.close().await;
    // Any statement may have changed a table's shape: the REST API re-reads columns on its next request.
    st.columns.lock().unwrap().clear();
    let rows = rows?;
    let columns: Vec<String> = rows.first().map(|r| r.columns().iter().map(|c| c.name().to_string()).collect()).unwrap_or_default();
    let data: Vec<Vec<Option<String>>> = rows
        .iter()
        .map(|r| (0..r.columns().len()).map(|i| r.try_get_unchecked::<Option<String>, _>(i).unwrap_or(None)).collect())
        .collect();
    Ok(Json(json!({ "columns": columns, "rows": data, "row_count": data.len(), "ms": started.elapsed().as_millis() })))
}

pub async fn stats(State(st): State<AppState>, headers: HeaderMap) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    let v: Value = sqlx::query_scalar(
        "select jsonb_build_object(
           'db_size', pg_database_size(current_database()),
           'version', current_setting('server_version'),
           'tables', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p')),
           'users', (select count(*) from auth.users),
           'buckets', (select count(*) from storage.buckets),
           'objects', (select count(*) from storage.objects),
           'storage_bytes', (select coalesce(sum(size), 0) from storage.objects),
           'logins_24h', (select count(*) from auth.audit_log where action = 'login' and created_at > now() - interval '1 day'),
           'connections', (select count(*) from pg_stat_activity where datname = current_database()))",
    )
    .fetch_one(&st.pool)
    .await?;
    let mut v = v;
    v["realtime_checks"] = json!(st.visibility.checks.load(std::sync::atomic::Ordering::Relaxed));
    Ok(Json(v))
}

/// Schema change log recorded by the project's DDL event triggers.
pub async fn migrations(State(st): State<AppState>, headers: HeaderMap) -> R<Response> {
    require_service(&st.claims(&headers, None)?)?;
    let out: String = sqlx::query_scalar(
        "select coalesce(jsonb_agg(m order by m.version desc), '[]')::text from (
           select version, at, tag, object, statement, actor, pushed_at, git_sha from kodudb_schema.migrations
           order by version desc limit 500) m",
    )
    .fetch_one(&st.pool)
    .await?;
    Ok(json_response(out))
}
