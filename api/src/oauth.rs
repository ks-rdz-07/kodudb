//! Sign-in with external identity providers: any OpenID Connect provider (Google, Apple, Microsoft,
//! Okta, Auth0, Clerk, Keycloak, Authentik, Zitadel, ...) through discovery, plus the OAuth 2.0-only
//! providers GitHub, Discord, Facebook and Bitbucket. The provider account is linked to the project
//! user with the same verified email, or a new user is created.
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Form, Json,
};
use base64::Engine;
use jsonwebtoken::{jwk::Jwk, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::{active_user, audit},
    ctx::{err, now, require_service, AppState, ClientIp, R},
    mail::{api_base, safe_redirect, session_redirect, settings, urlencode},
};

/// How long the browser has to come back from the provider.
const STATE_TTL: u64 = 600;
/// Discovery documents and signing keys are cached this long.
const CACHE_TTL: Duration = Duration::from_secs(600);

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Oidc,
    GitHub,
    Discord,
    Facebook,
    Bitbucket,
}

struct Preset {
    id: &'static str,
    name: &'static str,
    group: &'static str,
    kind: Kind,
    /// Default OpenID Connect issuer; None when each customer has their own.
    issuer: Option<&'static str>,
    issuer_hint: &'static str,
    scopes: &'static str,
    /// Apple returns the code with a POST when email or name is asked for.
    form_post: bool,
}

const OIDC_SCOPES: &str = "openid email profile";

macro_rules! oidc {
    ($id:expr, $name:expr, $group:expr, $issuer:expr, $hint:expr) => {
        Preset { id: $id, name: $name, group: $group, kind: Kind::Oidc, issuer: $issuer, issuer_hint: $hint, scopes: OIDC_SCOPES, form_post: false }
    };
}
macro_rules! oauth2 {
    ($id:expr, $name:expr, $kind:expr, $scopes:expr) => {
        Preset { id: $id, name: $name, group: "Social", kind: $kind, issuer: None, issuer_hint: "", scopes: $scopes, form_post: false }
    };
}

static PRESETS: &[Preset] = &[
    oidc!("google", "Google", "Social", Some("https://accounts.google.com"), ""),
    Preset { id: "apple", name: "Apple", group: "Social", kind: Kind::Oidc, issuer: Some("https://appleid.apple.com"), issuer_hint: "", scopes: "openid email name", form_post: true },
    oidc!("microsoft", "Microsoft", "Social", Some("https://login.microsoftonline.com/common/v2.0"), "https://login.microsoftonline.com/<tenant id>/v2.0 for one organization"),
    oauth2!("github", "GitHub", Kind::GitHub, "read:user user:email"),
    oidc!("gitlab", "GitLab", "Social", Some("https://gitlab.com"), "https://gitlab.example.com for a self-managed GitLab"),
    oauth2!("discord", "Discord", Kind::Discord, "identify email"),
    oauth2!("facebook", "Facebook", Kind::Facebook, "email public_profile"),
    oidc!("linkedin", "LinkedIn", "Social", Some("https://www.linkedin.com/oauth"), ""),
    oidc!("slack", "Slack", "Social", Some("https://slack.com"), ""),
    Preset { id: "twitch", name: "Twitch", group: "Social", kind: Kind::Oidc, issuer: Some("https://id.twitch.tv/oauth2"), issuer_hint: "", scopes: "openid user:read:email", form_post: false },
    oauth2!("bitbucket", "Bitbucket", Kind::Bitbucket, "account email"),
    oidc!("okta", "Okta", "Workforce and hosted identity", None, "https://your-org.okta.com/oauth2/default"),
    oidc!("auth0", "Auth0", "Workforce and hosted identity", None, "https://your-tenant.us.auth0.com/"),
    oidc!("clerk", "Clerk", "Workforce and hosted identity", None, "https://your-app.clerk.accounts.dev"),
    oidc!("cognito", "Amazon Cognito", "Workforce and hosted identity", None, "https://cognito-idp.<region>.amazonaws.com/<user pool id>"),
    oidc!("keycloak", "Keycloak", "Open source", None, "https://sso.example.com/realms/<realm>"),
    oidc!("authentik", "authentik", "Open source", None, "https://auth.example.com/application/o/<app slug>/"),
    oidc!("zitadel", "ZITADEL", "Open source", None, "https://<instance>.zitadel.cloud"),
    oidc!("authelia", "Authelia", "Open source", None, "https://auth.example.com"),
    oidc!("logto", "Logto", "Open source", None, "https://<tenant>.logto.app/oidc"),
    oidc!("casdoor", "Casdoor", "Open source", None, "https://door.example.com"),
    oidc!("ory", "Ory", "Open source", None, "https://<project>.projects.oryapis.com"),
    oidc!("dex", "Dex", "Open source", None, "https://dex.example.com"),
    oidc!("kanidm", "Kanidm", "Open source", None, "https://idm.example.com/oauth2/openid/<client id>"),
    oidc!("fusionauth", "FusionAuth", "Open source", None, "https://auth.example.com"),
    oidc!("oidc", "Other OpenID Connect", "Custom", None, "https://idp.example.com"),
];

fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

/// A configured provider, ready to use.
struct Provider {
    slug: String,
    preset: &'static Preset,
    client_id: String,
    client_secret: String,
    enterprise_url: Option<String>,
    issuer: Option<String>,
    scopes: String,
    trust_email: bool,
}

type Row = (String, Option<String>, Option<String>, bool, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, bool, Value);

async fn rows(st: &AppState, slug: Option<&str>) -> R<Vec<Row>> {
    Ok(sqlx::query_as(
        "select provider, preset, display_name, enabled, client_id,
                case when client_secret_enc is null then null else pgp_sym_decrypt(client_secret_enc, $2) end,
                enterprise_url, issuer, scopes, trust_email, to_jsonb(updated_at)
         from auth.oauth_providers where $1::text is null or provider = $1 order by provider",
    )
    .bind(slug)
    .bind(st.enc_key.as_str())
    .fetch_all(&st.pool)
    .await?)
}

/// The provider when it is enabled and has everything its protocol needs.
fn ready(r: &Row) -> Option<Provider> {
    let p = preset(r.1.as_deref()?)?;
    let filled = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
    let issuer = filled(&r.7);
    if !r.3 || (p.kind == Kind::Oidc && issuer.is_none()) {
        return None;
    }
    Some(Provider {
        slug: r.0.clone(),
        preset: p,
        client_id: filled(&r.4)?,
        client_secret: filled(&r.5)?,
        enterprise_url: filled(&r.6),
        issuer,
        scopes: filled(&r.8).unwrap_or_else(|| p.scopes.to_string()),
        trust_email: r.9,
    })
}

async fn provider(st: &AppState, slug: &str) -> R<Provider> {
    rows(st, Some(slug))
        .await?
        .first()
        .and_then(ready)
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, format!("{slug} sign-in is not enabled for this project")))
}

fn display_name(r: &Row) -> String {
    r.2.clone().filter(|s| !s.is_empty()).or_else(|| r.1.as_deref().and_then(preset).map(|p| p.name.to_string())).unwrap_or_else(|| r.0.clone())
}

// ---------- HTTP to providers ----------

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| reqwest::Client::builder().timeout(Duration::from_secs(15)).build().expect("http client"));
static CACHE: LazyLock<Mutex<HashMap<String, (Instant, Value)>>> = LazyLock::new(Default::default);

fn down(e: reqwest::Error) -> crate::ctx::ApiError {
    err(StatusCode::BAD_GATEWAY, format!("identity provider unreachable: {e}"))
}

async fn get_json(url: &str, fresh: bool) -> R<Value> {
    if !fresh {
        if let Some((at, v)) = CACHE.lock().unwrap().get(url) {
            if at.elapsed() < CACHE_TTL {
                return Ok(v.clone());
            }
        }
    }
    let res = HTTP.get(url).header("accept", "application/json").send().await.map_err(down)?;
    if !res.status().is_success() {
        return Err(err(StatusCode::BAD_GATEWAY, format!("{url} returned {}", res.status())));
    }
    let v: Value = res.json().await.map_err(down)?;
    CACHE.lock().unwrap().insert(url.to_string(), (Instant::now(), v.clone()));
    Ok(v)
}

/// The provider's OpenID configuration; its `issuer` must be the one configured.
async fn discover(issuer: &str) -> R<Value> {
    let base = issuer.trim_end_matches('/');
    let doc = get_json(&format!("{base}/.well-known/openid-configuration"), false).await?;
    let found = doc["issuer"].as_str().unwrap_or_default().trim_end_matches('/');
    if found != base && !found.contains("{tenantid}") {
        return Err(err(StatusCode::BAD_GATEWAY, format!("discovery issuer {found} does not match {base}")));
    }
    Ok(doc)
}

struct Endpoints {
    authorize: String,
    token: String,
    basic_auth: bool,
    doc: Option<Value>,
}

async fn endpoints(p: &Provider) -> R<Endpoints> {
    let gh = p.enterprise_url.as_deref().map(|u| u.trim_end_matches('/').to_string()).unwrap_or_else(|| "https://github.com".into());
    let fixed = |a: &str, t: &str, basic: bool| Ok(Endpoints { authorize: a.into(), token: t.into(), basic_auth: basic, doc: None });
    match p.preset.kind {
        Kind::Oidc => {
            let doc = discover(p.issuer.as_deref().unwrap_or_default()).await?;
            let methods = doc["token_endpoint_auth_methods_supported"].as_array();
            // client_secret_basic is the default when the provider does not say (OpenID Connect Discovery 3).
            let basic = methods.is_none_or(|m| m.iter().any(|x| x == "client_secret_basic"));
            Ok(Endpoints {
                authorize: doc["authorization_endpoint"].as_str().ok_or_else(|| err(StatusCode::BAD_GATEWAY, "no authorization_endpoint"))?.into(),
                token: doc["token_endpoint"].as_str().ok_or_else(|| err(StatusCode::BAD_GATEWAY, "no token_endpoint"))?.into(),
                basic_auth: basic,
                doc: Some(doc),
            })
        }
        Kind::GitHub => fixed(&format!("{gh}/login/oauth/authorize"), &format!("{gh}/login/oauth/access_token"), false),
        Kind::Discord => fixed("https://discord.com/oauth2/authorize", "https://discord.com/api/oauth2/token", false),
        Kind::Facebook => fixed("https://www.facebook.com/v19.0/dialog/oauth", "https://graph.facebook.com/v19.0/oauth/access_token", false),
        Kind::Bitbucket => fixed("https://bitbucket.org/site/oauth2/authorize", "https://bitbucket.org/site/oauth2/access_token", true),
    }
}

fn callback_url(st: &AppState) -> String {
    format!("{}/auth/v1/callback", api_base(st))
}

/// The state cookie holds `nonce.code_verifier`: it binds the callback to the browser that started
/// sign-in (login CSRF) and keeps the PKCE verifier out of URLs.
fn cookie_name(st: &AppState) -> String {
    format!("kodudb-oauth-{}", st.project)
}

// ---------- the flow ----------

#[derive(Deserialize)]
pub struct AuthorizeQuery {
    provider: String,
    redirect_to: Option<String>,
}

/// GET /auth/v1/authorize?provider=<slug>: sends the browser to the provider's consent page.
pub async fn authorize(State(st): State<AppState>, Query(q): Query<AuthorizeQuery>) -> R<Response> {
    let p = provider(&st, &q.provider).await?;
    let e = endpoints(&p).await?;
    let (nonce, verifier, challenge): (String, String, String) = sqlx::query_as(
        "select n, v, rtrim(translate(encode(digest(v, 'sha256'), 'base64'), '+/', '-_'), '=')
         from (select encode(gen_random_bytes(16), 'hex') n, encode(gen_random_bytes(32), 'hex') v) x",
    )
    .fetch_one(&st.pool)
    .await?;
    let t = now();
    let state = st.sign(&json!({
        "typ": "oauth_state", "provider": p.slug, "nonce": nonce, "redirect_to": q.redirect_to, "iat": t, "exp": t + STATE_TTL,
    }));
    let mut url = format!(
        "{}{}response_type=code&client_id={}&redirect_uri={}&scope={}&state={state}",
        e.authorize,
        if e.authorize.contains('?') { "&" } else { "?" },
        urlencode(&p.client_id),
        urlencode(&callback_url(&st)),
        urlencode(&p.scopes),
    );
    if p.preset.kind == Kind::Oidc {
        url += &format!("&nonce={nonce}&code_challenge={challenge}&code_challenge_method=S256");
        if p.preset.form_post {
            url += "&response_mode=form_post";
        }
    }
    // SameSite=None lets the cookie ride on form_post callbacks; that needs https (Secure).
    let attrs = if api_base(&st).starts_with("https://") { "SameSite=None; Secure" } else { "SameSite=Lax" };
    let cookie = format!("{}={nonce}.{verifier}; Path=/; HttpOnly; {attrs}; Max-Age={STATE_TTL}", cookie_name(&st));
    Ok(([(header::SET_COOKIE, cookie)], Redirect::to(&url)).into_response())
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// GET /auth/v1/callback: the provider sends the browser back here. Redirects to the site with a session.
pub async fn callback(State(st): State<AppState>, headers: HeaderMap, ClientIp(ip): ClientIp, Query(q): Query<CallbackQuery>) -> Response {
    complete(st, headers, ip, q).await
}

/// POST /auth/v1/callback: the same, for providers that answer with response_mode=form_post (Apple).
pub async fn callback_post(State(st): State<AppState>, headers: HeaderMap, ClientIp(ip): ClientIp, Form(q): Form<CallbackQuery>) -> Response {
    complete(st, headers, ip, q).await
}

async fn complete(st: AppState, headers: HeaderMap, ip: Option<String>, q: CallbackQuery) -> Response {
    let site = match settings(&st).await {
        Ok(s) => s.site_url,
        Err(e) => return e.into_response(),
    };
    let state = q.state.as_deref().and_then(|s| st.decode(s).ok()).filter(|c| c["typ"] == "oauth_state");
    let target = safe_redirect(&site, state.as_ref().and_then(|c| c["redirect_to"].as_str()));
    let clear = format!("{}=; Path=/; Max-Age=0", cookie_name(&st));
    let res = match finish(&st, &headers, &q, state.as_ref(), ip).await {
        Ok(user) => session_redirect(&st, &target, user, "oauth").await,
        Err(e) => Redirect::to(&format!("{target}#error={}", urlencode(&e.1))).into_response(),
    };
    ([(header::SET_COOKIE, clear)], res).into_response()
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
}

async fn finish(st: &AppState, headers: &HeaderMap, q: &CallbackQuery, state: Option<&Value>, ip: Option<String>) -> R<Value> {
    if let Some(e) = &q.error {
        return Err(err(StatusCode::BAD_REQUEST, q.error_description.clone().unwrap_or_else(|| e.clone())));
    }
    let state = state.ok_or_else(|| err(StatusCode::BAD_REQUEST, "sign-in expired or was not started here; try again"))?;
    let saved = cookie(headers, &cookie_name(st)).unwrap_or_default();
    let (nonce, verifier) = saved.split_once('.').unwrap_or_default();
    if nonce.is_empty() || Some(nonce) != state["nonce"].as_str() {
        return Err(err(StatusCode::BAD_REQUEST, "sign-in was started in another browser; try again"));
    }
    let p = provider(st, state["provider"].as_str().unwrap_or_default()).await?;
    let code = q.code.as_deref().ok_or_else(|| err(StatusCode::BAD_REQUEST, "missing code"))?;
    let e = endpoints(&p).await?;
    let tok = exchange(&p, &e, code, &callback_url(st), (p.preset.kind == Kind::Oidc).then_some(verifier)).await?;
    let profile = match &e.doc {
        Some(doc) => oidc_profile(&p, doc, &tok, nonce).await?,
        None => oauth2_profile(&p, tok["access_token"].as_str().unwrap_or_default()).await?,
    };
    let email = match (&profile.email, profile.verified || p.trust_email) {
        (Some(e), true) => e.to_lowercase(),
        (Some(_), false) => return Err(err(StatusCode::BAD_REQUEST, format!("{} has not verified this account's email address", p.preset.name))),
        (None, _) => return Err(err(StatusCode::BAD_REQUEST, format!("{} did not share a verified email address", p.preset.name))),
    };
    let user = link_or_create(st, &p.slug, &profile, &email).await?;
    audit(st, Some(&user), &email, &format!("login_{}", p.slug), ip).await;
    Ok(user)
}

async fn exchange(p: &Provider, e: &Endpoints, code: &str, redirect_uri: &str, verifier: Option<&str>) -> R<Value> {
    let mut form = vec![("grant_type", "authorization_code"), ("code", code), ("redirect_uri", redirect_uri)];
    if let Some(v) = verifier {
        form.push(("code_verifier", v));
    }
    let mut req = HTTP.post(&e.token).header("accept", "application/json");
    if e.basic_auth {
        // RFC 6749 2.3.1: id and secret are form-encoded before Basic encoding.
        req = req.basic_auth(urlencode(&p.client_id), Some(urlencode(&p.client_secret)));
    } else {
        form.push(("client_id", &p.client_id));
        form.push(("client_secret", &p.client_secret));
    }
    let tok: Value = req.form(&form).send().await.map_err(down)?.json().await.map_err(down)?;
    if tok["access_token"].is_string() {
        return Ok(tok);
    }
    let why = tok["error_description"].as_str().or(tok["error"].as_str()).or(tok["error"]["message"].as_str()).unwrap_or("no access token");
    Err(err(StatusCode::BAD_REQUEST, format!("{} refused the sign-in: {why}", p.preset.name)))
}

#[derive(Debug, PartialEq)]
struct Profile {
    id: String,
    email: Option<String>,
    verified: bool,
    data: Value,
}

fn truthy(v: &Value) -> bool {
    // Apple sends email_verified as the string "true".
    v == &Value::Bool(true) || v.as_str() == Some("true")
}

fn id_string(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string).or_else(|| v.as_i64().map(|i| i.to_string())).filter(|s| !s.is_empty())
}

/// Reads an ID token's claims without checking them, only to choose how to check them.
fn peek(jwt: &str) -> Value {
    jwt.split('.')
        .nth(1)
        .and_then(|p| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(p.trim_end_matches('=')).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}

async fn signing_key(doc: &Value, kid: Option<&str>, fresh: bool) -> R<Option<DecodingKey>> {
    let url = doc["jwks_uri"].as_str().ok_or_else(|| err(StatusCode::BAD_GATEWAY, "no jwks_uri"))?;
    let set = get_json(url, fresh).await?;
    let found = set["keys"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|k| serde_json::from_value::<Jwk>(k.clone()).ok())
        .find(|k| kid.is_none() || k.common.key_id.as_deref() == kid);
    found.map(|k| DecodingKey::from_jwk(&k).map_err(|e| err(StatusCode::BAD_GATEWAY, format!("provider signing key: {e}")))).transpose()
}

/// Checks the ID token's signature, issuer, audience, expiry and nonce.
async fn verify_id_token(p: &Provider, doc: &Value, token: &str, nonce: &str) -> R<Value> {
    let bad = |m: String| err(StatusCode::BAD_REQUEST, format!("ID token rejected: {m}"));
    let header = jsonwebtoken::decode_header(token).map_err(|e| bad(e.to_string()))?;
    // Microsoft's multi-tenant issuer is a template; the token's tenant fills it in.
    let issuer = doc["issuer"].as_str().unwrap_or_default().replace("{tenantid}", peek(token)["tid"].as_str().unwrap_or("-"));
    let mut v = Validation::new(header.alg);
    v.set_audience(&[&p.client_id]);
    v.set_issuer(&[issuer.as_str(), issuer.trim_end_matches('/')]);
    let symmetric = matches!(header.alg, Algorithm::HS256 | Algorithm::HS384 | Algorithm::HS512);
    let mut last = "signed with an unknown key".to_string();
    // Cached keys first; on an unknown key or a bad signature, fetch the provider's keys once more
    // (it may have rotated them).
    for fresh in [false, true] {
        let key = if symmetric { Some(DecodingKey::from_secret(p.client_secret.as_bytes())) } else { signing_key(doc, header.kid.as_deref(), fresh).await? };
        let Some(key) = key else { continue };
        match jsonwebtoken::decode::<Value>(token, &key, &v) {
            Ok(d) => return check_nonce(d.claims, nonce).map_err(bad),
            Err(e) if matches!(e.kind(), jsonwebtoken::errors::ErrorKind::InvalidSignature) && !symmetric => last = e.to_string(),
            Err(e) => return Err(bad(e.to_string())),
        }
    }
    Err(bad(last))
}

fn check_nonce(claims: Value, nonce: &str) -> Result<Value, String> {
    if claims["nonce"].as_str() != Some(nonce) {
        return Err("nonce does not match this sign-in".into());
    }
    Ok(claims)
}

async fn oidc_profile(p: &Provider, doc: &Value, tok: &Value, nonce: &str) -> R<Profile> {
    let mut claims = match tok["id_token"].as_str() {
        Some(t) => verify_id_token(p, doc, t, nonce).await?,
        None => json!({}),
    };
    if let Some(url) = doc["userinfo_endpoint"].as_str() {
        let info: Option<Value> = match HTTP.get(url).bearer_auth(tok["access_token"].as_str().unwrap_or_default()).send().await {
            Ok(r) if r.status().is_success() => r.json().await.ok(),
            _ => None,
        };
        // UserInfo only counts for the same subject as the ID token (OIDC Core 5.3.2).
        if let Some(info) = info.filter(|i| claims["sub"].is_null() || i["sub"] == claims["sub"]) {
            for (k, v) in info.as_object().into_iter().flatten() {
                claims[k] = v.clone();
            }
        }
    }
    map_oidc(&claims)
}

fn map_oidc(c: &Value) -> R<Profile> {
    let id = id_string(&c["sub"]).ok_or_else(|| err(StatusCode::BAD_GATEWAY, "provider returned no subject"))?;
    Ok(Profile {
        email: c["email"].as_str().map(str::to_string),
        verified: truthy(&c["email_verified"]),
        data: json!({
            "provider_id": id, "email": c["email"], "name": c["name"], "avatar_url": c["picture"],
            "user_name": c.get("preferred_username").or(c.get("nickname")).cloned().unwrap_or(Value::Null),
        }),
        id,
    })
}

async fn oauth2_profile(p: &Provider, access: &str) -> R<Profile> {
    let get = |url: String| async move {
        let r = HTTP.get(&url).bearer_auth(access).header("accept", "application/json").header("user-agent", "kodudb").send().await.map_err(down)?;
        r.json::<Value>().await.map_err(down)
    };
    let gh_api = p.enterprise_url.as_deref().map(|u| format!("{}/api/v3", u.trim_end_matches('/'))).unwrap_or_else(|| "https://api.github.com".into());
    let (user, emails) = match p.preset.kind {
        Kind::GitHub => (get(format!("{gh_api}/user")).await?, get(format!("{gh_api}/user/emails")).await?),
        Kind::Discord => (get("https://discord.com/api/users/@me".into()).await?, Value::Null),
        Kind::Facebook => (get("https://graph.facebook.com/v19.0/me?fields=id,name,email,picture".into()).await?, Value::Null),
        Kind::Bitbucket => (get("https://api.bitbucket.org/2.0/user".into()).await?, get("https://api.bitbucket.org/2.0/user/emails".into()).await?),
        Kind::Oidc => unreachable!("OpenID Connect providers use oidc_profile"),
    };
    map_oauth2(p.preset.kind, &user, &emails)
}

/// Turns an OAuth 2.0-only provider's user (and email list) into a profile.
fn map_oauth2(kind: Kind, u: &Value, emails: &Value) -> R<Profile> {
    let id = id_string(&u["id"]).or_else(|| id_string(&u["uuid"])).ok_or_else(|| err(StatusCode::BAD_GATEWAY, "provider returned no user id"))?;
    // From a list of addresses, the verified primary one, else any verified one.
    let pick = |list: Option<&Vec<Value>>, verified: &str, primary: &str| {
        let ok: Vec<&Value> = list.into_iter().flatten().filter(|e| e[verified] == true).collect();
        ok.iter().find(|e| e[primary] == true).or(ok.first()).and_then(|e| e["email"].as_str()).map(str::to_string)
    };
    let (email, verified, name, avatar, user_name) = match kind {
        Kind::GitHub => {
            let e = pick(emails.as_array(), "verified", "primary");
            (e.clone(), e.is_some(), u["name"].clone(), u["avatar_url"].clone(), u["login"].clone())
        }
        Kind::Bitbucket => {
            let e = pick(emails["values"].as_array(), "is_confirmed", "is_primary");
            (e.clone(), e.is_some(), u["display_name"].clone(), u["links"]["avatar"]["href"].clone(), u["username"].clone())
        }
        Kind::Discord => {
            let avatar = u["avatar"].as_str().map(|a| format!("https://cdn.discordapp.com/avatars/{id}/{a}.png"));
            (u["email"].as_str().map(str::to_string), u["verified"] == true, u["global_name"].clone(), json!(avatar), u["username"].clone())
        }
        // Facebook only returns an email address the person has confirmed.
        Kind::Facebook => (u["email"].as_str().map(str::to_string), u["email"].is_string(), u["name"].clone(), u["picture"]["data"]["url"].clone(), Value::Null),
        Kind::Oidc => unreachable!(),
    };
    Ok(Profile { data: json!({ "provider_id": id, "email": email, "name": name, "avatar_url": avatar, "user_name": user_name }), id, email, verified })
}

async fn link_or_create(st: &AppState, provider: &str, p: &Profile, email: &str) -> R<Value> {
    let linked: Option<String> = sqlx::query_scalar(
        "update auth.identities set identity_data = $3, last_sign_in_at = now() where provider = $1 and provider_id = $2 returning user_id::text",
    )
    .bind(provider)
    .bind(&p.id)
    .bind(&p.data)
    .fetch_optional(&st.pool)
    .await?;
    let user_id = match linked {
        Some(id) => id,
        None => {
            // A password set before the address was confirmed is not trusted: whoever set it may not own
            // the mailbox, so linking drops it (the owner can reset it later).
            let id: String = sqlx::query_scalar(
                "with existing as (
                   update auth.users set encrypted_password = case when email_confirmed_at is null then null else encrypted_password end,
                     email_confirmed_at = coalesce(email_confirmed_at, now())
                   where email = $1 returning id),
                 created as (
                   insert into auth.users (email, user_metadata, email_confirmed_at)
                   select $1, $2, now() where not exists (select 1 from existing) returning id)
                 select id::text from existing union all select id::text from created",
            )
            .bind(email)
            .bind(json!({ "user_name": p.data["user_name"], "name": p.data["name"], "avatar_url": p.data["avatar_url"], "provider": provider }))
            .fetch_one(&st.pool)
            .await?;
            sqlx::query("insert into auth.identities (provider, provider_id, user_id, identity_data, last_sign_in_at) values ($1, $2, $3::uuid, $4, now())")
                .bind(provider)
                .bind(&p.id)
                .bind(&id)
                .bind(&p.data)
                .execute(&st.pool)
                .await?;
            id
        }
    };
    let user = active_user(st, Some(&user_id)).await?;
    sqlx::query("update auth.users set last_sign_in_at = now() where id = $1::uuid").bind(&user_id).execute(&st.pool).await?;
    Ok(user)
}

// ---------- public list (for sign-in buttons) ----------

/// GET /auth/v1/providers: the providers people can sign in with, for drawing buttons.
pub async fn list_public(State(st): State<AppState>, headers: HeaderMap) -> R<Json<Value>> {
    st.claims(&headers, None)?;
    let list: Vec<Value> = rows(&st, None).await?.iter().filter(|r| ready(r).is_some()).map(|r| json!({ "provider": r.0, "name": display_name(r) })).collect();
    Ok(Json(json!(list)))
}

// ---------- admin endpoints (secret key) ----------

pub async fn list_presets(State(st): State<AppState>, headers: HeaderMap) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    Ok(Json(json!(PRESETS
        .iter()
        .map(|p| json!({
            "id": p.id, "name": p.name, "group": p.group, "protocol": if p.kind == Kind::Oidc { "oidc" } else { "oauth2" },
            "issuer": p.issuer, "issuer_hint": p.issuer_hint, "scopes": p.scopes, "enterprise_url": p.kind == Kind::GitHub,
        }))
        .collect::<Vec<_>>())))
}

pub async fn list_providers(State(st): State<AppState>, headers: HeaderMap) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    let list: Vec<Value> = rows(&st, None)
        .await?
        .iter()
        .map(|r| {
            let p = r.1.as_deref().and_then(preset);
            json!({
                "provider": r.0, "preset": r.1, "name": display_name(r), "display_name": r.2, "enabled": r.3, "ready": ready(r).is_some(),
                "protocol": p.map(|p| if p.kind == Kind::Oidc { "oidc" } else { "oauth2" }),
                "client_id": r.4, "client_secret_set": r.5.is_some(), "enterprise_url": r.6, "issuer": r.7, "scopes": r.8,
                "default_scopes": p.map(|p| p.scopes), "trust_email": r.9, "callback_url": callback_url(&st), "updated_at": r.10,
            })
        })
        .collect();
    Ok(Json(json!(list)))
}

#[derive(Deserialize)]
pub struct ProviderUpdate {
    /// Needed when adding a provider whose slug is not a preset id (for example `okta-staff`).
    preset: Option<String>,
    display_name: Option<String>,
    enabled: Option<bool>,
    client_id: Option<String>,
    /// Write-only; empty keeps the saved secret.
    client_secret: Option<String>,
    /// GitHub only; empty clears it (back to github.com).
    enterprise_url: Option<String>,
    /// OpenID Connect issuer; empty clears it.
    issuer: Option<String>,
    /// Space-separated; empty means the preset's scopes.
    scopes: Option<String>,
    trust_email: Option<bool>,
}

fn valid_slug(s: &str) -> bool {
    (2..=32).contains(&s.len()) && s.starts_with(|c: char| c.is_ascii_lowercase()) && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// PUT /auth/v1/admin/providers/{slug}: add or change a provider. Fields left out keep their value.
pub async fn put_provider(State(st): State<AppState>, headers: HeaderMap, Path(slug): Path<String>, Json(b): Json<ProviderUpdate>) -> R<Json<Value>> {
    require_service(&st.claims(&headers, None)?)?;
    if !valid_slug(&slug) {
        return Err(err(StatusCode::BAD_REQUEST, "provider id must be 2-32 lowercase letters, digits or dashes"));
    }
    for (name, url) in [("enterprise_url", &b.enterprise_url), ("issuer", &b.issuer)] {
        if url.as_deref().is_some_and(|u| !u.is_empty() && !(u.starts_with("http://") || u.starts_with("https://"))) {
            return Err(err(StatusCode::BAD_REQUEST, format!("{name} must be an http(s) URL")));
        }
    }
    let existing: Option<Option<String>> = sqlx::query_scalar("select preset from auth.oauth_providers where provider = $1").bind(&slug).fetch_optional(&st.pool).await?;
    let issuer = match &existing {
        Some(_) => b.issuer.clone(),
        None => {
            let id = b.preset.as_deref().unwrap_or(&slug);
            let p = preset(id).ok_or_else(|| err(StatusCode::BAD_REQUEST, format!("unknown preset {id}; see GET /auth/v1/admin/providers/presets")))?;
            b.issuer.clone().or(p.issuer.map(str::to_string))
        }
    };
    let preset_id = existing.flatten().or(b.preset.clone()).unwrap_or_else(|| slug.clone());
    sqlx::query(
        "insert into auth.oauth_providers as p (provider, preset, display_name, enabled, client_id, client_secret_enc, enterprise_url, issuer, scopes, trust_email)
         values ($1, $2, nullif($3, ''), coalesce($4, false), $5, pgp_sym_encrypt(nullif($6, ''), $11), nullif($7, ''), nullif($8, ''), nullif($9, ''), coalesce($10, false))
         on conflict (provider) do update set
           display_name = case when $3::text is null then p.display_name else nullif($3, '') end,
           enabled = coalesce($4, p.enabled),
           client_id = coalesce($5, p.client_id),
           client_secret_enc = coalesce(pgp_sym_encrypt(nullif($6, ''), $11), p.client_secret_enc),
           enterprise_url = case when $7::text is null then p.enterprise_url else nullif($7, '') end,
           issuer = case when $8::text is null then p.issuer else nullif($8, '') end,
           scopes = case when $9::text is null then p.scopes else nullif($9, '') end,
           trust_email = coalesce($10, p.trust_email),
           updated_at = now()",
    )
    .bind(&slug)
    .bind(&preset_id)
    .bind(b.display_name)
    .bind(b.enabled)
    .bind(b.client_id)
    .bind(b.client_secret)
    .bind(b.enterprise_url)
    .bind(issuer)
    .bind(b.scopes)
    .bind(b.trust_email)
    .bind(st.enc_key.as_str())
    .execute(&st.pool)
    .await?;
    list_providers(State(st), headers).await
}

/// DELETE /auth/v1/admin/providers/{slug}: remove the settings. Linked identities stay, so turning it
/// back on later signs the same people into the same users.
pub async fn delete_provider(State(st): State<AppState>, headers: HeaderMap, Path(slug): Path<String>) -> R<StatusCode> {
    require_service(&st.claims(&headers, None)?)?;
    let n = sqlx::query("delete from auth.oauth_providers where provider = $1").bind(&slug).execute(&st.pool).await?.rows_affected();
    if n == 0 { Err(err(StatusCode::NOT_FOUND, "provider not found")) } else { Ok(StatusCode::NO_CONTENT) }
}

#[cfg(test)]
mod tests {
    use axum::http::{header, HeaderMap, HeaderValue};
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_the_state_cookie() {
        let mut h = HeaderMap::new();
        h.append(header::COOKIE, HeaderValue::from_static("a=1; kodudb-oauth-x=abc.def; b=2"));
        assert_eq!(cookie(&h, "kodudb-oauth-x").as_deref(), Some("abc.def"));
        assert_eq!(cookie(&h, "kodudb-oauth"), None);
    }

    #[test]
    fn presets_are_unique_and_valid_ids() {
        let mut ids: Vec<_> = PRESETS.iter().map(|p| p.id).collect();
        assert!(ids.iter().all(|id| valid_slug(id)));
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), PRESETS.len());
    }

    #[test]
    fn maps_discord_facebook_and_bitbucket() {
        let d = map_oauth2(Kind::Discord, &json!({ "id": "80351110224678912", "username": "octo", "email": "a@example.com", "verified": true, "avatar": "abc" }), &json!(null)).unwrap();
        assert_eq!((d.id.as_str(), d.email.as_deref(), d.verified), ("80351110224678912", Some("a@example.com"), true));
        assert_eq!(d.data["avatar_url"], "https://cdn.discordapp.com/avatars/80351110224678912/abc.png");
        let unverified = map_oauth2(Kind::Discord, &json!({ "id": "1", "email": "a@example.com", "verified": false }), &json!(null)).unwrap();
        assert!(!unverified.verified);
        let f = map_oauth2(Kind::Facebook, &json!({ "id": "10158", "email": "b@example.com", "picture": { "data": { "url": "https://x/p.jpg" } } }), &json!(null)).unwrap();
        assert!(f.verified && f.data["avatar_url"] == "https://x/p.jpg");
        let b = map_oauth2(
            Kind::Bitbucket,
            &json!({ "uuid": "{6a8b}", "username": "octo" }),
            &json!({ "values": [{ "email": "old@example.com", "is_confirmed": true, "is_primary": false }, { "email": "c@example.com", "is_confirmed": true, "is_primary": true }] }),
        )
        .unwrap();
        assert_eq!((b.id.as_str(), b.email.as_deref(), b.verified), ("{6a8b}", Some("c@example.com"), true));
    }

    #[test]
    fn oidc_email_verified_accepts_apples_string() {
        assert!(map_oidc(&json!({ "sub": "001", "email": "a@example.com", "email_verified": "true" })).unwrap().verified);
        assert!(!map_oidc(&json!({ "sub": "001", "email": "a@example.com" })).unwrap().verified);
        assert!(map_oidc(&json!({ "email": "a@example.com" })).is_err());
    }
}
