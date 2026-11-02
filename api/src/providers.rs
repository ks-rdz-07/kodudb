//! Per-project choice of file storage provider. The default is the bundled RustFS (objects.rs); a project can
//! instead use any S3-compatible service with its own endpoint, bucket and keys. Existing files are not moved.
use std::{sync::Arc, time::Duration};

use axum::http::StatusCode;
use futures_util::StreamExt;
use object_store::{aws::AmazonS3Builder, ObjectStore};
use serde::Deserialize;
use sqlx::PgPool;

use crate::ctx::{err, R};

/// Provider ids the console offers. `rustfs` is the bundled server and needs no settings.
pub const PROVIDERS: [&str; 9] = ["rustfs", "aws", "r2", "b2", "wasabi", "spaces", "minio", "gcs", "other"];

/// Providers that only work with virtual-hosted requests (`<bucket>.<host>`); everything else is path-style.
const VIRTUAL_HOSTED: [&str; 2] = ["aws", "spaces"];

pub fn default_path_style(provider: &str) -> bool {
    !VIRTUAL_HOSTED.contains(&provider)
}

#[derive(Deserialize)]
pub struct Input {
    pub provider: String,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub bucket: String,
    #[serde(default)]
    pub access_key: String,
    /// Empty keeps the stored secret.
    #[serde(default)]
    pub secret_key: String,
    pub path_style: Option<bool>,
}

/// A project's own provider settings, as stored.
pub struct Custom {
    pub provider: String,
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    pub path_style: bool,
}

fn bad(msg: &str) -> crate::ctx::ApiError {
    err(StatusCode::BAD_REQUEST, msg)
}

/// Check the fields of a non-RustFS provider; trims them in place.
pub fn validate(i: &mut Input) -> R<()> {
    for s in [&mut i.endpoint, &mut i.region, &mut i.bucket, &mut i.access_key, &mut i.secret_key] {
        *s = s.trim().to_string();
    }
    i.endpoint = i.endpoint.trim_end_matches('/').to_string();
    if !PROVIDERS.contains(&i.provider.as_str()) || i.provider == "rustfs" {
        return Err(bad("unknown storage provider"));
    }
    let url = i.endpoint.strip_prefix("https://").or_else(|| i.endpoint.strip_prefix("http://"));
    if !url.is_some_and(|h| !h.is_empty() && !h.contains(['/', '?', '#', '@', ' '])) {
        return Err(bad("endpoint must be an http(s) address such as https://s3.example.com, without a path"));
    }
    let name_ok = |s: &str, min: usize, max: usize, extra: &str| (min..=max).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c));
    if !name_ok(&i.region, 1, 64, "-_.") {
        return Err(bad("region is required (letters, digits, - _ .)"));
    }
    if !name_ok(&i.bucket, 3, 63, "-.") {
        return Err(bad("bucket name must be 3 to 63 letters, digits, - or ."));
    }
    let key_ok = |s: &str, min: usize| s.len() >= min && s.len() <= 256 && !s.chars().any(|c| c.is_whitespace() || c.is_control());
    if !key_ok(&i.access_key, 1) {
        return Err(bad("access key is required"));
    }
    if !i.secret_key.is_empty() && !key_ok(&i.secret_key, 1) {
        return Err(bad("secret key must not contain spaces"));
    }
    Ok(())
}

/// Address the object store talks to: virtual-hosted requests put the bucket in the host name.
pub fn request_endpoint(c: &Custom) -> String {
    if c.path_style {
        return c.endpoint.clone();
    }
    let (scheme, host) = c.endpoint.split_once("://").unwrap_or(("https", &c.endpoint));
    format!("{scheme}://{}.{host}", c.bucket)
}

pub fn build_store(c: &Custom) -> R<Arc<dyn ObjectStore>> {
    let endpoint = request_endpoint(c);
    AmazonS3Builder::new()
        .with_allow_http(endpoint.starts_with("http://"))
        .with_endpoint(endpoint)
        .with_region(&c.region)
        .with_bucket_name(&c.bucket)
        .with_access_key_id(&c.access_key)
        .with_secret_access_key(&c.secret_key)
        .with_virtual_hosted_style_request(!c.path_style)
        .build()
        .map(|s| Arc::new(s) as Arc<dyn ObjectStore>)
        .map_err(|e| bad(&format!("invalid storage settings: {e}")))
}

/// List one object of the bucket: proves the endpoint, region, bucket and keys work together.
pub async fn test_connection(store: &Arc<dyn ObjectStore>) -> R<()> {
    let probe = async { store.list(None).next().await.transpose() };
    match tokio::time::timeout(Duration::from_secs(15), probe).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(bad(&format!("could not use the bucket: {e}"))),
        Err(_) => Err(bad("could not use the bucket: the storage service did not answer within 15 seconds")),
    }
}

pub async fn load(platform: &PgPool, enc_key: &str, slug: &str) -> R<Option<Custom>> {
    let row: Option<(String, String, String, String, Option<bool>, String, String)> = sqlx::query_as(
        "select storage_provider, storage_endpoint, storage_region, storage_bucket, storage_path_style, storage_custom_access,
                pgp_sym_decrypt(storage_custom_secret_enc, $2)
         from platform.projects where slug = $1 and storage_provider is not null and storage_custom_secret_enc is not null",
    )
    .bind(slug)
    .bind(enc_key)
    .fetch_optional(platform)
    .await?;
    Ok(row.map(|(provider, endpoint, region, bucket, path_style, access_key, secret_key)| {
        let path_style = path_style.unwrap_or_else(|| default_path_style(&provider));
        Custom { provider, endpoint, region, bucket, access_key, secret_key, path_style }
    }))
}

pub async fn save(platform: &PgPool, enc_key: &str, slug: &str, c: &Custom) -> R<()> {
    let n = sqlx::query(
        "update platform.projects set storage_provider = $2, storage_endpoint = $3, storage_region = $4, storage_bucket = $5,
           storage_path_style = $6, storage_custom_access = $7, storage_custom_secret_enc = pgp_sym_encrypt($8, $9, 'cipher-algo=aes256, s2k-digest-algo=sha256')
         where slug = $1",
    )
    .bind(slug)
    .bind(&c.provider)
    .bind(&c.endpoint)
    .bind(&c.region)
    .bind(&c.bucket)
    .bind(c.path_style)
    .bind(&c.access_key)
    .bind(&c.secret_key)
    .bind(enc_key)
    .execute(platform)
    .await?
    .rows_affected();
    if n == 0 { Err(err(StatusCode::NOT_FOUND, format!("project not found: {slug}"))) } else { Ok(()) }
}

/// Back to the bundled RustFS.
pub async fn clear(platform: &PgPool, slug: &str) -> R<()> {
    sqlx::query(
        "update platform.projects set storage_provider = null, storage_endpoint = null, storage_region = null, storage_bucket = null,
           storage_path_style = null, storage_custom_access = null, storage_custom_secret_enc = null where slug = $1",
    )
    .bind(slug)
    .execute(platform)
    .await?;
    Ok(())
}

/// What the console shows for a custom provider; the secret key is never sent back.
pub fn describe(c: &Custom) -> serde_json::Value {
    serde_json::json!({
        "backend": "s3", "provider": c.provider, "endpoint": c.endpoint, "region": c.region, "bucket": c.bucket,
        "access_key": c.access_key, "secret_key": null, "secret_set": true, "path_style": c.path_style, "console_url": null,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> Input {
        Input {
            provider: "r2".into(),
            endpoint: " https://acct.r2.cloudflarestorage.com/ ".into(),
            region: "auto".into(),
            bucket: "my-files".into(),
            access_key: "AKIA123".into(),
            secret_key: "s3cret".into(),
            path_style: None,
        }
    }

    #[test]
    fn accepts_and_trims_valid_input() {
        let mut i = input();
        validate(&mut i).unwrap();
        assert_eq!(i.endpoint, "https://acct.r2.cloudflarestorage.com");
    }

    #[test]
    fn rejects_bad_input() {
        let cases: [fn(&mut Input); 8] = [
            |i| i.provider = "rustfs".into(),
            |i| i.provider = "nope".into(),
            |i| i.endpoint = "ftp://x.example".into(),
            |i| i.endpoint = "https://x.example/path".into(),
            |i| i.region = "".into(),
            |i| i.bucket = "a b".into(),
            |i| i.access_key = "".into(),
            |i| i.secret_key = "has space".into(),
        ];
        for f in cases {
            let mut i = input();
            f(&mut i);
            assert!(validate(&mut i).is_err());
        }
    }

    #[test]
    fn endpoint_follows_addressing_style() {
        assert!(default_path_style("minio") && default_path_style("r2") && !default_path_style("aws") && !default_path_style("spaces"));
        let mut c = Custom { provider: "aws".into(), endpoint: "https://s3.eu-west-1.amazonaws.com".into(), region: "eu-west-1".into(), bucket: "files".into(), access_key: "a".into(), secret_key: "b".into(), path_style: false };
        assert_eq!(request_endpoint(&c), "https://files.s3.eu-west-1.amazonaws.com");
        c.path_style = true;
        assert_eq!(request_endpoint(&c), "https://s3.eu-west-1.amazonaws.com");
        assert!(build_store(&c).is_ok());
    }
}
