//! File storage: metadata in storage.objects (RLS-checked), bytes in the project's object store
//! (a local directory or an S3 bucket, see objects.rs) under `<bucket>/<name>`.
use object_store::{path::Path as ObjPath, ObjectStoreExt, PutPayload};

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::Value;

use crate::ctx::{err, json_response, require_service, role, scoped, AppState, R};

const RESERVED_BUCKETS: [&str; 4] = ["public", "list", "sign", "bucket"];

fn valid_bucket(b: &str) -> R<&str> {
    let ok = (2..=63).contains(&b.len())
        && b.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && b.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        && !RESERVED_BUCKETS.contains(&b);
    if ok { Ok(b) } else { Err(err(StatusCode::BAD_REQUEST, "invalid bucket name")) }
}

/// A staging key no other upload uses. `_tmp` can never be a bucket (bucket names start with a letter or digit).
fn temp_key() -> ObjPath {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    ObjPath::from(format!("_tmp/{}-{n}.part", std::process::id()))
}

fn store_err(e: object_store::Error) -> crate::ctx::ApiError {
    match e {
        object_store::Error::NotFound { .. } => err(StatusCode::NOT_FOUND, "object data missing"),
        e => err(StatusCode::INTERNAL_SERVER_ERROR, format!("file storage: {e}")),
    }
}

/// Object key for a file; rejects traversal and absolute/odd names.
pub fn object_key(bucket: &str, name: &str) -> R<ObjPath> {
    valid_bucket(bucket)?;
    let bad = name.is_empty()
        || name.len() > 1024
        || name.contains('\\')
        || name.contains('\0')
        || name.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..");
    if bad {
        return Err(err(StatusCode::BAD_REQUEST, "invalid object name"));
    }
    ObjPath::parse(format!("{bucket}/{name}")).map_err(|_| err(StatusCode::BAD_REQUEST, "invalid object name"))
}

pub async fn list_buckets(State(st): State<AppState>, headers: HeaderMap) -> R<Response> {
    let c = st.claims(&headers, None)?;
    let mut tx = scoped(&st, &c).await?;
    let out: String = sqlx::query_scalar(
        "select coalesce(jsonb_agg(b order by b.created_at), '[]')::text from (
           select b.*, (select count(*) from storage.objects o where o.bucket_id = b.id) objects,
                  (select coalesce(sum(size), 0) from storage.objects o where o.bucket_id = b.id) bytes
           from storage.buckets b) b",
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(json_response(out))
}

#[derive(Deserialize)]
pub struct NewBucket {
    id: String,
    #[serde(default)]
    public: bool,
}

pub async fn create_bucket(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<NewBucket>) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    valid_bucket(&b.id)?;
    let row: Value = sqlx::query_scalar("insert into storage.buckets (id, public) values ($1, $2) returning to_jsonb(buckets)")
        .bind(&b.id)
        .bind(b.public)
        .fetch_one(&st.pool)
        .await?;
    Ok(Json(row))
}

#[derive(Deserialize)]
pub struct BucketUpdate {
    public: bool,
}

pub async fn update_bucket(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<BucketUpdate>) -> R<StatusCode> {
    require_service(&st.claims(&headers, None)?)?;
    let n = sqlx::query("update storage.buckets set public = $2 where id = $1").bind(&id).bind(b.public).execute(&st.pool).await?.rows_affected();
    if n == 0 { Err(err(StatusCode::NOT_FOUND, "bucket not found")) } else { Ok(StatusCode::NO_CONTENT) }
}

pub async fn delete_bucket(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> R<StatusCode> {
    require_service(&st.claims(&headers, None)?)?;
    valid_bucket(&id)?;
    let n = sqlx::query("delete from storage.buckets where id = $1").bind(&id).execute(&st.pool).await?.rows_affected();
    if n == 0 {
        return Err(err(StatusCode::NOT_FOUND, "bucket not found"));
    }
    if let Err(e) = crate::objects::delete_prefix(&st.storage, Some(&ObjPath::from(id.as_str()))).await {
        // Not logging the bucket name: it comes from the request (validated, but keep logs free of user input).
        eprintln!("a bucket was removed but its files were not all deleted: {}", e.1);
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn upload(State(st): State<AppState>, method: Method, headers: HeaderMap, Path((bucket, name)): Path<(String, String)>, body: Bytes) -> R<Json<Value>> {
    let c = st.claims(&headers, None)?;
    let key = object_key(&bucket, &name)?;
    let limit_mb = st.settings.read().unwrap().upload_limit.then(|| st.settings.read().unwrap().upload_mb);
    if limit_mb.is_some_and(|mb| body.len() as u64 > mb as u64 * 1024 * 1024) {
        return Err(err(StatusCode::PAYLOAD_TOO_LARGE, format!("file is larger than the project's upload limit of {} MB", limit_mb.unwrap_or_default())));
    }
    let upsert = method == Method::PUT || headers.get("x-upsert").is_some_and(|v| v == "true");
    let mime = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_string();
    let owner = (role(&c) == "authenticated").then(|| c["sub"].as_str().unwrap_or_default().to_string());
    let mut tx = scoped(&st, &c).await?;
    let row: Option<Value> = sqlx::query_scalar(
        "insert into storage.objects as o (bucket_id, name, owner, size, mimetype) values ($1, $2, $3::uuid, $4, $5)
         on conflict (bucket_id, name) do update set size = excluded.size, mimetype = excluded.mimetype, created_at = now()
           where $6
         returning to_jsonb(o)",
    )
    .bind(&bucket)
    .bind(&name)
    .bind(owner)
    .bind(body.len() as i64)
    .bind(&mime)
    .bind(upsert)
    .fetch_optional(&mut *tx)
    .await?;
    let row = row.ok_or_else(|| err(StatusCode::CONFLICT, "object already exists (use x-upsert: true)"))?;
    // Bytes go to a private staging key first; the old object is only replaced after the metadata commits,
    // so a failed write or commit leaves the previous version intact and concurrent uploads never interleave.
    let tmp = temp_key();
    if let Err(e) = st.storage.put(&tmp, PutPayload::from(body)).await {
        let _ = st.storage.delete(&tmp).await;
        return Err(store_err(e));
    }
    if let Err(e) = tx.commit().await {
        let _ = st.storage.delete(&tmp).await;
        return Err(e.into());
    }
    st.storage.rename(&tmp, &key).await.map_err(store_err)?;
    Ok(Json(row))
}

async fn send_file(st: &AppState, key: ObjPath, mime: Option<String>) -> R<Response> {
    let bytes = st.storage.get(&key).await.map_err(store_err)?.bytes().await.map_err(store_err)?;
    let mime = mime.unwrap_or_else(|| "application/octet-stream".into());
    Ok(([(header::CONTENT_TYPE, mime)], bytes).into_response())
}

pub async fn download(State(st): State<AppState>, headers: HeaderMap, Path((bucket, name)): Path<(String, String)>) -> R<Response> {
    let c = st.claims(&headers, None)?;
    let key = object_key(&bucket, &name)?;
    let mut tx = scoped(&st, &c).await?;
    let mime: Option<Option<String>> = sqlx::query_scalar("select mimetype from storage.objects where bucket_id = $1 and name = $2")
        .bind(&bucket)
        .bind(&name)
        .fetch_optional(&mut *tx)
        .await?;
    tx.commit().await?;
    send_file(&st, key, mime.ok_or_else(|| err(StatusCode::NOT_FOUND, "object not found"))?).await
}

pub async fn download_public(State(st): State<AppState>, Path((bucket, name)): Path<(String, String)>) -> R<Response> {
    let key = object_key(&bucket, &name)?;
    let mime: Option<Option<String>> = sqlx::query_scalar(
        "select o.mimetype from storage.objects o join storage.buckets b on b.id = o.bucket_id
         where b.public and o.bucket_id = $1 and o.name = $2",
    )
    .bind(&bucket)
    .bind(&name)
    .fetch_optional(&st.pool)
    .await?;
    send_file(&st, key, mime.ok_or_else(|| err(StatusCode::NOT_FOUND, "object not found"))?).await
}

pub async fn remove(State(st): State<AppState>, headers: HeaderMap, Path((bucket, name)): Path<(String, String)>) -> R<StatusCode> {
    let c = st.claims(&headers, None)?;
    let key = object_key(&bucket, &name)?;
    let mut tx = scoped(&st, &c).await?;
    let n = sqlx::query("delete from storage.objects where bucket_id = $1 and name = $2")
        .bind(&bucket)
        .bind(&name)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(err(StatusCode::NOT_FOUND, "object not found"));
    }
    tx.commit().await?;
    let _ = st.storage.delete(&key).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
pub struct ListReq {
    #[serde(default)]
    prefix: String,
    limit: Option<i64>,
    offset: Option<i64>,
}

pub async fn list(State(st): State<AppState>, headers: HeaderMap, Path(bucket): Path<String>, body: Bytes) -> R<Response> {
    let c = st.claims(&headers, None)?;
    valid_bucket(&bucket)?;
    let q: ListReq = if body.is_empty() { ListReq::default() } else { serde_json::from_slice(&body).map_err(|e| err(StatusCode::BAD_REQUEST, e.to_string()))? };
    let mut tx = scoped(&st, &c).await?;
    let out: String = sqlx::query_scalar(
        "select coalesce(jsonb_agg(o order by o.name), '[]')::text from (
           select id, name, owner, size, mimetype, created_at from storage.objects
           where bucket_id = $1 and starts_with(name, $2) order by name limit $3 offset $4) o",
    )
    .bind(&bucket)
    .bind(&q.prefix)
    .bind(q.limit.unwrap_or(1000).clamp(1, 10_000))
    .bind(q.offset.unwrap_or(0).max(0))
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(json_response(out))
}

#[cfg(test)]
mod tests {
    use super::object_key;

    #[test]
    fn blocks_path_traversal() {
        assert_eq!(object_key("avatars", "a/b.png").unwrap().as_ref(), "avatars/a/b.png");
        assert!(object_key("avatars", "../etc/passwd").is_err());
        assert!(object_key("avatars", "a/../../x").is_err());
        assert!(object_key("avatars", "/abs").is_err());
        assert!(object_key("avatars", "a\\b").is_err());
        assert!(object_key("../x", "a").is_err());
        assert!(object_key("public", "a").is_err());
        assert!(object_key("_tmp", "a").is_err(), "the staging prefix is never a bucket");
    }
}
