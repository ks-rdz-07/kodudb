//! Platform secrets and the console sign-in. Each value comes from the environment when it is set;
//! otherwise it is generated on first start, kept in the root database (kodudb.secrets) so every
//! restart and replica uses the same one, and written to the .env file when there is one.
//! This is what lets KoduDB start with only DATABASE_URL on Docker, Railpack, Nixpacks, buildpacks,
//! PM2 or a Windows server.
use std::{io::Write, sync::LazyLock, time::Instant};

use axum::{
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use sha1::{Digest, Sha1};
use sqlx::PgPool;

use crate::{
    ctx::{err, now, ClientIp, R},
    platform::Registry,
    ratelimit::Limiter,
};

pub struct Secrets {
    pub jwt_secret: String,
    pub encryption_key: String,
    pub console_user: String,
    pub console_password: String,
}

const CONSOLE_TTL: u64 = 12 * 3600;
/// Failed console sign-ins per caller per 15 minutes.
static CONSOLE_FAILURES: LazyLock<Limiter> = LazyLock::new(|| Limiter::new(20, std::time::Duration::from_secs(15 * 60)));

fn from_env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// The stored value, or `fresh` stored now. `on conflict do nothing` keeps the first one when several
/// replicas start at once.
async fn stored(pool: &PgPool, name: &str, fresh: &str) -> (String, bool) {
    let inserted: Option<String> = sqlx::query_scalar("insert into kodudb.secrets (name, value) values ($1, $2) on conflict (name) do nothing returning value")
        .bind(name)
        .bind(fresh)
        .fetch_optional(pool)
        .await
        .expect("store secret");
    match inserted {
        Some(v) => (v, true),
        None => (sqlx::query_scalar("select value from kodudb.secrets where name = $1").bind(name).fetch_one(pool).await.expect("read secret"), false),
    }
}

async fn random(pool: &PgPool, bytes: i32) -> String {
    sqlx::query_scalar("select rtrim(translate(encode(gen_random_bytes($1), 'base64'), '+/', '-_'), '=')").bind(bytes).fetch_one(pool).await.expect("random")
}

pub async fn resolve(pool: &PgPool) -> Secrets {
    sqlx::raw_sql(
        "create extension if not exists pgcrypto;
         create table if not exists kodudb.secrets (name text primary key, value text not null, created_at timestamptz not null default now());
         revoke all on kodudb.secrets from public",
    )
    .execute(pool)
    .await
    .expect("secrets table");
    let mut generated: Vec<(&str, String)> = Vec::new();
    let mut get = async |name: &'static str, make: Option<String>| -> String {
        if let Some(v) = from_env(name) {
            return v;
        }
        let fresh = match make {
            Some(v) => v,
            None => random(pool, 36).await,
        };
        let (value, new) = stored(pool, name, &fresh).await;
        if new {
            generated.push((name, value.clone()));
        }
        value
    };
    let jwt_secret = get("JWT_SECRET", None).await;
    // Installs from before ENCRYPTION_KEY encrypted stored secrets with JWT_SECRET: keep that key for them.
    let legacy = from_env("JWT_SECRET").is_some();
    let encryption_key = get("ENCRYPTION_KEY", legacy.then(|| jwt_secret.clone())).await;
    let console_user = get("DASHBOARD_USERNAME", Some("admin".into())).await;
    let console_password = get("DASHBOARD_PASSWORD", Some(random(pool, 15).await)).await;
    assert!(jwt_secret.len() >= 32, "JWT_SECRET must be at least 32 characters");

    if !generated.is_empty() {
        write_env_file(&generated);
        let names: Vec<_> = generated.iter().map(|(n, _)| *n).collect();
        eprintln!("generated {} and saved them in the database (kodudb.secrets)", names.join(", "));
    }
    if generated.iter().any(|(n, _)| *n == "DASHBOARD_PASSWORD") {
        eprintln!("\n  ================  KoduDB console sign-in  ================");
        eprintln!("    username: {console_user}");
        eprintln!("    password: {console_password}");
        eprintln!("  Shown once. Set DASHBOARD_PASSWORD to choose your own.");
        eprintln!("  ==========================================================\n");
    }
    Secrets { jwt_secret, encryption_key, console_user, console_password }
}

/// Appends generated values to KODUDB_ENV_FILE, or ./.env when it exists, without touching lines that
/// are already there. Platforms without a writable file (Heroku, Railway) keep them in the database.
fn write_env_file(generated: &[(&str, String)]) {
    let path = from_env("KODUDB_ENV_FILE").unwrap_or_else(|| ".env".into());
    let Ok(existing) = std::fs::read_to_string(&path) else { return };
    let missing: Vec<_> = generated.iter().filter(|(n, _)| !existing.lines().any(|l| l.split_once('=').is_some_and(|(k, _)| k.trim() == *n))).collect();
    if missing.is_empty() {
        return;
    }
    let lines: String = missing.iter().map(|(n, v)| format!("{n}={v}\n")).collect();
    let sep = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
    match std::fs::OpenOptions::new().append(true).open(&path).and_then(|mut f| f.write_all(format!("{sep}{lines}").as_bytes())) {
        Ok(()) => eprintln!("wrote {} to {path}", missing.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(", ")),
        Err(e) => eprintln!("could not update {path}: {e}"),
    }
}

/// Equal-time comparison of two strings (through fixed-length digests).
fn same(a: &str, b: &str) -> bool {
    let (x, y) = (Sha1::digest(a.as_bytes()), Sha1::digest(b.as_bytes()));
    x.iter().zip(y.iter()).fold(0u8, |acc, (p, q)| acc | (p ^ q)) == 0
}

#[derive(Deserialize)]
pub struct ConsoleLogin {
    username: Option<String>,
    password: Option<String>,
}

/// POST /platform/v1/console/session: the console's sign-in. Returns a 12-hour platform token.
pub async fn console_session(State(reg): State<std::sync::Arc<Registry>>, ClientIp(ip): ClientIp, Json(b): Json<ConsoleLogin>) -> R<Response> {
    let key = ip.unwrap_or_else(|| "-".into());
    let at = Instant::now();
    if let Some(secs) = CONSOLE_FAILURES.blocked(&key, at) {
        let body = Json(json!({ "error": format!("too many failed sign-ins; try again in {secs} s") }));
        return Ok((StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, secs.to_string())], body).into_response());
    }
    let (user, pass) = (b.username.unwrap_or_default(), b.password.unwrap_or_default());
    // Both are compared every time, so the answer does not tell which one was wrong.
    let ok = same(&user, &reg.console.0) & same(&pass, &reg.console.1);
    if !ok {
        CONSOLE_FAILURES.record(&key, at);
        return Err(err(StatusCode::UNAUTHORIZED, "wrong username or password"));
    }
    CONSOLE_FAILURES.clear(&key);
    let t = now();
    let token = reg.root.sign(&json!({ "role": "service_role", "iss": "kodudb-console", "sub": user, "iat": t, "exp": t + CONSOLE_TTL }));
    Ok(Json(json!({ "token": token, "expires_in": CONSOLE_TTL, "username": user })).into_response())
}

#[cfg(test)]
mod tests {
    use super::same;

    #[test]
    fn compares_strings() {
        assert!(same("admin", "admin"));
        assert!(!same("admin", "admin "));
        assert!(!same("", "x"));
    }
}
