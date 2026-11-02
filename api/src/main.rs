mod auth;
mod connect;
mod ctx;
mod github;
mod logs;
mod mail;
mod meta;
mod mfa;
mod oauth;
mod objects;
mod owner;
mod platform;
mod realtime;
mod ratelimit;
mod rest;
mod secrets;
mod storage;

use std::{path::PathBuf, str::FromStr, sync::Arc, time::Duration};


use axum::{
    extract::DefaultBodyLimit,
    middleware,
    routing::{any, get, post, put},
    Router,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tower_http::cors::CorsLayer;

use crate::ctx::AppState;

fn env(key: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| panic!("{key} must be set"))
}

fn max_upload() -> usize {
    std::env::var("MAX_UPLOAD_BYTES").ok().and_then(|v| v.parse().ok()).unwrap_or(50 * 1024 * 1024)
}

/// Every per-project API, bound to one project's state.
pub fn project_app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/auth/v1/signup", post(auth::signup))
        .route("/auth/v1/token", post(auth::token))
        .route("/auth/v1/user", get(auth::get_user).put(auth::update_user))
        .route("/auth/v1/logout", post(auth::logout))
        .route("/auth/v1/verify", get(mail::verify_link).post(mail::verify))
        .route("/auth/v1/recover", post(mail::recover))
        .route("/auth/v1/resend", post(mail::resend))
        .route("/auth/v1/admin/settings", get(mail::get_settings).put(mail::put_settings))
        .route("/auth/v1/admin/settings/test", post(mail::test_settings))
        .route("/auth/v1/admin/templates", get(mail::list_templates))
        .route("/auth/v1/admin/templates/{kind}", put(mail::put_template))
        .route("/auth/v1/admin/emails", get(mail::list_emails))
        .route("/auth/v1/factors", get(mfa::list).post(mfa::enroll))
        .route("/auth/v1/factors/{id}/verify", post(mfa::verify))
        .route("/auth/v1/factors/{id}", axum::routing::delete(mfa::unenroll))
        .route("/auth/v1/admin/users/{id}/factors", axum::routing::delete(mfa::admin_reset))
        .route("/auth/v1/authorize", get(oauth::authorize))
        .route("/auth/v1/callback", get(oauth::callback).post(oauth::callback_post))
        .route("/auth/v1/providers", get(oauth::list_public))
        .route("/auth/v1/admin/providers", get(oauth::list_providers))
        .route("/auth/v1/admin/providers/presets", get(oauth::list_presets))
        .route("/auth/v1/admin/providers/{provider}", put(oauth::put_provider).delete(oauth::delete_provider))
        .route("/auth/v1/admin/users", get(auth::admin_list).post(auth::admin_create))
        .route("/auth/v1/admin/users/{id}", put(auth::admin_update).delete(auth::admin_delete))
        .route("/auth/v1/admin/audit", get(auth::admin_audit))
        .route("/rest/v1/rpc/{func}", post(rest::rpc))
        .route("/rest/v1/{table}", get(rest::select).post(rest::insert).patch(rest::update).delete(rest::delete))
        .route("/storage/v1/bucket", get(storage::list_buckets).post(storage::create_bucket))
        .route("/storage/v1/bucket/{id}", put(storage::update_bucket).delete(storage::delete_bucket))
        .route("/storage/v1/object/list/{bucket}", post(storage::list))
        .route("/storage/v1/object/public/{bucket}/{*name}", get(storage::download_public))
        .route(
            "/storage/v1/object/{bucket}/{*name}",
            get(storage::download).post(storage::upload).put(storage::upload).delete(storage::remove),
        )
        .route("/realtime/v1/websocket", get(realtime::ws))
        .route("/meta/v1/query", post(meta::query))
        .route("/meta/v1/tables/{table}/columns", get(meta::columns))
        .route("/meta/v1/stats", get(meta::stats))
        .route("/meta/v1/metrics", get(logs::metrics))
        .route("/meta/v1/logs", get(logs::list))
        .route("/meta/v1/history", get(logs::history))
        .route("/meta/v1/migrations", get(meta::migrations))
        .route("/meta/v1/{kind}", get(meta::catalog))
        .route("/connect/v1/connections", get(connect::list).post(connect::create))
        .route("/connect/v1/connections/{id}", axum::routing::delete(connect::remove))
        .route("/connect/v1/connections/{id}/test", post(connect::test))
        .route("/connect/v1/connections/{id}/objects", get(connect::objects))
        .route("/connect/v1/connections/{id}/query", post(connect::query))
        .layer(middleware::from_fn_with_state(state.clone(), logs::middleware))
        .layer(DefaultBodyLimit::max(max_upload()))
        .with_state(state)
}

#[tokio::main]
async fn main() {
    // Two rustls crypto backends are compiled in (ring and aws-lc-rs), so rustls cannot pick one by itself;
    // without this, the first TLS connection built with the default provider panics.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let opts = PgConnectOptions::from_str(&env("DATABASE_URL")).expect("DATABASE_URL");

    let pool = loop {
        match PgPoolOptions::new().max_connections(20).connect_with(opts.clone()).await {
            Ok(p) => break p,
            Err(e) => {
                eprintln!("waiting for database: {e}");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    };
    sqlx::raw_sql(platform::PLATFORM_SQL).execute(&pool).await.expect("platform bootstrap");

    // From the environment, or generated once and kept in the database (see secrets.rs).
    // Stored secrets are encrypted with ENCRYPTION_KEY so JWT_SECRET can rotate on its own.
    let secrets::Secrets { jwt_secret: secret, encryption_key, console_user, console_password } = secrets::resolve(&pool).await;
    let (realtime, _listener) = realtime::spawn_listener(&pool).await.expect("realtime listener");
    // Files: S3-compatible storage when S3_ENDPOINT is set, otherwise the local STORAGE_ROOT directory.
    let objects = Arc::new(objects::Backend::from_env());
    let local_root = PathBuf::from(std::env::var("STORAGE_ROOT").unwrap_or_else(|_| "storage".into()));
    let root_store = loop {
        match objects.project_store("default").await {
            Ok(s) => break s,
            Err(e) => {
                eprintln!("waiting for file storage: {}", e.1);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    };
    match objects::migrate_local(&objects, &local_root, "default").await {
        Ok(0) => {}
        Ok(n) => eprintln!("copied {n} local files of the default project to S3 storage"),
        Err(e) => eprintln!("{}", e.1),
    }
    let root = AppState::new(
        "default".into(),
        pool.clone(),
        &secret,
        root_store,
        objects,
        realtime,
        logs::spawn_writer(pool.clone()),
        pool,
        Arc::new(encryption_key.clone()),
    );
    let registry = Arc::new(platform::Registry::new(root.clone(), encryption_key, (console_user, console_password), opts));
    registry.upgrade_all().await;

    let app = project_app(root)
        .merge(platform::routes(registry.clone()))
        .fallback_service(any(platform::dispatch).with_state(registry))
        .layer(CorsLayer::permissive());

    let addr = format!("0.0.0.0:{}", std::env::var("PORT").unwrap_or_else(|_| "8787".into()));
    println!("KoduDB API listening on {addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.expect("server");
}
