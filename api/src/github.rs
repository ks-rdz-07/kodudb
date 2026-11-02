//! Push recorded schema migrations to GitHub and open pull requests for branch projects.
use std::{sync::Arc, time::Duration};

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use base64::Engine;
use reqwest::Method;
use serde_json::{json, Value};

use crate::{
    ctx::{err, ApiError, R},
    platform::Registry,
};

struct Gh {
    http: reqwest::Client,
    api: String,
    token: String,
    repo: String,
}

impl Gh {
    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> R<(u16, Value)> {
        let mut r = self
            .http
            .request(method, format!("{}/repos/{}{path}", self.api.trim_end_matches('/'), self.repo))
            .bearer_auth(&self.token)
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "kodudb")
            .header("x-github-api-version", "2022-11-28")
            .timeout(Duration::from_secs(20));
        if let Some(b) = body {
            r = r.json(&b);
        }
        let res = r.send().await.map_err(|e| err(StatusCode::BAD_GATEWAY, format!("GitHub unreachable: {e}")))?;
        let status = res.status().as_u16();
        Ok((status, res.json::<Value>().await.unwrap_or(Value::Null)))
    }

    fn fail(status: u16, v: &Value) -> ApiError {
        err(StatusCode::BAD_GATEWAY, format!("GitHub returned {status}: {}", v["message"].as_str().unwrap_or("unknown error")))
    }

    /// Create `branch` from `base` unless it already exists.
    async fn ensure_branch(&self, branch: &str, base: &str) -> R<()> {
        if self.call(Method::GET, &format!("/git/ref/heads/{branch}"), None).await?.0 == 200 {
            return Ok(());
        }
        let (s, v) = self.call(Method::GET, &format!("/git/ref/heads/{base}"), None).await?;
        if s != 200 {
            return Err(Self::fail(s, &v));
        }
        let (s, v) = self
            .call(Method::POST, "/git/refs", Some(json!({ "ref": format!("refs/heads/{branch}"), "sha": v["object"]["sha"] })))
            .await?;
        if s == 201 || s == 422 { Ok(()) } else { Err(Self::fail(s, &v)) }
    }

    /// Commit one file; Ok(None) if it already exists on the branch.
    async fn put_file(&self, path: &str, content: &str, message: &str, branch: &str) -> R<Option<String>> {
        let body = json!({
            "message": message,
            "content": base64::engine::general_purpose::STANDARD.encode(content),
            "branch": branch,
        });
        let (s, v) = self.call(Method::PUT, &format!("/contents/{path}"), Some(body)).await?;
        match s {
            200 | 201 => Ok(v["commit"]["sha"].as_str().map(str::to_string)),
            422 => Ok(None),
            _ => Err(Self::fail(s, &v)),
        }
    }
}

/// File name for a migration: 000012_create_table.sql
pub fn migration_path(root: &str, version: i64, tag: &str) -> String {
    let tag: String = tag.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    format!("kodudb/{root}/migrations/{version:06}_{tag}.sql")
}

async fn client_for(reg: &Registry, slug: &str) -> R<(Gh, crate::platform::ProjectRow)> {
    let p = reg.project(slug).await?;
    let repo = p.github_repo.clone().ok_or_else(|| err(StatusCode::BAD_REQUEST, "connect GitHub for this project first"))?;
    let gh = Gh {
        http: reqwest::Client::new(),
        api: p.github_api_url.clone().unwrap_or_else(|| "https://api.github.com".into()),
        token: reg.github_token(slug).await?,
        repo,
    };
    Ok((gh, p))
}

/// Topmost ancestor: branches commit into their root project's migrations folder.
async fn root_and_base(reg: &Registry, p: &crate::platform::ProjectRow) -> R<(String, String)> {
    let mut root = p.slug.clone();
    let mut parent = p.parent.clone();
    let mut base = p.git_branch.clone();
    let mut first = true;
    while let Some(slug) = parent {
        let row = reg.project(&slug).await?;
        if first {
            base = row.git_branch.clone();
            first = false;
        }
        root = row.slug.clone();
        parent = row.parent.clone();
    }
    Ok((root, base))
}

pub async fn push(State(reg): State<Arc<Registry>>, headers: HeaderMap, Path(slug): Path<String>) -> R<Json<Value>> {
    reg.require_root(&headers)?;
    let (gh, p) = client_for(&reg, &slug).await?;
    let (root, base) = root_and_base(&reg, &p).await?;
    gh.ensure_branch(&p.git_branch, &base).await?;
    let state = if slug == "default" { reg.root.clone() } else { reg.state(&slug).await? };
    let pending: Vec<(i64, String, Option<String>, String, String)> = sqlx::query_as(
        "select version, tag, object, statement, at::text from kodudb_schema.migrations where pushed_at is null order by version",
    )
    .fetch_all(&state.pool)
    .await?;
    let mut pushed = Vec::new();
    for (version, tag, object, statement, at) in pending {
        let path = migration_path(&root, version, &tag);
        let content = format!(
            "-- KoduDB migration {version}\n-- project: {slug}  branch: {}  recorded: {at}\n-- change: {tag} {}\n\n{}\n",
            p.git_branch,
            object.unwrap_or_default(),
            statement.trim()
        );
        let sha = gh.put_file(&path, &content, &format!("kodudb({slug}): {tag} [{version}]"), &p.git_branch).await?;
        sqlx::query("update kodudb_schema.migrations set pushed_at = now(), git_sha = $2 where version = $1")
            .bind(version)
            .bind(&sha)
            .execute(&state.pool)
            .await?;
        pushed.push(json!({ "version": version, "path": path, "sha": sha }));
    }
    Ok(Json(json!({ "repo": gh.repo, "branch": p.git_branch, "pushed": pushed })))
}

pub async fn pull_request(State(reg): State<Arc<Registry>>, headers: HeaderMap, Path(slug): Path<String>) -> R<Json<Value>> {
    reg.require_root(&headers)?;
    let (gh, p) = client_for(&reg, &slug).await?;
    if p.parent.is_none() {
        return Err(err(StatusCode::BAD_REQUEST, "pull requests are opened from branch projects"));
    }
    let (_, base) = root_and_base(&reg, &p).await?;
    let (s, v) = gh
        .call(
            Method::POST,
            "/pulls",
            Some(json!({
                "title": format!("KoduDB: schema changes from {}", p.git_branch),
                "head": p.git_branch,
                "base": base,
                "body": format!("Schema migrations recorded in KoduDB branch project `{slug}`."),
            })),
        )
        .await?;
    match s {
        201 => Ok(Json(json!({ "url": v["html_url"], "number": v["number"] }))),
        422 => Err(err(StatusCode::CONFLICT, format!("GitHub: {}", v["errors"][0]["message"].as_str().or(v["message"].as_str()).unwrap_or("pull request already exists or nothing to merge")))),
        _ => Err(Gh::fail(s, &v)),
    }
}

#[cfg(test)]
mod tests {
    use super::migration_path;

    #[test]
    fn migration_paths_are_ordered_and_safe() {
        assert_eq!(migration_path("shop", 12, "CREATE TABLE"), "kodudb/shop/migrations/000012_create_table.sql");
        assert_eq!(migration_path("shop", 3, "ALTER TABLE ../x"), "kodudb/shop/migrations/000003_alter_table____x.sql");
    }
}
