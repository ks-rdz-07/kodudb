//! Email for identity: per-project SMTP settings, templates, confirmation and password-recovery links.
use std::{sync::LazyLock, time::Instant};

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Json,
};
use lettre::{
    message::{header::{ContentTransferEncoding, ContentType}, MultiPart, SinglePart},
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    ctx::{err, require_service, AppState, R},
    ratelimit::Limiter,
};

const LINK_TTL_MINUTES: i32 = 60;
/// Recovery and resend requests per email address per 15 minutes.
static MAIL_REQUESTS: LazyLock<Limiter> = LazyLock::new(|| Limiter::new(3, std::time::Duration::from_secs(15 * 60)));

pub struct Settings {
    pub require_email_confirmation: bool,
    pub site_url: String,
    host: Option<String>,
    port: i32,
    user: Option<String>,
    password: Option<String>,
    from: Option<String>,
    security: String,
}

pub async fn settings(st: &AppState) -> R<Settings> {
    let row: (bool, String, Option<String>, i32, Option<String>, Option<String>, Option<String>, String) = sqlx::query_as(
        "select require_email_confirmation, site_url, smtp_host, smtp_port, smtp_user,
                case when smtp_pass_enc is null then null else pgp_sym_decrypt(smtp_pass_enc, $1) end, smtp_from, smtp_security
         from auth.settings where id = 1",
    )
    .bind(st.enc_key.as_str())
    .fetch_one(&st.pool)
    .await?;
    Ok(Settings { require_email_confirmation: row.0, site_url: row.1, host: row.2, port: row.3, user: row.4, password: row.5, from: row.6, security: row.7 })
}

/// Public base of this project's API, used in links inside emails.
pub fn api_base(st: &AppState) -> String {
    let base = std::env::var("KODUDB_PUBLIC_URL").unwrap_or_else(|_| "http://localhost:8787".into());
    if st.project == "default" { base } else { format!("{base}/p/{}", st.project) }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// `{{link}}`, `{{email}}`, `{{project}}`, `{{site_url}}`; values are HTML-escaped.
pub fn render(template: &str, vars: &[(&str, &str)]) -> String {
    vars.iter().fold(template.to_string(), |acc, (k, v)| acc.replace(&format!("{{{{{k}}}}}"), &html_escape(v)))
}

/// A plain-text part for clients that do not show HTML: the tags removed, the link kept.
fn plain_text(html: &str, link: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in html.replace("</p>", "\n\n").replace("<br>", "\n").chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    let text = out.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"");
    if link.is_empty() { text.trim().to_string() } else { format!("{}\n\n{link}", text.trim()) }
}

async fn transport(s: &Settings) -> R<AsyncSmtpTransport<Tokio1Executor>> {
    let host = s.host.as_deref().filter(|h| !h.is_empty()).ok_or_else(|| err(StatusCode::BAD_REQUEST, "SMTP is not configured for this project"))?;
    let builder = match s.security.as_str() {
        "tls" => AsyncSmtpTransport::<Tokio1Executor>::relay(host),
        "starttls" => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host),
        _ => Ok(AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)),
    }
    .map_err(|e| err(StatusCode::BAD_REQUEST, format!("SMTP host: {e}")))?;
    let mut builder = builder.port(s.port as u16).timeout(Some(std::time::Duration::from_secs(15)));
    if let (Some(u), Some(p)) = (&s.user, &s.password) {
        if !u.is_empty() {
            builder = builder.credentials(Credentials::new(u.clone(), p.clone()));
        }
    }
    Ok(builder.build())
}

async fn deliver(s: &Settings, to: &str, subject: &str, html: &str, link: &str) -> R<()> {
    let mailer = transport(s).await?;
    let from = s.from.as_deref().filter(|f| !f.is_empty()).ok_or_else(|| err(StatusCode::BAD_REQUEST, "set a From address first"))?;
    let bad = |e: String| err(StatusCode::BAD_REQUEST, e);
    let body = MultiPart::alternative()
        .singlepart(SinglePart::builder().header(ContentType::TEXT_PLAIN).header(ContentTransferEncoding::Base64).body(plain_text(html, link)))
        .singlepart(SinglePart::builder().header(ContentType::TEXT_HTML).header(ContentTransferEncoding::Base64).body(html.to_string()));
    let msg = Message::builder()
        .from(from.parse().map_err(|e| bad(format!("From address: {e}")))?)
        .to(to.parse().map_err(|e| bad(format!("To address: {e}")))?)
        .subject(subject)
        .multipart(body)
        .map_err(|e| bad(e.to_string()))?;
    mailer.send(msg).await.map_err(|e| err(StatusCode::BAD_GATEWAY, format!("SMTP: {e}")))?;
    Ok(())
}

async fn log(st: &AppState, to: &str, kind: &str, subject: &str, result: &R<()>) {
    let (status, error) = match result {
        Ok(()) => ("sent", None),
        Err(e) => ("failed", Some(e.1.clone())),
    };
    let _ = sqlx::query("insert into auth.email_log (to_email, kind, subject, status, error) values ($1, $2, $3, $4, $5)")
        .bind(to)
        .bind(kind)
        .bind(subject)
        .bind(status)
        .bind(error)
        .execute(&st.pool)
        .await;
}

/// Creates a single-use link for `kind` and sends it in the background; the request does not wait on SMTP.
pub async fn send_link(st: &AppState, user_id: &str, email: &str, kind: &str, redirect_to: Option<&str>) -> R<()> {
    let token: String = sqlx::query_scalar(
        "with t as (select encode(gen_random_bytes(32), 'hex') token)
         insert into auth.one_time_tokens (token_hash, user_id, kind, redirect_to, expires_at)
         select encode(digest(t.token, 'sha256'), 'hex'), $1::uuid, $2, $3, now() + make_interval(mins => $4) from t
         returning (select token from t)",
    )
    .bind(user_id)
    .bind(kind)
    .bind(redirect_to)
    .bind(LINK_TTL_MINUTES)
    .fetch_one(&st.pool)
    .await?;
    let link = format!("{}/auth/v1/verify?token={token}&type={kind}", api_base(st));
    let (subject, body): (String, String) = sqlx::query_as("select subject, body from auth.email_templates where kind = $1").bind(kind).fetch_one(&st.pool).await?;
    let s = settings(st).await?;
    let vars = [("link", link.as_str()), ("email", email), ("project", st.project.as_str()), ("site_url", s.site_url.as_str())];
    let (subject, html) = (render(&subject, &vars), render(&body, &vars));
    let (st, email, kind) = (st.clone(), email.to_string(), kind.to_string());
    tokio::spawn(async move {
        let result = deliver(&s, &email, &subject, &html, &link).await;
        log(&st, &email, &kind, &subject, &result).await;
    });
    Ok(())
}

// ---------- public endpoints ----------

#[derive(Deserialize)]
pub struct VerifyQuery {
    token: String,
    #[serde(rename = "type")]
    kind: String,
    redirect_to: Option<String>,
}

/// Consumes a link token: confirms the email or starts a recovery session.
async fn consume(st: &AppState, token: &str, kind: &str) -> R<(Value, Option<String>)> {
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "update auth.one_time_tokens set used_at = now()
         where token_hash = encode(digest($1, 'sha256'), 'hex') and kind = $2 and used_at is null and expires_at > now()
         returning user_id::text, redirect_to",
    )
    .bind(token)
    .bind(kind)
    .fetch_optional(&st.pool)
    .await?;
    let (user_id, redirect) = row.ok_or_else(|| err(StatusCode::BAD_REQUEST, "link is invalid, used or expired"))?;
    let user: Value = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "update auth.users u set email_confirmed_at = coalesce(email_confirmed_at, now()), last_sign_in_at = now()
         where id = $1::uuid and not banned returning {}",
        crate::auth::USER_COLS
    )))
    .bind(&user_id)
    .fetch_optional(&st.pool)
    .await?
    .ok_or_else(|| err(StatusCode::FORBIDDEN, "user is banned or gone"))?;
    Ok((user, redirect))
}

/// Only redirect inside the project's site, so a link cannot send people to a stranger's page.
pub fn safe_redirect(site: &str, wanted: Option<&str>) -> String {
    let origin = |u: &str| u.splitn(4, '/').take(3).collect::<Vec<_>>().join("/");
    match wanted {
        Some(w) if !site.is_empty() && origin(w) == origin(site) => w.to_string(),
        _ => site.to_string(),
    }
}

/// GET /auth/v1/verify: the link in the email. Redirects to the site with the session in the URL fragment.
pub async fn verify_link(State(st): State<AppState>, Query(q): Query<VerifyQuery>) -> Response {
    let s = match settings(&st).await {
        Ok(s) => s,
        Err(e) => return e.into_response(),
    };
    match consume(&st, &q.token, &q.kind).await {
        Ok((user, stored)) => {
            let target = safe_redirect(&s.site_url, q.redirect_to.as_deref().or(stored.as_deref()));
            session_redirect(&st, &target, user, if q.kind == "confirm" { "signup" } else { "recovery" }).await
        }
        Err(e) => {
            let target = safe_redirect(&s.site_url, q.redirect_to.as_deref());
            Redirect::to(&format!("{target}#error={}", urlencode(&e.1))).into_response()
        }
    }
}

/// Sends the browser to `target` with the session in the URL fragment, or with an MFA challenge
/// when the user has an authenticator: links and providers never skip it.
pub async fn session_redirect(st: &AppState, target: &str, user: Value, kind: &str) -> Response {
    if user["mfa_enabled"] == true {
        return match crate::mfa::challenge(st, user["id"].as_str().unwrap_or_default()).await {
            Ok(ch) => Redirect::to(&format!("{target}#mfa_required=true&mfa_token={}&type={kind}", ch["mfa_token"].as_str().unwrap_or_default())).into_response(),
            Err(e) => e.into_response(),
        };
    }
    let session = crate::auth::session(st, user);
    let frag = format!(
        "access_token={}&refresh_token={}&expires_in={}&token_type=bearer&type={kind}",
        session["access_token"].as_str().unwrap_or_default(),
        session["refresh_token"].as_str().unwrap_or_default(),
        session["expires_in"],
    );
    Redirect::to(&format!("{target}#{frag}")).into_response()
}

pub fn urlencode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[derive(Deserialize)]
pub struct VerifyBody {
    token: String,
    #[serde(rename = "type")]
    kind: String,
}

/// POST /auth/v1/verify: the same as the link, for apps that read the token themselves.
pub async fn verify(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<VerifyBody>) -> R<Json<Value>> {
    st.claims(&headers, None)?;
    let (user, _) = consume(&st, &b.token, &b.kind).await?;
    if user["mfa_enabled"] == true {
        return Ok(Json(crate::mfa::challenge(&st, user["id"].as_str().unwrap_or_default()).await?));
    }
    Ok(Json(crate::auth::session(&st, user)))
}

#[derive(Deserialize)]
pub struct EmailRequest {
    email: String,
    redirect_to: Option<String>,
}

fn throttled(email: &str, project: &str) -> Option<Response> {
    let key = format!("{project}:{}", email.to_lowercase());
    let now = Instant::now();
    if let Some(secs) = MAIL_REQUESTS.blocked(&key, now) {
        let body = Json(json!({ "error": format!("too many emails requested; try again in {secs} s") }));
        return Some((StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, secs.to_string())], body).into_response());
    }
    MAIL_REQUESTS.record(&key, now);
    None
}

/// POST /auth/v1/recover: always answers the same way, so it cannot be used to find out who has an account.
pub async fn recover(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<EmailRequest>) -> R<Response> {
    st.claims(&headers, None)?;
    if let Some(r) = throttled(&b.email, &st.project) {
        return Ok(r);
    }
    let id: Option<String> = sqlx::query_scalar("select id::text from auth.users where email = lower($1) and not banned")
        .bind(&b.email)
        .fetch_optional(&st.pool)
        .await?;
    if let Some(id) = id {
        send_link(&st, &id, &b.email.to_lowercase(), "recovery", b.redirect_to.as_deref()).await?;
    }
    Ok(Json(json!({ "message": "If that email has an account, a reset link is on its way." })).into_response())
}

/// POST /auth/v1/resend: a new confirmation link for an unconfirmed address.
pub async fn resend(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<EmailRequest>) -> R<Response> {
    st.claims(&headers, None)?;
    if let Some(r) = throttled(&b.email, &st.project) {
        return Ok(r);
    }
    let id: Option<String> = sqlx::query_scalar("select id::text from auth.users where email = lower($1) and email_confirmed_at is null and not banned")
        .bind(&b.email)
        .fetch_optional(&st.pool)
        .await?;
    if let Some(id) = id {
        send_link(&st, &id, &b.email.to_lowercase(), "confirm", b.redirect_to.as_deref()).await?;
    }
    Ok(Json(json!({ "message": "If that email is waiting for confirmation, a new link is on its way." })).into_response())
}

// ---------- admin endpoints (secret key) ----------

pub async fn get_settings(State(st): State<AppState>, headers: HeaderMap) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    let v: Value = sqlx::query_scalar(
        "select jsonb_build_object('require_email_confirmation', require_email_confirmation, 'site_url', site_url,
           'smtp_host', smtp_host, 'smtp_port', smtp_port, 'smtp_user', smtp_user, 'smtp_from', smtp_from,
           'smtp_security', smtp_security, 'smtp_password_set', smtp_pass_enc is not null, 'updated_at', updated_at)
         from auth.settings where id = 1",
    )
    .fetch_one(&st.pool)
    .await?;
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct SettingsUpdate {
    require_email_confirmation: Option<bool>,
    site_url: Option<String>,
    smtp_host: Option<String>,
    smtp_port: Option<i32>,
    smtp_user: Option<String>,
    /// Write-only; empty keeps the saved password.
    smtp_password: Option<String>,
    smtp_from: Option<String>,
    smtp_security: Option<String>,
}

pub async fn put_settings(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<SettingsUpdate>) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    if let Some(u) = &b.site_url {
        if !(u.starts_with("http://") || u.starts_with("https://")) {
            return Err(err(StatusCode::BAD_REQUEST, "site_url must be an http(s) URL"));
        }
    }
    if b.smtp_port.is_some_and(|p| !(1..=65535).contains(&p)) {
        return Err(err(StatusCode::BAD_REQUEST, "smtp_port must be 1-65535"));
    }
    sqlx::query(
        "update auth.settings set
           require_email_confirmation = coalesce($1, require_email_confirmation),
           site_url = coalesce($2, site_url),
           smtp_host = coalesce($3, smtp_host),
           smtp_port = coalesce($4, smtp_port),
           smtp_user = coalesce($5, smtp_user),
           smtp_pass_enc = coalesce(pgp_sym_encrypt(nullif($6, ''), $9, 'cipher-algo=aes256, s2k-digest-algo=sha256'), smtp_pass_enc),
           smtp_from = coalesce($7, smtp_from),
           smtp_security = coalesce($8, smtp_security),
           updated_at = now()
         where id = 1",
    )
    .bind(b.require_email_confirmation)
    .bind(b.site_url)
    .bind(b.smtp_host)
    .bind(b.smtp_port)
    .bind(b.smtp_user)
    .bind(b.smtp_password)
    .bind(b.smtp_from)
    .bind(b.smtp_security)
    .bind(st.enc_key.as_str())
    .execute(&st.pool)
    .await?;
    get_settings(State(st), headers).await
}

#[derive(Deserialize)]
pub struct TestMail {
    to: String,
}

/// Sends a test email synchronously so the console can show the SMTP server's answer.
pub async fn test_settings(State(st): State<AppState>, headers: HeaderMap, Json(b): Json<TestMail>) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    let s = settings(&st).await?;
    let subject = format!("KoduDB test email for {}", st.project);
    let html = format!("<p>This is a test email from the <b>{}</b> project. SMTP works.</p>", html_escape(&st.project));
    let result = deliver(&s, &b.to, &subject, &html, "").await;
    log(&st, &b.to, "test", &subject, &result).await;
    result?;
    Ok(Json(json!({ "sent": true, "to": b.to })))
}

pub async fn list_templates(State(st): State<AppState>, headers: HeaderMap) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    let v: Value = sqlx::query_scalar("select coalesce(jsonb_agg(t order by t.kind), '[]') from auth.email_templates t").fetch_one(&st.pool).await?;
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct TemplateUpdate {
    subject: String,
    body: String,
}

pub async fn put_template(State(st): State<AppState>, headers: HeaderMap, Path(kind): Path<String>, Json(b): Json<TemplateUpdate>) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    if b.subject.trim().is_empty() || b.subject.len() > 200 || b.body.len() > 50_000 {
        return Err(err(StatusCode::BAD_REQUEST, "subject is required (max 200 chars); body max 50 KB"));
    }
    if !b.body.contains("{{link}}") {
        return Err(err(StatusCode::BAD_REQUEST, "the body must contain {{link}}"));
    }
    let v: Option<Value> = sqlx::query_scalar(
        "update auth.email_templates t set subject = $2, body = $3, updated_at = now() where kind = $1 returning to_jsonb(t)",
    )
    .bind(&kind)
    .bind(b.subject.trim())
    .bind(&b.body)
    .fetch_optional(&st.pool)
    .await?;
    v.map(Json).ok_or_else(|| err(StatusCode::NOT_FOUND, "template kinds are confirm and recovery"))
}

pub async fn list_emails(State(st): State<AppState>, headers: HeaderMap) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    let v: Value = sqlx::query_scalar(
        "select coalesce(jsonb_agg(e order by e.id desc), '[]') from (select * from auth.email_log order by id desc limit 200) e",
    )
    .fetch_one(&st.pool)
    .await?;
    Ok(Json(v))
}

#[cfg(test)]
mod tests {
    use super::{plain_text, render, safe_redirect};

    #[test]
    fn renders_and_escapes_placeholders() {
        let out = render("<a href=\"{{link}}\">{{email}}</a>", &[("link", "https://x/?a=1&b=2"), ("email", "<script>")]);
        assert_eq!(out, "<a href=\"https://x/?a=1&amp;b=2\">&lt;script&gt;</a>");
    }

    #[test]
    fn plain_text_keeps_the_link() {
        let t = plain_text("<p>Hi</p><p><a href=\"L\">Go</a></p>", "https://l");
        assert!(t.starts_with("Hi") && t.ends_with("https://l"), "{t}");
    }

    #[test]
    fn redirects_stay_on_the_site() {
        let site = "https://app.example.com";
        assert_eq!(safe_redirect(site, Some("https://app.example.com/welcome")), "https://app.example.com/welcome");
        assert_eq!(safe_redirect(site, Some("https://evil.example/steal")), site);
        assert_eq!(safe_redirect(site, None), site);
    }
}
