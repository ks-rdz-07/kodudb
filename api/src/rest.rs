//! Automatic REST API over the tables in the `public` schema.
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::Value;
use sqlx::{postgres::PgArguments, query::QueryScalar, PgPool, Postgres};

use crate::ctx::{err, ident, json_response, scoped, AppState, R};

type Params = Query<Vec<(String, String)>>;

const RESERVED: [&str; 6] = ["select", "order", "limit", "offset", "on_conflict", "apikey"];
const MAX_LIMIT: i64 = 10_000;

pub enum Bind {
    Text(String),
    Arr(Vec<String>),
}

fn bind_all<'q, O>(mut q: QueryScalar<'q, Postgres, O, PgArguments>, binds: &'q [Bind]) -> QueryScalar<'q, Postgres, O, PgArguments> {
    for b in binds {
        q = match b {
            Bind::Text(s) => q.bind(s),
            Bind::Arr(v) => q.bind(v),
        };
    }
    q
}

const COLUMN_TTL: std::time::Duration = std::time::Duration::from_secs(5);

/// Column name -> SQL type (from the catalog, so safe to inline as a cast), cached for a few seconds.
async fn columns(st: &AppState, table: &str) -> R<Vec<(String, String)>> {
    ident(table)?;
    if let Some((at, cols)) = st.columns.lock().unwrap().get(table) {
        if at.elapsed() < COLUMN_TTL {
            return Ok(cols.clone());
        }
    }
    let cols = load_columns(&st.pool, table).await?;
    st.columns.lock().unwrap().insert(table.to_string(), (std::time::Instant::now(), cols.clone()));
    Ok(cols)
}

async fn load_columns(pool: &PgPool, table: &str) -> R<Vec<(String, String)>> {
    let cols: Vec<(String, String)> = sqlx::query_as(
        "select a.attname::text, format_type(a.atttypid, a.atttypmod)
         from pg_attribute a join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = $1 and c.relkind in ('r','v','m','p','f')
           and a.attnum > 0 and not a.attisdropped order by a.attnum",
    )
    .bind(table)
    .fetch_all(pool)
    .await?;
    if cols.is_empty() {
        return Err(err(StatusCode::NOT_FOUND, format!("table not found: {table}")));
    }
    Ok(cols)
}

fn col_type<'a>(cols: &'a [(String, String)], name: &str) -> R<&'a str> {
    cols.iter()
        .find(|(n, _)| n == name)
        .map(|(_, t)| t.as_str())
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, format!("unknown column: {name}")))
}

/// `col=op.value` filters: eq neq gt gte lt lte like ilike is in, optional `not.` prefix, all combined with
/// `and`. `or=(col.op.value,col.op.value)` matches when any of its filters matches (values may be "quoted").
pub fn filters(params: &[(String, String)], cols: &[(String, String)], binds: &mut Vec<Bind>) -> R<String> {
    let mut parts = Vec::new();
    for (k, v) in params {
        if RESERVED.contains(&k.as_str()) {
            continue;
        }
        if k == "or" {
            let inner = v.strip_prefix('(').and_then(|s| s.strip_suffix(')'))
                .ok_or_else(|| err(StatusCode::BAD_REQUEST, "or= needs (col.op.value,...)"))?;
            let mut any = Vec::new();
            for item in split_top_level(inner) {
                let (col, rest) = item.split_once('.').ok_or_else(|| err(StatusCode::BAD_REQUEST, format!("bad or= filter: {item}")))?;
                any.push(filter_expr(col, &unquote_value(rest), cols, binds)?);
            }
            if any.is_empty() {
                return Err(err(StatusCode::BAD_REQUEST, "or= needs at least one filter"));
            }
            parts.push(format!("({})", any.join(" or ")));
            continue;
        }
        parts.push(filter_expr(k, v, cols, binds)?);
    }
    Ok(if parts.is_empty() { "true".into() } else { parts.join(" and ") })
}

/// Split on commas that are not inside parentheses or double quotes.
fn split_top_level(s: &str) -> Vec<String> {
    let (mut out, mut cur, mut depth, mut quoted) = (Vec::new(), String::new(), 0i32, false);
    for c in s.chars() {
        match c {
            '"' => { quoted = !quoted; cur.push(c) }
            '(' if !quoted => { depth += 1; cur.push(c) }
            ')' if !quoted => { depth -= 1; cur.push(c) }
            ',' if !quoted && depth == 0 => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

/// `ilike."a,b"` -> `ilike.a,b`: drop the quotes that protect commas inside an or= value.
fn unquote_value(rest: &str) -> String {
    match rest.split_once('.') {
        Some((op, val)) if val.len() >= 2 && val.starts_with('"') && val.ends_with('"') => format!("{op}.{}", &val[1..val.len() - 1]),
        _ => rest.to_string(),
    }
}

/// One `col` + `op.value` filter as SQL, with the value bound as a parameter.
fn filter_expr(k: &str, v: &str, cols: &[(String, String)], binds: &mut Vec<Bind>) -> R<String> {
    {
        let typ = col_type(cols, k)?;
        let (mut op, mut val) = v.split_once('.').unwrap_or((v, ""));
        let neg = op == "not";
        if neg {
            (op, val) = val.split_once('.').unwrap_or((val, ""));
        }
        let q = format!("\"{k}\"");
        let expr = match op {
            "eq" | "neq" | "gt" | "gte" | "lt" | "lte" => {
                let sym = match op { "eq" => "=", "neq" => "<>", "gt" => ">", "gte" => ">=", "lt" => "<", _ => "<=" };
                binds.push(Bind::Text(val.to_string()));
                format!("{q} {sym} ${}::text::{typ}", binds.len())
            }
            "like" | "ilike" => {
                binds.push(Bind::Text(val.replace('*', "%")));
                format!("{q}::text {op} ${}", binds.len())
            }
            "is" => match val {
                "null" | "true" | "false" => format!("{q} is {val}"),
                _ => return Err(err(StatusCode::BAD_REQUEST, "is. accepts null, true or false")),
            },
            "in" => {
                let inner = val.strip_prefix('(').and_then(|s| s.strip_suffix(')')).unwrap_or(val);
                binds.push(Bind::Arr(inner.split(',').map(|s| s.trim().trim_matches('"').to_string()).collect()));
                format!("{q} = any(${}::text[]::{typ}[])", binds.len())
            }
            _ => return Err(err(StatusCode::BAD_REQUEST, format!("unsupported operator: {op}"))),
        };
        Ok(if neg { format!("not ({expr})") } else { expr })
    }
}

fn param<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
    params.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

fn has_filters(params: &[(String, String)]) -> bool {
    params.iter().any(|(k, _)| !RESERVED.contains(&k.as_str()))
}

fn select_list(params: &[(String, String)], cols: &[(String, String)]) -> R<String> {
    match param(params, "select") {
        None | Some("*") | Some("") => Ok("*".into()),
        Some(s) => s
            .split(',')
            .map(|c| col_type(cols, c.trim()).map(|_| format!("\"{}\"", c.trim())))
            .collect::<R<Vec<_>>>()
            .map(|v| v.join(", ")),
    }
}

fn order_clause(params: &[(String, String)], cols: &[(String, String)]) -> R<String> {
    let Some(o) = param(params, "order") else { return Ok(String::new()) };
    let mut out = Vec::new();
    for item in o.split(',') {
        let mut it = item.split('.');
        let col = it.next().unwrap_or_default();
        col_type(cols, col)?;
        let mut s = format!("\"{col}\"");
        for m in it {
            s.push_str(match m {
                "asc" => " asc",
                "desc" => " desc",
                "nullsfirst" => " nulls first",
                "nullslast" => " nulls last",
                _ => return Err(err(StatusCode::BAD_REQUEST, format!("bad order modifier: {m}"))),
            });
        }
        out.push(s);
    }
    Ok(format!("order by {}", out.join(", ")))
}

fn int_param(params: &[(String, String)], key: &str, default: i64) -> R<i64> {
    param(params, key)
        .map(|v| v.parse::<i64>().map_err(|_| err(StatusCode::BAD_REQUEST, format!("{key} must be an integer"))))
        .transpose()
        .map(|v| v.unwrap_or(default).max(0))
}

fn agg(inner: &str) -> String {
    format!("select coalesce(jsonb_agg(r), '[]')::text from ({inner}) r")
}

pub async fn select(State(st): State<AppState>, Path(table): Path<String>, headers: HeaderMap, Query(p): Params) -> R<Response> {
    let c = st.claims(&headers, param(&p, "apikey"))?;
    let cols = columns(&st, &table).await?;
    let mut binds = Vec::new();
    let w = filters(&p, &cols, &mut binds)?;
    let limit = int_param(&p, "limit", 1000)?.min(MAX_LIMIT);
    let offset = int_param(&p, "offset", 0)?;
    let sql = agg(&format!(
        "select {} from public.\"{table}\" where {w} {} limit {limit} offset {offset}",
        select_list(&p, &cols)?,
        order_clause(&p, &cols)?
    ));
    let mut tx = scoped(&st, &c).await?;
    let body: String = bind_all(sqlx::query_scalar(sqlx::AssertSqlSafe(sql.as_str())), &binds).fetch_one(&mut *tx).await?;
    let want_count = headers.get("prefer").and_then(|v| v.to_str().ok()).is_some_and(|v| v.contains("count=exact"));
    let count: Option<i64> = if want_count {
        Some(bind_all(sqlx::query_scalar(sqlx::AssertSqlSafe(format!("select count(*) from public.\"{table}\" where {w}"))), &binds).fetch_one(&mut *tx).await?)
    } else {
        None
    };
    tx.commit().await?;
    let mut res = json_response(body);
    if let Some(n) = count {
        res.headers_mut().insert("x-total-count", n.into());
    }
    Ok(res)
}

fn body_keys(rows: &[Value], cols: &[(String, String)]) -> R<Vec<String>> {
    let mut keys: Vec<String> = Vec::new();
    for r in rows {
        let obj = r.as_object().ok_or_else(|| err(StatusCode::BAD_REQUEST, "rows must be JSON objects"))?;
        for k in obj.keys() {
            col_type(cols, k)?;
            if !keys.contains(k) {
                keys.push(k.clone());
            }
        }
    }
    Ok(keys)
}

fn quoted(keys: &[String]) -> String {
    keys.iter().map(|k| format!("\"{k}\"")).collect::<Vec<_>>().join(", ")
}

fn parse_body(body: &Bytes) -> R<Value> {
    serde_json::from_slice(body).map_err(|e| err(StatusCode::BAD_REQUEST, format!("invalid JSON: {e}")))
}

pub async fn insert(State(st): State<AppState>, Path(table): Path<String>, headers: HeaderMap, Query(p): Params, body: Bytes) -> R<Response> {
    let c = st.claims(&headers, param(&p, "apikey"))?;
    let cols = columns(&st, &table).await?;
    let v = parse_body(&body)?;
    let rows = match v {
        Value::Array(a) => a,
        o => vec![o],
    };
    if rows.is_empty() {
        return Ok(json_response("[]".into()));
    }
    body_keys(&rows, &cols)?; // validates every key up front
    let prefer = headers.get("prefer").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let target = if prefer.contains("resolution=") {
        Some(
            param(&p, "on_conflict")
                .ok_or_else(|| err(StatusCode::BAD_REQUEST, "upsert needs on_conflict=<columns>"))?
                .split(',')
                .map(|c| col_type(&cols, c.trim()).map(|_| format!("\"{}\"", c.trim())))
                .collect::<R<Vec<_>>>()?
                .join(", "),
        )
    } else {
        None
    };
    // Rows with different key sets go in separate statements so omitted columns get their defaults.
    let mut groups: Vec<(Vec<String>, Vec<Value>)> = Vec::new();
    for r in rows {
        let mut keys: Vec<String> = r.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
        keys.sort();
        match groups.iter_mut().find(|(k, _)| *k == keys) {
            Some((_, g)) => g.push(r),
            None => groups.push((keys, vec![r])),
        }
    }
    let mut tx = scoped(&st, &c).await?;
    let mut out: Vec<Value> = Vec::new();
    for (keys, group) in groups {
        let conflict = match &target {
            None => String::new(),
            Some(t) if prefer.contains("ignore-duplicates") || keys.is_empty() => format!("on conflict ({t}) do nothing"),
            Some(t) => {
                let set = keys.iter().map(|k| format!("\"{k}\" = excluded.\"{k}\"")).collect::<Vec<_>>().join(", ");
                format!("on conflict ({t}) do update set {set}")
            }
        };
        let (sql, binds) = if keys.is_empty() {
            let one = format!("with r as (insert into public.\"{table}\" default values {conflict} returning *) {}", agg("select * from r"));
            (one, vec![])
        } else {
            let cl = quoted(&keys);
            let sql = format!(
                "with r as (insert into public.\"{table}\" ({cl}) select {cl} from jsonb_populate_recordset(null::public.\"{table}\", $1::jsonb) {conflict} returning *) {}",
                agg("select * from r")
            );
            (sql, vec![Bind::Text(Value::Array(group.clone()).to_string())])
        };
        // Default-only rows insert one statement per row.
        let times = if keys.is_empty() { group.len() } else { 1 };
        for _ in 0..times {
            let s: String = bind_all(sqlx::query_scalar(sqlx::AssertSqlSafe(sql.as_str())), &binds).fetch_one(&mut *tx).await?;
            if let Ok(Value::Array(a)) = serde_json::from_str(&s) {
                out.extend(a);
            }
        }
    }
    tx.commit().await?;
    Ok((StatusCode::CREATED, json_response(Value::Array(out).to_string())).into_response())
}

pub async fn update(State(st): State<AppState>, Path(table): Path<String>, headers: HeaderMap, Query(p): Params, body: Bytes) -> R<Response> {
    let c = st.claims(&headers, param(&p, "apikey"))?;
    if !has_filters(&p) {
        return Err(err(StatusCode::BAD_REQUEST, "update requires at least one filter"));
    }
    let cols = columns(&st, &table).await?;
    let v = parse_body(&body)?;
    let keys = body_keys(std::slice::from_ref(&v), &cols)?;
    if keys.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "nothing to update"));
    }
    let mut binds = vec![Bind::Text(v.to_string())];
    let w = filters(&p, &cols, &mut binds)?;
    let cl = quoted(&keys);
    let sql = format!(
        "with r as (update public.\"{table}\" set ({cl}) = (select {cl} from jsonb_populate_record(null::public.\"{table}\", $1::jsonb)) where {w} returning *) {}",
        agg("select * from r")
    );
    let mut tx = scoped(&st, &c).await?;
    let out: String = bind_all(sqlx::query_scalar(sqlx::AssertSqlSafe(sql.as_str())), &binds).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(json_response(out))
}

pub async fn delete(State(st): State<AppState>, Path(table): Path<String>, headers: HeaderMap, Query(p): Params) -> R<Response> {
    let c = st.claims(&headers, param(&p, "apikey"))?;
    if !has_filters(&p) {
        return Err(err(StatusCode::BAD_REQUEST, "delete requires at least one filter"));
    }
    let cols = columns(&st, &table).await?;
    let mut binds = Vec::new();
    let w = filters(&p, &cols, &mut binds)?;
    let sql = format!("with r as (delete from public.\"{table}\" where {w} returning *) {}", agg("select * from r"));
    let mut tx = scoped(&st, &c).await?;
    let out: String = bind_all(sqlx::query_scalar(sqlx::AssertSqlSafe(sql.as_str())), &binds).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(json_response(out))
}

/// POST /rest/v1/rpc/{fn} with named arguments as a JSON object.
pub async fn rpc(State(st): State<AppState>, Path(func): Path<String>, headers: HeaderMap, Query(p): Params, body: Bytes) -> R<Response> {
    let c = st.claims(&headers, param(&p, "apikey"))?;
    ident(&func)?;
    let args = if body.is_empty() { Value::Object(Default::default()) } else { parse_body(&body)? };
    let args_obj = args.as_object().ok_or_else(|| err(StatusCode::BAD_REQUEST, "rpc body must be a JSON object"))?;
    let overloads: Vec<(bool, bool, Vec<String>, Vec<String>)> = sqlx::query_as(
        "select p.proretset, p.prorettype = 'void'::regtype,
                coalesce(array_agg(a.name::text order by a.ord) filter (where a.name is not null), '{}'),
                coalesce(array_agg(format_type(a.typ, null) order by a.ord) filter (where a.name is not null), '{}')
         from pg_proc p
         left join lateral unnest(coalesce(p.proallargtypes, p.proargtypes::oid[]), p.proargnames,
              coalesce(p.proargmodes, array_fill('i'::\"char\", array[cardinality(p.proargtypes::oid[])])))
              with ordinality a(typ, name, mode, ord) on a.mode in ('i', 'b', 'v')
         where p.pronamespace = 'public'::regnamespace and p.proname = $1
         group by p.oid",
    )
    .bind(&func)
    .fetch_all(&st.pool)
    .await?;
    let (retset, void, names, types) = overloads
        .into_iter()
        .find(|(_, _, names, _)| args_obj.keys().all(|k| names.contains(k)))
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("function not found for these arguments: {func}")))?;
    let call_args = names
        .iter()
        .zip(&types)
        .filter(|(n, _)| args_obj.contains_key(*n))
        .map(|(n, t)| ident(n).map(|n| format!("\"{n}\" => ($1::jsonb ->> '{n}')::{t}")))
        .collect::<R<Vec<_>>>()?
        .join(", ");
    let call = format!("public.\"{func}\"({call_args})");
    let sql = if void {
        format!("with c as (select {call}) select 'null'::text from c")
    } else if retset {
        format!("select coalesce(jsonb_agg(to_jsonb(r)), '[]')::text from {call} r")
    } else {
        format!("select coalesce(to_jsonb(r), 'null')::text from {call} r")
    };
    let binds = [Bind::Text(args.to_string())];
    let mut tx = scoped(&st, &c).await?;
    let out: String = bind_all(sqlx::query_scalar(sqlx::AssertSqlSafe(sql.as_str())), &binds).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(json_response(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols() -> Vec<(String, String)> {
        vec![("id".into(), "bigint".into()), ("name".into(), "text".into())]
    }
    fn p(k: &str, v: &str) -> (String, String) {
        (k.into(), v.into())
    }

    #[test]
    fn builds_parameterised_filters() {
        let mut b = Vec::new();
        let w = filters(&[p("id", "gte.5"), p("name", "not.ilike.*x*"), p("limit", "3")], &cols(), &mut b).unwrap();
        assert_eq!(w, "\"id\" >= $1::text::bigint and not (\"name\"::text ilike $2)");
        assert!(matches!(&b[1], Bind::Text(s) if s == "%x%"));
    }

    #[test]
    fn or_filters_match_any_and_stay_parameterised() {
        let mut b = Vec::new();
        let w = filters(&[p("id", "gt.1"), p("or", r#"(name.ilike."*a,b*",id.in.(2,3),name.is.null)"#)], &cols(), &mut b).unwrap();
        assert_eq!(w, "\"id\" > $1::text::bigint and (\"name\"::text ilike $2 or \"id\" = any($3::text[]::bigint[]) or \"name\" is null)");
        assert!(matches!(&b[1], Bind::Text(s) if s == "%a,b%"), "comma inside quotes stays in the value");
        assert!(matches!(&b[2], Bind::Arr(v) if v == &["2", "3"]));
    }

    #[test]
    fn or_filters_reject_bad_input() {
        let mut b = Vec::new();
        assert!(filters(&[p("or", "name.eq.x")], &cols(), &mut b).is_err(), "needs parentheses");
        assert!(filters(&[p("or", "()")], &cols(), &mut b).is_err(), "needs a filter");
        assert!(filters(&[p("or", "(nope.eq.1)")], &cols(), &mut b).is_err(), "unknown column");
        assert!(filters(&[p("or", "(id;drop.eq.1)")], &cols(), &mut b).is_err(), "no injection through names");
        assert!(filters(&[p("or", "(id)")], &cols(), &mut b).is_err(), "needs an operator");
    }

    #[test]
    fn rejects_unknown_columns_and_ops() {
        let mut b = Vec::new();
        assert!(filters(&[p("id;drop", "eq.1")], &cols(), &mut b).is_err());
        assert!(filters(&[p("id", "regex.1")], &cols(), &mut b).is_err());
        assert!(order_clause(&[p("order", "id.desc;drop")], &cols()).is_err());
        assert_eq!(order_clause(&[p("order", "id.desc.nullslast")], &cols()).unwrap(), "order by \"id\" desc nulls last");
    }

    #[test]
    fn in_filter_binds_array() {
        let mut b = Vec::new();
        let w = filters(&[p("id", "in.(1,2,3)")], &cols(), &mut b).unwrap();
        assert_eq!(w, "\"id\" = any($1::text[]::bigint[])");
        assert!(matches!(&b[0], Bind::Arr(v) if v.len() == 3));
    }
}
