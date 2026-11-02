//! Multi-project platform: each project is its own Postgres database with its own keys.
//! Routes: /platform/v1/* (root service key) and /p/{slug}/* (dispatched to the project's API).
use std::{collections::HashMap, sync::Arc, time::Duration};

use axum::{
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tokio::{sync::RwLock, task::JoinHandle};
use tower::ServiceExt;

use crate::ctx::{err, require_service, AppState, R};

pub const PLATFORM_SQL: &str = include_str!("../sql/platform.sql");
pub const PROJECT_SQL: &str = include_str!("../sql/project.sql");

struct Loaded {
    app: Router,
    state: AppState,
    listener: JoinHandle<()>,
}

pub struct Registry {
    pub root: AppState,
    root_secret: String,
    /// Console sign-in (username, password).
    pub console: (String, String),
    opts: PgConnectOptions,
    loaded: RwLock<HashMap<String, Arc<Loaded>>>,
}

#[derive(sqlx::FromRow)]
pub struct ProjectRow {
    pub slug: String,
    pub db_name: String,
    pub parent: Option<String>,
    pub git_branch: String,
    pub github_repo: Option<String>,
    pub github_api_url: Option<String>,
}

/// "My Shop 2" -> "my-shop-2"; must start with a letter.
pub fn slugify(name: &str) -> R<String> {
    let mut s = String::new();
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') && !s.is_empty() {
            s.push('-');
        }
    }
    let s = s.trim_end_matches('-').chars().take(40).collect::<String>().trim_end_matches('-').to_string();
    if s.len() < 2 || !s.starts_with(|c: char| c.is_ascii_lowercase()) || s == "default" {
        return Err(err(StatusCode::BAD_REQUEST, "name must start with a letter, be at least 2 characters and not be 'default'"));
    }
    Ok(s)
}

fn db_name(slug: &str) -> String {
    crate::owner::pg_name("p_", slug, "")
}

impl Registry {
    pub fn new(root: AppState, root_secret: String, console: (String, String), opts: PgConnectOptions) -> Self {
        Self { root, root_secret, console, opts, loaded: RwLock::new(HashMap::new()) }
    }

    pub fn require_root(&self, headers: &HeaderMap) -> R<()> {
        require_service(&self.root.claims(headers, None)?)
    }

    pub async fn project(&self, slug: &str) -> R<ProjectRow> {
        sqlx::query_as("select slug, db_name, parent, git_branch, github_repo, github_api_url from platform.projects where slug = $1")
            .bind(slug)
            .fetch_optional(&self.root.platform)
            .await?
            .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("project not found: {slug}")))
    }

    /// Project state, connecting its pool and realtime listener on first use.
    pub async fn state(&self, slug: &str) -> R<AppState> {
        Ok(self.load(slug).await?.state.clone())
    }

    async fn load(&self, slug: &str) -> R<Arc<Loaded>> {
        if slug == "default" {
            return Err(err(StatusCode::BAD_REQUEST, "the default project is served at the root URL"));
        }
        if let Some(l) = self.loaded.read().await.get(slug) {
            return Ok(l.clone());
        }
        // Connect without holding the lock: a slow or unreachable project database must not stall
        // requests to every other project. If another request finished first, use its entry instead.
        let fresh = Arc::new(self.connect(slug).await?);
        let mut map = self.loaded.write().await;
        if let Some(existing) = map.get(slug).cloned() {
            drop(map);
            fresh.listener.abort();
            fresh.state.pool.close().await;
            return Ok(existing);
        }
        map.insert(slug.to_string(), fresh.clone());
        Ok(fresh)
    }

    async fn connect(&self, slug: &str) -> R<Loaded> {
        let row = self.project(slug).await?;
        let secret: String = sqlx::query_scalar("select pgp_sym_decrypt(jwt_secret_enc, $2) from platform.projects where slug = $1")
            .bind(slug)
            .bind(&self.root_secret)
            .fetch_one(&self.root.platform)
            .await?;
        // Connect as the project's own owner role, never as the superuser.
        let owner = crate::owner::owner_options(&self.root.platform, &self.opts, &self.root_secret, slug, &row.db_name).await?;
        let settings: crate::settings::Handle = Arc::new(std::sync::RwLock::new(crate::settings::load(&self.root.platform, slug).await));
        let idle = settings.read().unwrap().pool_idle();
        let pool = crate::settings::on_connect(PgPoolOptions::new(), settings.clone())
            .max_connections(5)
            .idle_timeout(idle)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(owner)
            .await
            .map_err(|e| err(StatusCode::SERVICE_UNAVAILABLE, format!("project database unavailable: {e}")))?;
        let (realtime, listener) = crate::realtime::spawn_listener(&pool).await?;
        let objects = self.root.objects.clone();
        let store = objects.project_store(slug).await?;
        if let crate::objects::Backend::S3(_) = objects.as_ref() {
            let local_root = std::path::PathBuf::from(std::env::var("STORAGE_ROOT").unwrap_or_else(|_| "storage".into()));
            match crate::objects::migrate_local(&objects, &local_root, slug).await {
                Ok(0) => {}
                Ok(n) => eprintln!("copied {n} local files of project {slug} to S3 storage"),
                Err(e) => eprintln!("{}", e.1),
            }
        }
        let state = AppState::new(
            slug.to_string(),
            pool,
            &secret,
            store,
            objects,
            realtime,
            self.root.logs.clone(),
            self.root.platform.clone(),
            self.root.enc_key.clone(),
            settings,
        );
        Ok(Loaded { app: crate::project_app(state.clone()), state, listener })
    }

    /// Close a project's connections (before cloning or dropping its database).
    async fn unload(&self, slug: &str) {
        if let Some(l) = self.loaded.write().await.remove(slug) {
            l.listener.abort();
            l.state.pool.close().await;
        }
    }

    async fn terminate_connections(&self, db: &str) -> R<()> {
        sqlx::query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()")
            .bind(db)
            .execute(&self.root.platform)
            .await?;
        Ok(())
    }

    /// Insert the registry row, create the database (empty or cloned) and bootstrap it.
    async fn provision(&self, slug: &str, name: &str, parent: Option<&ProjectRow>, git_branch: &str) -> R<Value> {
        let db = db_name(slug);
        sqlx::query(
            "insert into platform.projects (slug, name, db_name, jwt_secret_enc, parent, git_branch, github_repo, github_token_enc, github_api_url)
             select $1, $2, $3, pgp_sym_encrypt(s.secret, $4, 'cipher-algo=aes256, s2k-digest-algo=sha256'), $5, $6, p.github_repo, p.github_token_enc, p.github_api_url
             from (select encode(gen_random_bytes(48), 'base64') secret) s
             left join platform.projects p on p.slug = $5",
        )
        .bind(slug)
        .bind(name)
        .bind(&db)
        .bind(&self.root_secret)
        .bind(parent.map(|p| p.slug.clone()))
        .bind(git_branch)
        .execute(&self.root.platform)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(d) if d.code().as_deref() == Some("23505") => err(StatusCode::CONFLICT, format!("project {slug} already exists")),
            e => e.into(),
        })?;
        let created = match parent {
            None => sqlx::query(sqlx::AssertSqlSafe(format!("create database \"{db}\""))).execute(&self.root.platform).await,
            Some(p) => {
                // CREATE DATABASE ... TEMPLATE needs the source to have no other sessions.
                self.unload(&p.slug).await;
                self.terminate_connections(&p.db_name).await?;
                sqlx::query(sqlx::AssertSqlSafe(format!("create database \"{db}\" template \"{}\"", p.db_name))).execute(&self.root.platform).await
            }
        };
        if let Err(e) = created {
            let _ = sqlx::query("delete from platform.projects where slug = $1").bind(slug).execute(&self.root.platform).await;
            return Err(e.into());
        }
        let ready = async {
            if parent.is_none() {
                let pool = PgPoolOptions::new().max_connections(1).connect_with(self.opts.clone().database(&db)).await?;
                let boot = sqlx::raw_sql(PROJECT_SQL).execute(&pool).await;
                pool.close().await;
                boot?;
            }
            // New databases and branch clones alike end up owned by this project's own role.
            crate::owner::ensure_owner(&self.root.platform, &self.opts, &self.root_secret, slug, &db).await
        }
        .await;
        if let Err(e) = ready {
            let _ = self.drop_project(slug).await;
            return Err(e);
        }
        if let crate::objects::Backend::S3(s3) = self.root.objects.as_ref() {
            if let Err(e) = crate::objects::ensure_key(&self.root.platform, &self.root_secret, s3, slug).await {
                eprintln!("storage key for {slug} not created yet (retried on first use): {}", e.1);
            }
        }
        self.describe(slug).await
    }

    async fn drop_project(&self, slug: &str) -> R<()> {
        let t = std::time::Instant::now();
        let row = self.project(slug).await?;
        let storage_key: Option<String> =
            sqlx::query_scalar("select storage_access_key from platform.projects where slug = $1").bind(slug).fetch_optional(&self.root.platform).await?.flatten();
        self.unload(slug).await;
        let unloaded = t.elapsed();
        sqlx::query(sqlx::AssertSqlSafe(format!("drop database if exists \"{}\" with (force)", row.db_name))).execute(&self.root.platform).await?;
        let dropped = t.elapsed();
        sqlx::query("delete from platform.projects where slug = $1").bind(slug).execute(&self.root.platform).await?;
        crate::owner::drop_owner(&self.root.platform, slug).await;
        // Diagnostic for a one-off 30 s delete seen once in testing (2026-10-29), not reproduced since.
        if t.elapsed() > std::time::Duration::from_secs(2) {
            eprintln!("slow project delete {slug}: unload {unloaded:?}, drop database {dropped:?}, total {:?}", t.elapsed());
        }
        match self.root.objects.as_ref() {
            crate::objects::Backend::Local(root) => {
                let _ = tokio::fs::remove_dir_all(crate::objects::Backend::local_dir(root, slug)).await;
            }
            backend => crate::objects::drop_project(backend, slug, storage_key.as_deref()).await,
        }
        Ok(())
    }

    /// Bring every project database up to the current bootstrap (new tables and functions) and give each
    /// project its owner role. Idempotent; runs at every start. Recording of migrations is switched off so
    /// platform upgrades never show up as the user's schema changes.
    pub async fn upgrade_all(&self) {
        let upgrade = format!("set session_replication_role = replica;
{PROJECT_SQL}");
        // Always a one-off connection: session_replication_role would otherwise stay on a pooled
        // connection and silently disable every trigger (live events, change log) for later requests.
        let default_upgrade = async {
            let pool = PgPoolOptions::new().max_connections(1).connect_with(self.opts.clone()).await?;
            let r = sqlx::raw_sql(sqlx::AssertSqlSafe(upgrade.as_str())).execute(&pool).await;
            // Same connection, triggers still off: bring stored secrets up to AES-256.
            let columns: Vec<_> = crate::crypto::PLATFORM_COLUMNS.iter().chain(crate::crypto::PROJECT_COLUMNS).copied().collect();
            let n = crate::crypto::upgrade_columns(&pool, &self.root_secret, &columns).await;
            if n > 0 {
                eprintln!("re-encrypted {n} stored secrets of the platform and default project with AES-256");
            }
            pool.close().await;
            r.map(|_| ())
        }
        .await;
        if let Err(e) = default_upgrade {
            eprintln!("upgrade of the default project failed: {e}");
        }
        let rows: Vec<(String, String)> = match sqlx::query_as("select slug, db_name from platform.projects where slug <> 'default' order by parent nulls first, slug")
            .fetch_all(&self.root.platform)
            .await
        {
            Ok(r) => r,
            Err(e) => return eprintln!("owner migration skipped: {e}"),
        };
        for (slug, db) in rows {
            let upgraded = async {
                let pool = PgPoolOptions::new().max_connections(1).connect_with(self.opts.clone().database(&db)).await?;
                let r = sqlx::raw_sql(sqlx::AssertSqlSafe(upgrade.as_str())).execute(&pool).await;
                let n = crate::crypto::upgrade_columns(&pool, &self.root_secret, crate::crypto::PROJECT_COLUMNS).await;
                if n > 0 {
                    eprintln!("re-encrypted {n} stored secrets of {slug} with AES-256");
                }
                pool.close().await;
                r.map(|_| ())
            }
            .await;
            if let Err(e) = upgraded {
                eprintln!("upgrade of {slug} failed: {e}");
            }
            if let Err(e) = crate::owner::ensure_owner(&self.root.platform, &self.opts, &self.root_secret, &slug, &db).await {
                eprintln!("owner role for {slug}: {}", e.1);
            }
        }
    }

    /// Project summary including its API URL prefix and keys.
    async fn describe(&self, slug: &str) -> R<Value> {
        let row: Value = sqlx::query_scalar(
            "select jsonb_build_object('slug', slug, 'name', name, 'db_name', db_name, 'parent', parent, 'git_branch', git_branch,
               'github_repo', github_repo, 'github_api_url', github_api_url, 'github_connected', github_token_enc is not null,
               'created_at', created_at, 'size', pg_database_size(db_name))
             from platform.projects where slug = $1",
        )
        .bind(slug)
        .fetch_optional(&self.root.platform)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("project not found: {slug}")))?;
        let state = if slug == "default" { self.root.clone() } else { self.state(slug).await? };
        let (anon, service) = state.project_keys();
        let mut v = row;
        v["path"] = json!(if slug == "default" { String::new() } else { format!("/p/{slug}") });
        v["public_key"] = json!(anon);
        v["secret_key"] = json!(service);
        Ok(v)
    }
}

/// Fallback handler: forwards /p/{slug}/{rest} to that project's router with the prefix stripped.
/// It runs as a fallback (not a route) so no outer path params leak into the project's extractors.
pub async fn dispatch(State(reg): State<Arc<Registry>>, mut req: Request) -> Response {
    let Some((slug, rest)) = req.uri().path().strip_prefix("/p/").and_then(|p| p.split_once('/')).map(|(s, r)| (s.to_string(), r.to_string())) else {
        return err(StatusCode::NOT_FOUND, "not found").into_response();
    };
    let loaded = match reg.load(&slug).await {
        Ok(l) => l,
        Err(e) => return e.into_response(),
    };
    let pq = match req.uri().query() {
        Some(q) => format!("/{rest}?{q}"),
        None => format!("/{rest}"),
    };
    match pq.parse::<Uri>() {
        Ok(uri) => *req.uri_mut() = uri,
        Err(_) => return err(StatusCode::BAD_REQUEST, "bad path").into_response(),
    }
    loaded.app.clone().oneshot(req).await.into_response()
}

pub fn routes(reg: Arc<Registry>) -> Router {
    Router::new()
        .route("/platform/v1/console/session", post(crate::secrets::console_session))
        .route("/platform/v1/projects", get(list).post(create))
        .route("/platform/v1/projects/{slug}", get(get_one).delete(remove))
        .route("/platform/v1/projects/{slug}/branches", post(branch))
        .route("/platform/v1/projects/{slug}/rotate-keys", post(rotate_one))
        .route("/platform/v1/projects/{slug}/extensions", post(extension))
        .route("/platform/v1/projects/{slug}/storage", get(storage_credentials))
        .route("/platform/v1/projects/{slug}/storage/rotate", post(rotate_storage_key))
        .route("/platform/v1/rotate-keys", post(rotate_all))
        .route("/platform/v1/projects/{slug}/settings", get(settings_get).put(settings_put))
        .route("/platform/v1/projects/{slug}/github", put(github_config))
        .route("/platform/v1/projects/{slug}/github/push", post(crate::github::push))
        .route("/platform/v1/projects/{slug}/github/pull-request", post(crate::github::pull_request))
        .with_state(reg)
}

async fn list(State(reg): State<Arc<Registry>>, headers: HeaderMap) -> R<Json<Value>> {
    reg.require_root(&headers)?;
    let rows: Value = sqlx::query_scalar(
        "select coalesce(jsonb_agg(jsonb_build_object('slug', slug, 'name', name, 'db_name', db_name, 'parent', parent,
           'git_branch', git_branch, 'github_repo', github_repo, 'created_at', created_at, 'size', pg_database_size(db_name))
           order by (slug <> 'default'), coalesce(parent, slug), parent nulls first, slug), '[]')
         from platform.projects",
    )
    .fetch_one(&reg.root.platform)
    .await?;
    Ok(Json(rows))
}

/// File storage details for a project; with S3, its bucket and access key (created on first request).
async fn storage_credentials(State(reg): State<Arc<Registry>>, headers: HeaderMap, Path(slug): Path<String>) -> R<Json<Value>> {
    reg.require_root(&headers)?;
    reg.project(&slug).await?;
    Ok(Json(crate::objects::credentials(&reg.root.platform, &reg.root_secret, &reg.root.objects, &slug).await?))
}

/// Replace a project's S3 access key; the old key stops working.
async fn rotate_storage_key(State(reg): State<Arc<Registry>>, headers: HeaderMap, Path(slug): Path<String>) -> R<Json<Value>> {
    reg.require_root(&headers)?;
    reg.project(&slug).await?;
    let Some(s3) = reg.root.objects.s3() else {
        return Err(err(StatusCode::BAD_REQUEST, "files are stored locally; there is no storage key to rotate"));
    };
    crate::objects::issue_key(&reg.root.platform, &reg.root_secret, s3, &slug).await?;
    Ok(Json(crate::objects::credentials(&reg.root.platform, &reg.root_secret, &reg.root.objects, &slug).await?))
}

async fn get_one(State(reg): State<Arc<Registry>>, headers: HeaderMap, Path(slug): Path<String>) -> R<Json<Value>> {
    reg.require_root(&headers)?;
    Ok(Json(reg.describe(&slug).await?))
}

#[derive(Deserialize)]
struct NewProject {
    name: String,
}

async fn create(State(reg): State<Arc<Registry>>, headers: HeaderMap, Json(b): Json<NewProject>) -> R<Json<Value>> {
    reg.require_root(&headers)?;
    let slug = slugify(&b.name)?;
    Ok(Json(reg.provision(&slug, b.name.trim(), None, "main").await?))
}

#[derive(Deserialize)]
struct NewBranch {
    name: String,
}

async fn branch(State(reg): State<Arc<Registry>>, headers: HeaderMap, Path(slug): Path<String>, Json(b): Json<NewBranch>) -> R<Json<Value>> {
    reg.require_root(&headers)?;
    let parent = reg.project(&slug).await?;
    if slug == "default" {
        return Err(err(StatusCode::BAD_REQUEST, "the default project shares the platform database and cannot be branched; create a project first"));
    }
    let branch = slugify(&b.name)?;
    let child = format!("{slug}-{branch}");
    slugify(&child)?;
    Ok(Json(reg.provision(&child, &format!("{slug} / {branch}"), Some(&parent), &branch).await?))
}

async fn remove(State(reg): State<Arc<Registry>>, headers: HeaderMap, Path(slug): Path<String>) -> R<StatusCode> {
    reg.require_root(&headers)?;
    if slug == "default" {
        return Err(err(StatusCode::BAD_REQUEST, "the default project cannot be deleted"));
    }
    // Branches go first: a project cannot be removed while its branches exist.
    let children: Vec<String> = sqlx::query_scalar("select slug from platform.projects where parent = $1")
        .bind(&slug)
        .fetch_all(&reg.root.platform)
        .await?;
    for c in children {
        reg.drop_project(&c).await?;
    }
    reg.drop_project(&slug).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn rotate_one(State(reg): State<Arc<Registry>>, headers: HeaderMap, Path(slug): Path<String>) -> R<Json<Value>> {
    reg.require_root(&headers)?;
    Ok(Json(reg.rotate(&slug).await?))
}

/// Rotate every project's keys in one call (the default project is reported as skipped).
async fn rotate_all(State(reg): State<Arc<Registry>>, headers: HeaderMap) -> R<Json<Value>> {
    reg.require_root(&headers)?;
    let slugs: Vec<String> = sqlx::query_scalar("select slug from platform.projects where slug <> 'default' order by slug")
        .fetch_all(&reg.root.platform)
        .await?;
    let mut rotated = Vec::new();
    for s in &slugs {
        reg.rotate(s).await?;
        rotated.push(s.clone());
    }
    Ok(Json(json!({ "rotated": rotated, "skipped": ["default"] })))
}

#[derive(Deserialize)]
struct ExtensionChange {
    name: String,
    enabled: bool,
}

/// Enable or disable an extension. Runs as superuser inside the project database, because the
/// project's owner role may only create trusted extensions; the name must be one Postgres offers.
async fn extension(State(reg): State<Arc<Registry>>, headers: HeaderMap, Path(slug): Path<String>, Json(b): Json<ExtensionChange>) -> R<Json<Value>> {
    reg.require_root(&headers)?;
    let db = reg.project(&slug).await?.db_name;
    let pool = PgPoolOptions::new().max_connections(1).connect_with(reg.opts.clone().database(&db)).await?;
    let result = async {
        let known: bool = sqlx::query_scalar("select exists(select 1 from pg_available_extensions where name = $1)")
            .bind(&b.name)
            .fetch_one(&pool)
            .await?;
        if !known {
            return Err(err(StatusCode::BAD_REQUEST, format!("unknown extension: {}", b.name)));
        }
        // The name matched pg_available_extensions, so quoting it is enough.
        let q = b.name.replace('"', "\"\"");
        let sql = if b.enabled { format!("create extension if not exists \"{q}\"") } else { format!("drop extension if exists \"{q}\"") };
        sqlx::query(sqlx::AssertSqlSafe(sql.as_str())).execute(&pool).await?;
        Ok(json!({ "name": b.name, "enabled": b.enabled }))
    }
    .await;
    pool.close().await;
    Ok(Json(result?))
}

impl Registry {
    async fn state_of(&self, slug: &str) -> R<AppState> {
        self.project(slug).await?;
        if slug == "default" { Ok(self.root.clone()) } else { self.state(slug).await }
    }

    /// Project settings plus the sign-up confirmation switch, which lives with the identity settings.
    async fn settings_json(&self, st: &AppState) -> R<Json<Value>> {
        let mut v = json!(*st.settings.read().unwrap());
        v["require_email_confirmation"] = json!(crate::mail::settings(st).await?.require_email_confirmation);
        Ok(Json(v))
    }
}

async fn settings_get(State(reg): State<Arc<Registry>>, headers: HeaderMap, Path(slug): Path<String>) -> R<Json<Value>> {
    reg.require_root(&headers)?;
    let st = reg.state_of(&slug).await?;
    reg.settings_json(&st).await
}

/// Partial update: fields that are sent replace the stored ones. Database-level effects (idle timeouts) reach
/// new connections, so a changed idle setting reloads the project's pool (live realtime sockets reconnect).
async fn settings_put(State(reg): State<Arc<Registry>>, headers: HeaderMap, Path(slug): Path<String>, Json(body): Json<Value>) -> R<Json<Value>> {
    reg.require_root(&headers)?;
    let st = reg.state_of(&slug).await?;
    let old = st.settings.read().unwrap().clone();
    let mut merged = json!(old);
    for (k, x) in body.as_object().ok_or_else(|| err(StatusCode::BAD_REQUEST, "expected a JSON object"))? {
        merged[k] = x.clone();
    }
    let new: crate::settings::Settings = serde_json::from_value(merged).map_err(|e| err(StatusCode::BAD_REQUEST, format!("invalid settings: {e}")))?;
    new.validate()?;
    let confirm = match body.get("require_email_confirmation") {
        None => None,
        Some(v) => Some(v.as_bool().ok_or_else(|| err(StatusCode::BAD_REQUEST, "require_email_confirmation must be true or false"))?),
    };
    sqlx::query("update platform.projects set settings = $2 where slug = $1").bind(&slug).bind(json!(new)).execute(&reg.root.platform).await?;
    if let Some(c) = confirm {
        sqlx::query("update auth.settings set require_email_confirmation = $1, updated_at = now() where id = 1").bind(c).execute(&st.pool).await?;
    }
    *st.settings.write().unwrap() = new.clone();
    crate::logs::prune(&reg.root.platform, Some(&slug)).await;
    let out = reg.settings_json(&st).await;
    if slug != "default" && !old.same_idle(&new) {
        reg.unload(&slug).await;
    }
    out
}

#[derive(Deserialize)]
struct GithubConfig {
    repo: String,
    token: Option<String>,
    api_url: Option<String>,
    branch: Option<String>,
}

async fn github_config(State(reg): State<Arc<Registry>>, headers: HeaderMap, Path(slug): Path<String>, Json(b): Json<GithubConfig>) -> R<Json<Value>> {
    reg.require_root(&headers)?;
    let valid_repo = b.repo.split_once('/').is_some_and(|(o, r)| {
        let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
        ok(o) && ok(r)
    });
    if !valid_repo {
        return Err(err(StatusCode::BAD_REQUEST, "repo must look like owner/name"));
    }
    if let Some(u) = &b.api_url {
        if !(u.starts_with("https://") || u.starts_with("http://")) {
            return Err(err(StatusCode::BAD_REQUEST, "api_url must be an http(s) URL"));
        }
    }
    let n = sqlx::query(
        "update platform.projects set github_repo = $2,
           github_token_enc = coalesce(pgp_sym_encrypt(nullif($3, ''), $4, 'cipher-algo=aes256, s2k-digest-algo=sha256'), github_token_enc),
           github_api_url = $5, git_branch = coalesce(nullif($6, ''), git_branch)
         where slug = $1",
    )
    .bind(&slug)
    .bind(&b.repo)
    .bind(b.token.unwrap_or_default())
    .bind(&reg.root_secret)
    .bind(b.api_url.filter(|u| !u.is_empty()))
    .bind(b.branch.unwrap_or_default())
    .execute(&reg.root.platform)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(err(StatusCode::NOT_FOUND, "project not found"));
    }
    Ok(Json(reg.describe(&slug).await?))
}

impl Registry {
    /// New JWT secret for a project: every key and session token issued before it stops working,
    /// and live realtime connections are closed when the project unloads.
    async fn rotate(&self, slug: &str) -> R<Value> {
        if slug == "default" {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "the default project signs with JWT_SECRET from .env; rotate it with `node scripts/gen-env.mjs --rotate` and restart",
            ));
        }
        let n = sqlx::query(
            "update platform.projects set jwt_secret_enc = pgp_sym_encrypt(encode(gen_random_bytes(48), 'base64'), $2, 'cipher-algo=aes256, s2k-digest-algo=sha256') where slug = $1",
        )
        .bind(slug)
        .bind(&self.root_secret)
        .execute(&self.root.platform)
        .await?
        .rows_affected();
        if n == 0 {
            return Err(err(StatusCode::NOT_FOUND, format!("project not found: {slug}")));
        }
        self.unload(slug).await;
        self.describe(slug).await
    }

    pub async fn github_token(&self, slug: &str) -> R<String> {
        let t: Option<String> = sqlx::query_scalar("select pgp_sym_decrypt(github_token_enc, $2) from platform.projects where slug = $1")
            .bind(slug)
            .bind(&self.root_secret)
            .fetch_optional(&self.root.platform)
            .await?
            .flatten();
        t.ok_or_else(|| err(StatusCode::BAD_REQUEST, "connect GitHub for this project first"))
    }
}

#[cfg(test)]
mod tests {
    use super::{db_name, slugify};

    #[test]
    fn slugs_are_safe_identifiers() {
        assert_eq!(slugify("My Shop 2").unwrap(), "my-shop-2");
        assert_eq!(slugify("  orders__API!! ").unwrap(), "orders-api");
        assert!(slugify("2fast").is_err());
        assert!(slugify("x").is_err());
        assert!(slugify("default").is_err());
        assert!(slugify("\"; drop database x; --").unwrap().chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
        assert_eq!(db_name("my-shop"), "p_my_shop");
    }
}
