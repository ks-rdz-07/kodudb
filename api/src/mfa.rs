//! Multi-factor sign-in with authenticator apps (TOTP, RFC 6238: HMAC-SHA1, 30 s steps, 6 digits).
//! A user with a verified factor never gets a session from a password alone: sign-in returns a
//! short-lived `mfa_token`, exchanged for a session with `grant_type=mfa_totp` and a current code.
use std::{sync::LazyLock, time::Instant};

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use hmac::{Hmac, KeyInit, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha1::Sha1;

use crate::{
    ctx::{err, now, require_service, role, AppState, R},
    ratelimit::Limiter,
};

const STEP: u64 = 30;
const MFA_TOKEN_TTL: u64 = 300;
/// Wrong codes per user per 15 minutes before sign-in pauses.
static MFA_FAILURES: LazyLock<Limiter> = LazyLock::new(|| Limiter::new(5, std::time::Duration::from_secs(15 * 60)));

const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

pub fn base32(bytes: &[u8]) -> String {
    let (mut out, mut buf, mut bits) = (String::new(), 0u32, 0u32);
    for &b in bytes {
        buf = (buf << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            out.push(B32[((buf >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(B32[((buf << (5 - bits)) & 31) as usize] as char);
    }
    out
}

pub fn base32_decode(s: &str) -> Option<Vec<u8>> {
    let (mut out, mut buf, mut bits) = (Vec::new(), 0u32, 0u32);
    for c in s.trim_end_matches('=').bytes() {
        let v = B32.iter().position(|&x| x == c.to_ascii_uppercase())? as u32;
        buf = (buf << 5) | v;
        bits += 5;
        if bits >= 8 {
            out.push((buf >> (bits - 8)) as u8);
            bits -= 8;
        }
    }
    Some(out)
}

/// The 6-digit code for one 30-second step.
pub fn code_at(secret: &[u8], step: u64) -> u32 {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret).expect("any key length");
    mac.update(&step.to_be_bytes());
    let h = mac.finalize().into_bytes();
    let o = (h[19] & 0x0f) as usize;
    let bin = u32::from_be_bytes([h[o] & 0x7f, h[o + 1], h[o + 2], h[o + 3]]);
    bin % 1_000_000
}

/// The step the code matches (current ±1 for clock drift), refusing steps already used.
pub fn matching_step(secret: &[u8], code: &str, unix: u64, last_used: Option<i64>) -> Option<u64> {
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let current = unix / STEP;
    [current.saturating_sub(1), current, current + 1]
        .into_iter()
        .filter(|s| last_used.is_none_or(|l| *s as i64 > l))
        .find(|s| format!("{:06}", code_at(secret, *s)) == code)
}

fn qr_svg(uri: &str) -> String {
    match qrcode::QrCode::new(uri.as_bytes()) {
        Ok(q) => q.render::<qrcode::render::svg::Color>().min_dimensions(200, 200).quiet_zone(true).build(),
        Err(_) => String::new(),
    }
}

fn urlencode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

pub async fn has_verified_factor(st: &AppState, user_id: &str) -> R<bool> {
    Ok(sqlx::query_scalar("select exists(select 1 from auth.mfa_factors where user_id = $1::uuid and status = 'verified')")
        .bind(user_id)
        .fetch_one(&st.pool)
        .await?)
}

/// What a password (or email link) sign-in returns for a user with MFA: no session, a token for step two.
pub async fn challenge(st: &AppState, user_id: &str) -> R<Value> {
    let factors: Value = sqlx::query_scalar(
        "select coalesce(jsonb_agg(jsonb_build_object('id', id, 'type', 'totp', 'friendly_name', friendly_name)), '[]')
         from auth.mfa_factors where user_id = $1::uuid and status = 'verified'",
    )
    .bind(user_id)
    .fetch_one(&st.pool)
    .await?;
    let t = now();
    let mfa_token = st.sign(&json!({ "sub": user_id, "typ": "mfa", "iat": t, "exp": t + MFA_TOKEN_TTL }));
    Ok(json!({ "mfa_required": true, "mfa_token": mfa_token, "expires_in": MFA_TOKEN_TTL, "factors": factors }))
}

fn user_claims(st: &AppState, headers: &HeaderMap) -> R<Value> {
    let c = st.claims(headers, None)?;
    if role(&c) != "authenticated" {
        return Err(err(StatusCode::UNAUTHORIZED, "user token required"));
    }
    Ok(c)
}

async fn secret_of(st: &AppState, factor_id: &str, user_id: &str) -> R<(Vec<u8>, String, Option<i64>)> {
    let row: Option<(String, String, Option<i64>)> = sqlx::query_as(
        "select pgp_sym_decrypt(secret_enc, $3), status, last_used_step from auth.mfa_factors where id = $1::uuid and user_id = $2::uuid",
    )
    .bind(factor_id)
    .bind(user_id)
    .bind(st.enc_key.as_str())
    .fetch_optional(&st.pool)
    .await?;
    let (b32, status, last) = row.ok_or_else(|| err(StatusCode::NOT_FOUND, "factor not found"))?;
    Ok((base32_decode(&b32).unwrap_or_default(), status, last))
}

fn too_many(secs: u64) -> Response {
    let body = Json(json!({ "error": format!("too many wrong codes; try again in {secs} s") }));
    (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, secs.to_string())], body).into_response()
}

/// Checks a code for the user's factor and records its step so it cannot be reused.
async fn check_code(st: &AppState, user_id: &str, factor_id: &str, code: &str) -> R<Result<(), Response>> {
    let key = format!("{}:{user_id}", st.project);
    let t = Instant::now();
    if let Some(secs) = MFA_FAILURES.blocked(&key, t) {
        return Ok(Err(too_many(secs)));
    }
    let (secret, _, last) = secret_of(st, factor_id, user_id).await?;
    match matching_step(&secret, code.trim(), now(), last) {
        Some(step) => {
            MFA_FAILURES.clear(&key);
            sqlx::query("update auth.mfa_factors set last_used_step = $2 where id = $1::uuid").bind(factor_id).bind(step as i64).execute(&st.pool).await?;
            Ok(Ok(()))
        }
        None => {
            MFA_FAILURES.record(&key, t);
            Err(err(StatusCode::BAD_REQUEST, "invalid code"))
        }
    }
}

// ---------- user endpoints ----------

pub async fn list(State(st): State<AppState>, headers: HeaderMap) -> R<Json<Value>> {
    let c = user_claims(&st, &headers)?;
    let v: Value = sqlx::query_scalar(
        "select coalesce(jsonb_agg(jsonb_build_object('id', id, 'type', 'totp', 'friendly_name', friendly_name, 'status', status,
           'created_at', created_at, 'verified_at', verified_at) order by created_at), '[]')
         from auth.mfa_factors where user_id = $1::uuid",
    )
    .bind(c["sub"].as_str())
    .fetch_one(&st.pool)
    .await?;
    Ok(Json(v))
}

#[derive(Deserialize, Default)]
pub struct Enroll {
    friendly_name: Option<String>,
}

pub async fn enroll(State(st): State<AppState>, headers: HeaderMap, body: Option<Json<Enroll>>) -> R<Json<Value>> {
    let c = user_claims(&st, &headers)?;
    let user_id = c["sub"].as_str().unwrap_or_default().to_string();
    if has_verified_factor(&st, &user_id).await? {
        return Err(err(StatusCode::CONFLICT, "an authenticator is already set up; remove it first"));
    }
    let name = body.map(|b| b.0).unwrap_or_default().friendly_name.unwrap_or_else(|| "Authenticator app".into());
    let raw: Vec<u8> = sqlx::query_scalar("select gen_random_bytes(20)").fetch_one(&st.pool).await?;
    let secret = base32(&raw);
    // An abandoned, never-verified setup is replaced rather than piling up.
    sqlx::query("delete from auth.mfa_factors where user_id = $1::uuid and status = 'unverified'").bind(&user_id).execute(&st.pool).await?;
    let id: String = sqlx::query_scalar(
        "insert into auth.mfa_factors (user_id, friendly_name, secret_enc) values ($1::uuid, $2, pgp_sym_encrypt($3, $4, 'cipher-algo=aes256, s2k-digest-algo=sha256')) returning id::text",
    )
    .bind(&user_id)
    .bind(name.chars().take(60).collect::<String>())
    .bind(&secret)
    .bind(st.enc_key.as_str())
    .fetch_one(&st.pool)
    .await?;
    let issuer = format!("KoduDB {}", st.project);
    let account = c["email"].as_str().unwrap_or("user");
    let uri = format!(
        "otpauth://totp/{}:{}?secret={secret}&issuer={}&algorithm=SHA1&digits=6&period=30",
        urlencode(&issuer),
        urlencode(account),
        urlencode(&issuer)
    );
    Ok(Json(json!({
        "id": id, "type": "totp", "friendly_name": name,
        "totp": { "secret": secret, "uri": uri, "qr_code": format!("data:image/svg+xml;base64,{}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, qr_svg(&uri))) },
    })))
}

#[derive(Deserialize)]
pub struct Code {
    code: String,
}

/// Confirms a new factor with its first code; returns a session that already counts as two-factor.
pub async fn verify(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>, Json(b): Json<Code>) -> R<Response> {
    let c = user_claims(&st, &headers)?;
    let user_id = c["sub"].as_str().unwrap_or_default().to_string();
    if let Err(r) = check_code(&st, &user_id, &id, &b.code).await? {
        return Ok(r);
    }
    let first = sqlx::query("update auth.mfa_factors set status = 'verified', verified_at = coalesce(verified_at, now()) where id = $1::uuid and status <> 'verified'")
        .bind(&id)
        .execute(&st.pool)
        .await?
        .rows_affected();
    if first > 0 {
        crate::mail::notify(&st, &user_id, "mfa_enabled").await;
    }
    let user = crate::auth::active_user(&st, Some(&user_id)).await?;
    Ok(Json(crate::auth::session_with(&st, user, "aal2")).into_response())
}

/// Removing a working authenticator needs a two-factor session, so a stolen password cannot switch it off.
pub async fn unenroll(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> R<StatusCode> {
    let c = user_claims(&st, &headers)?;
    let user_id = c["sub"].as_str().unwrap_or_default();
    let (_, status, _) = secret_of(&st, &id, user_id).await?;
    if status == "verified" && c["aal"] != "aal2" {
        return Err(err(StatusCode::FORBIDDEN, "sign in with your authenticator code first"));
    }
    sqlx::query("delete from auth.mfa_factors where id = $1::uuid and user_id = $2::uuid").bind(&id).bind(user_id).execute(&st.pool).await?;
    if status == "verified" {
        crate::mail::notify(&st, user_id, "mfa_disabled").await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Step two of sign-in: `POST /auth/v1/token?grant_type=mfa_totp` with `{ mfa_token, code }`.
pub async fn sign_in(st: &AppState, mfa_token: &str, code: &str, factor_id: Option<&str>) -> R<Response> {
    let c = st.decode(mfa_token)?;
    if c["typ"] != "mfa" {
        return Err(err(StatusCode::UNAUTHORIZED, "not an mfa_token"));
    }
    let user_id = c["sub"].as_str().unwrap_or_default().to_string();
    let factor: Option<String> = match factor_id {
        Some(f) => Some(f.to_string()),
        None => sqlx::query_scalar("select id::text from auth.mfa_factors where user_id = $1::uuid and status = 'verified' order by created_at limit 1")
            .bind(&user_id)
            .fetch_optional(&st.pool)
            .await?,
    };
    let factor = factor.ok_or_else(|| err(StatusCode::BAD_REQUEST, "no authenticator set up"))?;
    if let Err(r) = check_code(st, &user_id, &factor, code).await? {
        return Ok(r);
    }
    let user = crate::auth::active_user(st, Some(&user_id)).await?;
    sqlx::query("update auth.users set last_sign_in_at = now() where id = $1::uuid").bind(&user_id).execute(&st.pool).await?;
    Ok(Json(crate::auth::session_with(st, user, "aal2")).into_response())
}

// ---------- admin ----------

/// Removes every factor of a user (a lost phone). The user signs in with a password again and can re-enrol.
pub async fn admin_reset(State(st): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    let n = sqlx::query("delete from auth.mfa_factors where user_id = $1::uuid").bind(&id).execute(&st.pool).await?.rows_affected();
    if n > 0 {
        crate::mail::notify(&st, &id, "mfa_disabled").await;
    }
    Ok(Json(json!({ "removed": n })))
}

#[cfg(test)]
mod tests {
    use super::{base32, base32_decode, code_at, matching_step};

    // RFC 6238 appendix B, SHA-1 seed; the last 6 digits of the published 8-digit codes.
    const SEED: &[u8] = b"12345678901234567890";

    #[test]
    fn matches_rfc_6238_vectors() {
        assert_eq!(code_at(SEED, 59 / 30), 287_082);
        assert_eq!(code_at(SEED, 1_111_111_109 / 30), 81_804);
        assert_eq!(code_at(SEED, 1_234_567_890 / 30), 5_924);
        assert_eq!(code_at(SEED, 2_000_000_000 / 30), 279_037);
    }

    #[test]
    fn accepts_drift_and_refuses_replay() {
        let t = 1_234_567_890;
        assert_eq!(matching_step(SEED, "005924", t, None), Some(t / 30));
        assert_eq!(matching_step(SEED, "005924", t + 30, None), Some(t / 30), "one step late");
        assert_eq!(matching_step(SEED, "005924", t + 90, None), None, "too late");
        assert_eq!(matching_step(SEED, "005924", t, Some((t / 30) as i64)), None, "already used");
        assert_eq!(matching_step(SEED, "5924", t, None), None, "six digits only");
    }

    #[test]
    fn base32_round_trips() {
        assert_eq!(base32(b"foobar"), "MZXW6YTBOI");
        assert_eq!(base32_decode("MZXW6YTBOI").unwrap(), b"foobar");
        assert_eq!(base32_decode(&base32(SEED)).unwrap(), SEED);
    }
}
