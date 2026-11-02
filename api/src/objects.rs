//! Where file bytes live: a local directory (default) or an S3-compatible server such as RustFS.
//! With S3, every project gets its own bucket and its own access key, limited to that bucket by policy.
use std::{path::PathBuf, sync::Arc};

use axum::{body::Bytes, http::{self, StatusCode}};
use futures_util::{StreamExt, TryStreamExt};
use object_store::{
    aws::{AmazonS3Builder, AwsAuthorizer, AwsCredential},
    local::LocalFileSystem,
    path::Path as ObjPath,
    ObjectStore, ObjectStoreExt, PutPayload,
};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::ctx::{err, R};

/// Settings for an S3-compatible server, from the environment.
#[derive(Clone, Debug)]
pub struct S3 {
    /// Address the API uses (inside the container network, e.g. http://storage:9000).
    pub endpoint: String,
    /// Address shown to people and apps (e.g. http://localhost:9000).
    pub public_url: String,
    /// Web console link shown in the KoduDB console.
    pub console_url: Option<String>,
    pub region: String,
    access_key: String,
    secret_key: String,
}

#[derive(Clone, Debug)]
pub enum Backend {
    Local(PathBuf),
    S3(S3),
}

impl Backend {
    pub fn from_env() -> Self {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        match (var("S3_ENDPOINT"), var("S3_ACCESS_KEY"), var("S3_SECRET_KEY")) {
            (Some(endpoint), Some(access_key), Some(secret_key)) => {
                let endpoint = endpoint.trim_end_matches('/').to_string();
                Backend::S3(S3 {
                    public_url: var("S3_PUBLIC_URL").unwrap_or_else(|| endpoint.clone()).trim_end_matches('/').to_string(),
                    console_url: var("S3_CONSOLE_URL"),
                    region: var("S3_REGION").unwrap_or_else(|| "us-east-1".into()),
                    endpoint,
                    access_key,
                    secret_key,
                })
            }
            _ => Backend::Local(PathBuf::from(var("STORAGE_ROOT").unwrap_or_else(|| "storage".into()))),
        }
    }

    pub fn s3(&self) -> Option<&S3> {
        match self {
            Backend::S3(s) => Some(s),
            Backend::Local(_) => None,
        }
    }

    /// Local directory of a project's files (the default project uses the root itself).
    pub fn local_dir(root: &std::path::Path, slug: &str) -> PathBuf {
        if slug == "default" { root.to_path_buf() } else { root.join("_projects").join(slug) }
    }

    /// The object store holding one project's files; keys are `<bucket>/<object name>`.
    pub async fn project_store(&self, slug: &str) -> R<Arc<dyn ObjectStore>> {
        let fail = |e: String| err(StatusCode::SERVICE_UNAVAILABLE, format!("file storage unavailable: {e}"));
        match self {
            Backend::Local(root) => {
                let dir = Self::local_dir(root, slug);
                tokio::fs::create_dir_all(&dir).await.map_err(|e| fail(e.to_string()))?;
                Ok(Arc::new(LocalFileSystem::new_with_prefix(dir).map_err(|e| fail(e.to_string()))?))
            }
            Backend::S3(s) => {
                let bucket = bucket_name(slug);
                s.request(reqwest::Method::PUT, &format!("/{bucket}"), None).await.or_else(|e| {
                    // Creating a bucket that already exists is fine.
                    if e.0 == StatusCode::CONFLICT { Ok(Bytes::new()) } else { Err(e) }
                })?;
                let store = AmazonS3Builder::new()
                    .with_endpoint(&s.endpoint)
                    .with_allow_http(s.endpoint.starts_with("http://"))
                    .with_region(&s.region)
                    .with_bucket_name(bucket)
                    .with_access_key_id(&s.access_key)
                    .with_secret_access_key(&s.secret_key)
                    .with_virtual_hosted_style_request(false)
                    .build()
                    .map_err(|e| fail(e.to_string()))?;
                Ok(Arc::new(store))
            }
        }
    }
}

/// S3 bucket for a project: `kdb-<slug>`, shortened with a stable hash when longer than S3's 63 characters.
pub fn bucket_name(slug: &str) -> String {
    let name = format!("kdb-{slug}");
    if name.len() <= 63 {
        return name;
    }
    // FNV-1a: stable across builds and platforms, unlike std's hasher.
    let h = slug.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    format!("{}-{:08x}", name[..54].trim_end_matches('-'), h as u32)
}

/// Access policy for a project's key: everything inside its own bucket, nothing else.
pub fn bucket_policy(bucket: &str) -> Value {
    json!({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Action": ["s3:*"],
            "Resource": [format!("arn:aws:s3:::{bucket}"), format!("arn:aws:s3:::{bucket}/*")]
        }]
    })
}

impl S3 {
    /// A request to the storage server signed with the root credentials (AWS SigV4).
    async fn request(&self, method: reqwest::Method, path_and_query: &str, body: Option<Vec<u8>>) -> R<Bytes> {
        let url = format!("{}{path_and_query}", self.endpoint);
        let body = body.unwrap_or_default();
        let mut signed = http::Request::builder()
            .method(method.as_str())
            .uri(&url)
            .body(object_store::client::HttpRequestBody::from(body.clone()))
            .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let cred = AwsCredential { key_id: self.access_key.clone(), secret_key: self.secret_key.clone(), token: None };
        AwsAuthorizer::new(&cred, "s3", &self.region)
            .try_authorize(&mut signed, None)
            .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("signing a storage request failed: {e}")))?;
        let mut req = reqwest::Client::new().request(method, &url).body(body);
        for (k, v) in signed.headers() {
            req = req.header(k.as_str(), v.as_bytes());
        }
        let res = req.send().await.map_err(|e| err(StatusCode::SERVICE_UNAVAILABLE, format!("file storage unreachable: {e}")))?;
        let status = res.status();
        let bytes = res.bytes().await.unwrap_or_default();
        if status.is_success() {
            Ok(bytes)
        } else {
            let code = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            Err(err(code, format!("file storage returned {status}: {}", String::from_utf8_lossy(&bytes).chars().take(300).collect::<String>())))
        }
    }

    /// Create an access key limited to the project's bucket (RustFS admin API, plain JSON on its native path).
    async fn create_key(&self, slug: &str, access_key: &str, secret_key: &str) -> R<()> {
        let bucket = bucket_name(slug);
        let body = json!({
            "accessKey": access_key,
            "secretKey": secret_key,
            "name": format!("kodudb-{slug}").chars().take(32).collect::<String>(),
            "description": format!("KoduDB project {slug}: read and write access to bucket {bucket}"),
            "policy": bucket_policy(&bucket),
        });
        self.request(reqwest::Method::PUT, "/rustfs/admin/v3/add-service-accounts", Some(body.to_string().into_bytes())).await?;
        Ok(())
    }

    async fn delete_key(&self, access_key: &str) -> R<()> {
        // Keys are generated here as uppercase hex, so they need no URL encoding; refuse anything else.
        if access_key.is_empty() || !access_key.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(err(StatusCode::BAD_REQUEST, "invalid storage access key"));
        }
        self.request(reqwest::Method::DELETE, &format!("/rustfs/admin/v3/delete-service-accounts?accessKey={access_key}"), None).await.map(|_| ())
    }
}

/// A project's storage credentials, as shown in the console.
pub async fn credentials(platform: &PgPool, enc_key: &str, backend: &Backend, slug: &str) -> R<Value> {
    let Some(s3) = backend.s3() else {
        return Ok(json!({ "backend": "local" }));
    };
    let mut out = json!({
        "backend": "s3",
        "endpoint": s3.public_url,
        "region": s3.region,
        "bucket": bucket_name(slug),
        "access_key": null,
        "secret_key": null,
        "console_url": s3.console_url,
    });
    match ensure_key(platform, enc_key, s3, slug).await {
        Ok((access_key, secret_key)) => {
            out["access_key"] = json!(access_key);
            out["secret_key"] = json!(secret_key);
        }
        Err(e) if e.0 == StatusCode::NOT_FOUND && e.1.starts_with("project ") => return Err(e),
        // e.g. an S3 server without the RustFS admin API: files work, keys cannot be issued.
        Err(e) => out["key_error"] = json!(format!("Could not create an access key: {}", e.1)),
    }
    Ok(out)
}

/// The project's key, created (and stored encrypted) the first time it is needed.
pub async fn ensure_key(platform: &PgPool, enc_key: &str, s3: &S3, slug: &str) -> R<(String, String)> {
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("select storage_access_key, pgp_sym_decrypt(storage_secret_enc, $2) from platform.projects where slug = $1")
            .bind(slug)
            .bind(enc_key)
            .fetch_optional(platform)
            .await?;
    match row {
        None => Err(err(StatusCode::NOT_FOUND, format!("project {slug} not found"))),
        Some((Some(a), Some(s))) => Ok((a, s)),
        Some(_) => issue_key(platform, enc_key, s3, slug).await,
    }
}

/// Create a new key for the project and store it; the previous one (if any) is deleted afterwards.
pub async fn issue_key(platform: &PgPool, enc_key: &str, s3: &S3, slug: &str) -> R<(String, String)> {
    let (access_key, secret_key): (String, String) = sqlx::query_as(
        "select upper(encode(gen_random_bytes(10), 'hex')), rtrim(translate(encode(gen_random_bytes(30), 'base64'), '+/', 'AB'), '=')",
    )
    .fetch_one(platform)
    .await?;
    s3.create_key(slug, &access_key, &secret_key).await?;
    let old: Option<Option<String>> = sqlx::query_scalar(
        "update platform.projects p set storage_access_key = $2, storage_secret_enc = pgp_sym_encrypt($3, $4)
         from (select slug, storage_access_key from platform.projects where slug = $1 for update) o
         where p.slug = o.slug returning o.storage_access_key",
    )
    .bind(slug)
    .bind(&access_key)
    .bind(&secret_key)
    .bind(enc_key)
    .fetch_optional(platform)
    .await?;
    match old {
        None => {
            let _ = s3.delete_key(&access_key).await; // the project vanished meanwhile
            Err(err(StatusCode::NOT_FOUND, format!("project {slug} not found")))
        }
        Some(old) => {
            if let Some(old) = old {
                if let Err(e) = s3.delete_key(&old).await {
                    eprintln!("could not delete the previous storage key of {slug}: {}", e.1);
                }
            }
            Ok((access_key, secret_key))
        }
    }
}

/// Remove a deleted project's key and bucket (objects first; S3 refuses to delete a non-empty bucket).
pub async fn drop_project(backend: &Backend, slug: &str, access_key: Option<&str>) {
    let Backend::S3(s3) = backend else { return };
    if let Some(k) = access_key {
        if let Err(e) = s3.delete_key(k).await {
            eprintln!("could not delete the storage key of {slug}: {}", e.1);
        }
    }
    if let Ok(store) = backend.project_store(slug).await {
        if let Err(e) = delete_prefix(&store, None).await {
            eprintln!("could not empty the storage bucket of {slug}: {}", e.1);
        }
    }
    if let Err(e) = s3.request(reqwest::Method::DELETE, &format!("/{}", bucket_name(slug)), None).await {
        eprintln!("could not delete the storage bucket of {slug}: {}", e.1);
    }
}

/// Delete every object under `prefix` (all objects when `None`).
pub async fn delete_prefix(store: &Arc<dyn ObjectStore>, prefix: Option<&ObjPath>) -> R<()> {
    let locations = store.list(prefix).map_ok(|m| m.location).boxed();
    store
        .delete_stream(locations)
        .try_collect::<Vec<_>>()
        .await
        .map(|_| ())
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

const MIGRATED_MARKER: &str = ".migrated-to-s3";

/// One-time copy of a project's files from the local directory into its bucket, for installs that used local
/// storage before S3 was configured. The local files are kept; a marker file stops the copy from running again.
pub async fn migrate_local(backend: &Backend, local_root: &std::path::Path, slug: &str) -> R<usize> {
    if backend.s3().is_none() {
        return Ok(0);
    }
    let dir = Backend::local_dir(local_root, slug);
    if !tokio::fs::try_exists(&dir).await.unwrap_or(false) || tokio::fs::try_exists(dir.join(MIGRATED_MARKER)).await.unwrap_or(false) {
        return Ok(0);
    }
    let io = |e: String| err(StatusCode::INTERNAL_SERVER_ERROR, format!("migrating local files of {slug}: {e}"));
    let local = LocalFileSystem::new_with_prefix(&dir).map_err(|e| io(e.to_string()))?;
    let target = backend.project_store(slug).await?;
    let mut files = local.list(None);
    let mut copied = 0;
    while let Some(meta) = files.next().await {
        let meta = meta.map_err(|e| io(e.to_string()))?;
        let key = meta.location.as_ref();
        // The default project's directory also holds other projects (_projects/) and leftovers from uploads.
        if key.starts_with("_projects/") || key == MIGRATED_MARKER || key.ends_with(".part") {
            continue;
        }
        let bytes = local.get(&meta.location).await.map_err(|e| io(e.to_string()))?.bytes().await.map_err(|e| io(e.to_string()))?;
        target.put(&meta.location, PutPayload::from(bytes)).await.map_err(|e| io(e.to_string()))?;
        copied += 1;
    }
    tokio::fs::write(dir.join(MIGRATED_MARKER), b"Files in this directory were copied to S3 storage; KoduDB no longer reads them.\n")
        .await
        .map_err(|e| io(e.to_string()))?;
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::{bucket_name, bucket_policy};

    #[test]
    fn bucket_names_are_valid_s3_names() {
        assert_eq!(bucket_name("default"), "kdb-default");
        assert_eq!(bucket_name("ab"), "kdb-ab");
        let long = format!("a{}", "-x1".repeat(20));
        let b = bucket_name(&long);
        assert!(b.len() <= 63 && b.starts_with("kdb-a") && !b.ends_with('-'), "{b}");
        assert_eq!(b, bucket_name(&long), "stable");
        assert_ne!(bucket_name(&format!("{long}a")), bucket_name(&format!("{long}b")));
        for n in [bucket_name("demo-store"), b] {
            assert!(n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'), "{n}");
        }
    }

    #[test]
    fn key_policy_is_limited_to_one_bucket() {
        let p = bucket_policy("kdb-shop");
        assert_eq!(p["Statement"][0]["Resource"], serde_json::json!(["arn:aws:s3:::kdb-shop", "arn:aws:s3:::kdb-shop/*"]));
        assert_eq!(p["Statement"].as_array().unwrap().len(), 1);
    }
}
