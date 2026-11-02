//! Email/password auth issuing HS256 JWTs (access 1h, refresh 30d).
use std::time::Instant;

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    ctx::{err, now, require_service, role, AppState, ClientIp, R},
    ratelimit::{SIGNIN_EMAIL, SIGNIN_IP},
};

const ACCESS_TTL: u64 = 3600;
const REFRESH_TTL: u64 = 30 * 24 * 3600;
pub const USER_COLS: &str = "(to_jsonb(u) - 'encrypted_password') || jsonb_build_object(
  'mfa_enabled', exists(select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified'),
  'providers', coalesce((select jsonb_agg(i.provider order by i.provider) from auth.identities i where i.user_id = u.id), '[]'))";

#[derive(Deserialize)]
pub struct Credentials {
    email: Option<String>,
    password: Option<String>,
    refresh_token: Option<String>,
    #[serde(default)]
    data: Option<Value>,
    /// Where the confirmation link lands (must be on the project's site URL).
    redirect_to: Option<String>,
    /// Second sign-in step (grant_type=mfa_totp).
    mfa_token: Option<String>,
    code: Option<String>,
    factor_id: Option<String>,
}

#[derive(Deserialize)]
pub struct GrantQuery {
    grant_type: Option<String>,
}

fn validate(email: &str, password: &str) -> R<()> {
    let at = email.find('@');
    if email.len() > 254 || !at.is_some_and(|i| i > 0 && email[i + 1..].contains('.')) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid email"));
    }
    validate_password(password)
}

fn validate_password(password: &str) -> R<()> {
    if password.len() < 8 || password.len() > 72 {
        return Err(err(StatusCode::BAD_REQUEST, "password must be 8-72 characters"));
    }
    Ok(())
}

fn metadata(v: Option<Value>) -> R<Value> {
    let v = v.unwrap_or_else(|| json!({}));
    if !v.is_object() || v.to_string().len() > 16_384 {
        return Err(err(StatusCode::BAD_REQUEST, "data must be a JSON object under 16KB"));
    }
    Ok(v)
}

pub async fn audit(st: &AppState, user: Option<&Value>, email: &str, action: &str, ip: Option<String>) {
    let id = user.and_then(|u| u["id"].as_str()).map(str::to_string);
    let _ = sqlx::query("insert into auth.audit_log (user_id, email, action, ip) values ($1::uuid, $2, $3, $4)")
        .bind(id)
        .bind(email)
        .bind(action)
        .bind(ip)
        .execute(&st.pool)
        .await;
}

pub fn session(st: &AppState, user: Value) -> Value {
    session_with(st, user, "aal1")
}

/// `aal` is the assurance level: aal1 = password or link, aal2 = also an authenticator code.
/// Policies can require it with `auth.jwt() ->> 'aal' = 'aal2'`.
pub fn session_with(st: &AppState, user: Value, aal: &str) -> Value {
    let t = now();
    let sub = user["id"].clone();
    let access = st.sign(&json!({
        "sub": sub, "email": user["email"], "role": "authenticated", "aud": "authenticated", "aal": aal,
        "user_metadata": user["user_metadata"], "iat": t, "exp": t + ACCESS_TTL,
    }));
    let refresh = st.sign(&json!({ "sub": sub, "typ": "refresh", "aal": aal, "iat": t, "exp": t + REFRESH_TTL }));
    json!({ "access_token": access, "token_type": "bearer", "expires_in": ACCESS_TTL, "refresh_token": refresh, "user": user })
}

pub async fn signup(State(st): State<AppState>, headers: HeaderMap, ClientIp(ip): ClientIp, Json(b): Json<Credentials>) -> R<Json<Value>> {
    st.claims(&headers, None)?;
    if !st.settings.read().unwrap().allow_signups {
        return Err(err(StatusCode::FORBIDDEN, "sign-ups are disabled for this project"));
    }
    let (email, password) = (b.email.unwrap_or_default(), b.password.unwrap_or_default());
    validate(&email, &password)?;
    let confirm = crate::mail::settings(&st).await?.require_email_confirmation;
    let user: Value = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "insert into auth.users as u (email, encrypted_password, user_metadata, email_confirmed_at)
         values (lower($1), crypt($2, gen_salt('bf', 10)), $3, case when $4 then null else now() end) returning {USER_COLS}"
    )))
    .bind(&email)
    .bind(&password)
    .bind(metadata(b.data)?)
    .bind(confirm)
    .fetch_one(&st.pool)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(d) if d.code().as_deref() == Some("23505") => err(StatusCode::CONFLICT, "user already registered"),
        e => e.into(),
    })?;
    audit(&st, Some(&user), &email, "signup", ip).await;
    if confirm {
        // No session until the address is confirmed through the emailed link.
        let id = user["id"].as_str().unwrap_or_default().to_string();
        crate::mail::send_link(&st, &id, &email.to_lowercase(), "confirm", b.redirect_to.as_deref()).await?;
        return Ok(Json(json!({ "user": user, "confirmation_sent": true })));
    }
    Ok(Json(session(&st, user)))
}

pub async fn token(
    State(st): State<AppState>,
    headers: HeaderMap,
    ClientIp(ip): ClientIp,
    Query(q): Query<GrantQuery>,
    Json(b): Json<Credentials>,
) -> R<Response> {
    st.claims(&headers, None)?;
    match q.grant_type.as_deref() {
        Some("password") => {
            let email = b.email.unwrap_or_default().to_lowercase();
            let (email_key, ip_key) = (format!("{}:{email}", st.project), format!("{}:{}", st.project, ip.as_deref().unwrap_or("-")));
            let now = Instant::now();
            if let Some(secs) = SIGNIN_EMAIL.blocked(&email_key, now).or_else(|| SIGNIN_IP.blocked(&ip_key, now)) {
                audit(&st, None, &email, "login_throttled", ip).await;
                let body = Json(json!({ "error": format!("too many failed sign-ins; try again in {secs} s") }));
                return Ok((StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, secs.to_string())], body).into_response());
            }
            let user: Option<(Value, bool)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "select {USER_COLS}, u.banned from auth.users u
                 where u.email = lower($1) and u.encrypted_password = crypt($2, u.encrypted_password)"
            )))
            .bind(&email)
            .bind(b.password.unwrap_or_default())
            .fetch_optional(&st.pool)
            .await?;
            match user {
                None => {
                    SIGNIN_EMAIL.record(&email_key, now);
                    SIGNIN_IP.record(&ip_key, now);
                    audit(&st, None, &email, "login_failed", ip).await;
                    Err(err(StatusCode::BAD_REQUEST, "invalid login credentials"))
                }
                Some((_, true)) => Err(err(StatusCode::FORBIDDEN, "user is banned")),
                Some((user, false)) if user["email_confirmed_at"].is_null() && crate::mail::settings(&st).await?.require_email_confirmation => {
                    Err(err(StatusCode::BAD_REQUEST, "email not confirmed"))
                }
                Some((user, false)) if user["mfa_enabled"] == true => {
                    // Right password, but the session waits for the authenticator code.
                    SIGNIN_EMAIL.clear(&email_key);
                    audit(&st, Some(&user), &email, "login_mfa_challenge", ip).await;
                    Ok(Json(crate::mfa::challenge(&st, user["id"].as_str().unwrap_or_default()).await?).into_response())
                }
                Some((user, false)) => {
                    sqlx::query("update auth.users set last_sign_in_at = now() where id = $1::uuid")
                        .bind(user["id"].as_str())
                        .execute(&st.pool)
                        .await?;
                    SIGNIN_EMAIL.clear(&email_key);
                    audit(&st, Some(&user), &email, "login", ip).await;
                    Ok(Json(session(&st, user)).into_response())
                }
            }
        }
        Some("refresh_token") => {
            let c = st.decode(b.refresh_token.as_deref().unwrap_or_default())?;
            if c["typ"] != "refresh" {
                return Err(err(StatusCode::UNAUTHORIZED, "not a refresh token"));
            }
            let user = active_user(&st, c["sub"].as_str()).await?;
            Ok(Json(session_with(&st, user, c["aal"].as_str().unwrap_or("aal1"))).into_response())
        }
        Some("mfa_totp") => {
            crate::mfa::sign_in(&st, b.mfa_token.as_deref().unwrap_or_default(), b.code.as_deref().unwrap_or_default(), b.factor_id.as_deref()).await
        }
        _ => Err(err(StatusCode::BAD_REQUEST, "grant_type must be password, refresh_token or mfa_totp")),
    }
}

pub async fn active_user(st: &AppState, id: Option<&str>) -> R<Value> {
    let row: Option<(Value, bool)> = sqlx::query_as(sqlx::AssertSqlSafe(format!("select {USER_COLS}, u.banned from auth.users u where u.id = $1::uuid")))
        .bind(id)
        .fetch_optional(&st.pool)
        .await?;
    match row {
        Some((u, false)) => Ok(u),
        Some((_, true)) => Err(err(StatusCode::FORBIDDEN, "user is banned")),
        None => Err(err(StatusCode::UNAUTHORIZED, "user not found")),
    }
}

fn user_claims(st: &AppState, headers: &HeaderMap) -> R<Value> {
    let c = st.claims(headers, None)?;
    if role(&c) != "authenticated" {
        return Err(err(StatusCode::UNAUTHORIZED, "user token required"));
    }
    Ok(c)
}

pub async fn get_user(State(st): State<AppState>, headers: HeaderMap) -> R<Json<Value>> {
    let c = user_claims(&st, &headers)?;
    Ok(Json(active_user(&st, c["sub"].as_str()).await?))
}

#[derive(Deserialize)]
pub struct UserUpdate {
    password: Option<String>,
    data: Option<Value>,
    user_metadata: Option<Value>,
    ban: Option<bool>,
    email: Option<String>,
}

async fn apply_update(st: &AppState, id: &str, b: UserUpdate, allow_ban: bool) -> R<Value> {
    if let Some(pw) = &b.password {
        validate_password(pw)?;
    }
    let meta = b.data.or(b.user_metadata).map(|m| metadata(Some(m))).transpose()?;
    let changed_password = b.password.is_some();
    let ban = if allow_ban { b.ban } else { None };
    let user: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "update auth.users u set
           encrypted_password = coalesce(crypt($2, gen_salt('bf', 10)), encrypted_password),
           user_metadata = coalesce($3, user_metadata),
           banned = coalesce($4, banned)
         where id = $1::uuid returning {USER_COLS}"
    )))
    .bind(id)
    .bind(b.password)
    .bind(meta)
    .bind(ban)
    .fetch_optional(&st.pool)
    .await?;
    let user = user.ok_or_else(|| err(StatusCode::NOT_FOUND, "user not found"))?;
    if changed_password {
        crate::mail::notify(st, id, "password_changed").await;
    }
    Ok(user)
}

pub async fn update_user(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<UserUpdate>) -> R<Json<Value>> {
    let c = user_claims(&st, &headers)?;
    let id = c["sub"].as_str().unwrap_or_default().to_string();
    active_user(&st, Some(&id)).await?;
    Ok(Json(apply_update(&st, &id, b, false).await?))
}

pub async fn logout(State(st): State<AppState>, headers: HeaderMap) -> R<StatusCode> {
    // shortcut: tokens are stateless, logout is client-side; add a revocation table if server-side revoke is needed.
    user_claims(&st, &headers)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct Page {
    page: Option<i64>,
    per_page: Option<i64>,
    search: Option<String>,
}

pub async fn admin_list(State(st): State<AppState>, headers: HeaderMap, Query(q): Query<Page>) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    let per = q.per_page.unwrap_or(50).clamp(1, 1000);
    let off = (q.page.unwrap_or(1).max(1) - 1) * per;
    let search = format!("%{}%", q.search.unwrap_or_default().replace(['%', '_'], ""));
    let (users, total): (Value, i64) = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select coalesce((select jsonb_agg(x) from (select {USER_COLS} x from auth.users u where u.email like $3
            order by u.created_at desc limit $1 offset $2) s), '[]'),
         (select count(*) from auth.users where email like $3)"
    )))
    .bind(per)
    .bind(off)
    .bind(search)
    .fetch_one(&st.pool)
    .await?;
    Ok(Json(json!({ "users": users, "total": total })))
}

pub async fn admin_create(State(st): State<AppState>, headers: HeaderMap, ClientIp(ip): ClientIp, Json(b): Json<UserUpdate>) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    let (email, password) = (b.email.clone().unwrap_or_default(), b.password.clone().unwrap_or_default());
    validate(&email, &password)?;
    let user: Value = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "insert into auth.users as u (email, encrypted_password, user_metadata, email_confirmed_at)
         values (lower($1), crypt($2, gen_salt('bf', 10)), $3, now()) returning {USER_COLS}"
    )))
    .bind(&email)
    .bind(&password)
    .bind(metadata(b.user_metadata.or(b.data))?)
    .fetch_one(&st.pool)
    .await?;
    audit(&st, Some(&user), &email, "admin_create", ip).await;
    Ok(Json(user))
}

pub async fn admin_update(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<UserUpdate>) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    Ok(Json(apply_update(&st, &id, b, true).await?))
}

pub async fn admin_delete(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> R<StatusCode> {
    require_service(&st.claims(&headers, None)?)?;
    let n = sqlx::query("delete from auth.users where id = $1::uuid").bind(&id).execute(&st.pool).await?.rows_affected();
    if n == 0 { Err(err(StatusCode::NOT_FOUND, "user not found")) } else { Ok(StatusCode::NO_CONTENT) }
}

pub async fn admin_audit(State(st): State<AppState>, headers: HeaderMap, Query(q): Query<Page>) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    let per = q.per_page.unwrap_or(100).clamp(1, 1000);
    let rows: Value = sqlx::query_scalar(
        "select coalesce(jsonb_agg(a order by a.id desc), '[]') from (select * from auth.audit_log order by id desc limit $1) a",
    )
    .bind(per)
    .fetch_one(&st.pool)
    .await?;
    Ok(Json(rows))
}

#[cfg(test)]
mod tests {
    use super::validate;

    #[test]
    fn validates_credentials() {
        assert!(validate("user@example.com", "longenough").is_ok());
        assert!(validate("nope", "longenough").is_err());
        assert!(validate("@example.com", "longenough").is_err());
        assert!(validate("user@example.com", "short").is_err());
    }
}
