use std::{path::PathBuf, sync::Arc, time::{SystemTime, UNIX_EPOCH}};

use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::{request::Parts, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use tokio::sync::broadcast;

pub const ROLES: [&str; 3] = ["anon", "authenticated", "service_role"];

/// State for one project: its own database pool, JWT secret, storage folder and realtime feed.
#[derive(Clone)]
pub struct AppState {
    pub project: String,
    pub pool: PgPool,
    pub enc: Arc<EncodingKey>,
    pub dec: Arc<DecodingKey>,
    pub storage_root: PathBuf,
    pub realtime: broadcast::Sender<String>,
    pub visibility: Arc<crate::realtime::VisibilityCache>,
    /// Column lists per table for the REST API, cached briefly; cleared when SQL runs through the console.
    pub columns: Arc<std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, Vec<(String, String)>)>>>,
    pub logs: tokio::sync::mpsc::Sender<crate::logs::Entry>,
    /// Root database holding the platform registry and request logs.
    pub platform: PgPool,
    /// Key for secrets stored in the database (SMTP passwords, connection strings).
    pub enc_key: Arc<String>,
}

impl AppState {
    pub fn new(
        project: String,
        pool: PgPool,
        secret: &str,
        storage_root: PathBuf,
        realtime: broadcast::Sender<String>,
        logs: tokio::sync::mpsc::Sender<crate::logs::Entry>,
        platform: PgPool,
        enc_key: Arc<String>,
    ) -> Self {
        Self {
            project,
            pool,
            enc: Arc::new(EncodingKey::from_secret(secret.as_bytes())),
            dec: Arc::new(DecodingKey::from_secret(secret.as_bytes())),
            storage_root,
            realtime,
            visibility: Arc::default(),
            columns: Arc::default(),
            logs,
            platform,
            enc_key,
        }
    }

    /// Long-lived public and secret keys for this project (roles anon and service_role).
    pub fn project_keys(&self) -> (String, String) {
        let (iat, exp) = (now(), now() + 10 * 365 * 24 * 3600);
        (
            self.sign(&json!({ "role": "anon", "iss": "kodudb", "ref": self.project, "iat": iat, "exp": exp })),
            self.sign(&json!({ "role": "service_role", "iss": "kodudb", "ref": self.project, "iat": iat, "exp": exp })),
        )
    }
}

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);
pub type R<T> = Result<T, ApiError>;

pub fn err(status: StatusCode, msg: impl Into<String>) -> ApiError {
    ApiError(status, msg.into())
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        if let sqlx::Error::Database(d) = &e {
            let status = match d.code().as_deref() {
                Some("42501") => StatusCode::FORBIDDEN,
                Some("23505") => StatusCode::CONFLICT,
                Some(c) if c.starts_with("08") || c.starts_with("53") || c.starts_with("57") => {
                    StatusCode::SERVICE_UNAVAILABLE
                }
                _ => StatusCode::BAD_REQUEST,
            };
            return ApiError(status, d.message().to_string());
        }
        eprintln!("db error: {e}");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, "database error".into())
    }
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

impl AppState {
    pub fn sign(&self, claims: &Value) -> String {
        jsonwebtoken::encode(&Header::new(Algorithm::HS256), claims, &self.enc).expect("jwt encode")
    }

    pub fn decode(&self, token: &str) -> R<Value> {
        let mut v = Validation::new(Algorithm::HS256);
        // Role checks happen on the "role" claim; "aud" is informational only.
        v.validate_aud = false;
        jsonwebtoken::decode::<Value>(token, &self.dec, &v)
            .map(|d| d.claims)
            .map_err(|_| err(StatusCode::UNAUTHORIZED, "invalid or expired token"))
    }

    /// Resolve request claims: `apikey` must be a project key; `Authorization: Bearer` may carry a user token.
    pub fn claims(&self, headers: &HeaderMap, query_apikey: Option<&str>) -> R<Value> {
        let apikey = headers
            .get("apikey")
            .and_then(|v| v.to_str().ok())
            .or(query_apikey)
            .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "missing apikey"))?;
        let key = self.decode(apikey)?;
        if !matches!(key["role"].as_str(), Some("anon" | "service_role")) {
            return Err(err(StatusCode::UNAUTHORIZED, "apikey is not a project key"));
        }
        let token = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or(apikey);
        let c = self.decode(token)?;
        if c["typ"] == "refresh" || !ROLES.contains(&c["role"].as_str().unwrap_or("")) {
            return Err(err(StatusCode::UNAUTHORIZED, "invalid token role"));
        }
        Ok(c)
    }
}

/// The caller's address: the socket peer, or the first X-Forwarded-For hop when TRUST_PROXY is set
/// (only behind a proxy you run; otherwise anyone could pick their own address).
pub struct ClientIp(pub Option<String>);

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        let forwarded = std::env::var_os("TRUST_PROXY")
            .and_then(|_| parts.headers.get("x-forwarded-for"))
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let peer = || parts.extensions.get::<ConnectInfo<std::net::SocketAddr>>().map(|c| c.0.ip().to_string());
        Ok(ClientIp(forwarded.or_else(peer)))
    }
}

pub fn role(c: &Value) -> &str {
    c["role"].as_str().unwrap_or("anon")
}

pub fn require_service(c: &Value) -> R<()> {
    if role(c) == "service_role" { Ok(()) } else { Err(err(StatusCode::FORBIDDEN, "secret key required")) }
}

/// Transaction running as the caller's Postgres role with JWT claims visible to RLS via auth.uid().
pub async fn scoped(pool: &PgPool, c: &Value) -> R<Transaction<'static, Postgres>> {
    let mut tx = pool.begin().await?;
    sqlx::query("select set_config('request.jwt.claims', $1, true)")
        .bind(c.to_string())
        .execute(&mut *tx)
        .await?;
    // role() is one of ROLES (checked in claims), so it is safe to inline.
    sqlx::query(&format!("set local role \"{}\"", role(c))).execute(&mut *tx).await?;
    Ok(tx)
}

/// Postgres identifier we are willing to quote and inline.
pub fn ident(s: &str) -> R<&str> {
    let mut chars = s.chars();
    let ok = s.len() <= 63
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if ok { Ok(s) } else { Err(err(StatusCode::BAD_REQUEST, format!("invalid identifier: {s}"))) }
}

pub fn json_response(body: String) -> Response {
    ([(axum::http::header::CONTENT_TYPE, "application/json")], body).into_response()
}

#[cfg(test)]
mod tests {
    use super::ident;

    #[test]
    fn ident_rejects_injection() {
        assert!(ident("todos").is_ok());
        assert!(ident("_a1").is_ok());
        assert!(ident("1abc").is_err());
        assert!(ident("a\"; drop table x;--").is_err());
        assert!(ident("").is_err());
    }
}
