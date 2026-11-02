//! Direct database connection for a project: a login role of its own, limited to the project's database.
//! The role is a member of the project's owner role and starts every session as it (`set role`), so
//! tables it creates belong to the owner like the API's own. It is never the superuser.
use axum::http::StatusCode;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::ctx::{err, R};

pub fn role_name(slug: &str) -> String {
    crate::owner::pg_name("p_", slug, "_direct")
}

/// Percent-encodes everything except unreserved characters, so any password is safe inside a URI.
fn enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

pub fn uri(user: &str, password: &str, host: &str, port: u16, db: &str, sslmode: &str) -> String {
    let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_string() };
    format!("postgresql://{}:{}@{host}:{port}/{}?sslmode={sslmode}", enc(user), enc(password), enc(db))
}

/// Public address and SSL mode from the environment; `None` host means the database is not exposed.
fn public_endpoint() -> R<(Option<String>, u16, String)> {
    let get = |k: &str| std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let host = get("DB_PUBLIC_HOST");
    let port = match get("DB_PUBLIC_PORT") {
        Some(p) => p.parse().map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "DB_PUBLIC_PORT must be a port number"))?,
        None => 5432,
    };
    let ssl = get("DB_PUBLIC_SSLMODE").unwrap_or_else(|| "prefer".into());
    if !["disable", "prefer", "require", "verify-ca", "verify-full"].contains(&ssl.as_str()) {
        return Err(err(StatusCode::INTERNAL_SERVER_ERROR, "DB_PUBLIC_SSLMODE must be disable, prefer, require, verify-ca or verify-full"));
    }
    if host.as_deref().is_some_and(|h| h.contains(|c: char| c.is_whitespace() || "/@?#".contains(c))) {
        return Err(err(StatusCode::INTERNAL_SERVER_ERROR, "DB_PUBLIC_HOST must be a host name or address"));
    }
    Ok((host, port, ssl))
}

/// Connection details, creating the role on first use. `rotate` issues a new password and ends the
/// role's open sessions. The default project shares the platform database, so it has no direct role.
pub async fn details(platform: &PgPool, enc_key: &str, slug: &str, db: &str, rotate: bool) -> R<Value> {
    if slug == "default" {
        return Err(err(StatusCode::BAD_REQUEST, "the default project shares the platform database and has no direct connection; create a project first"));
    }
    let (host, port, ssl) = public_endpoint()?;
    let role = role_name(slug);
    let stored: Option<String> = if rotate {
        None
    } else {
        sqlx::query_scalar("select pgp_sym_decrypt(direct_password_enc, $2) from platform.projects where slug = $1 and direct_role = $3")
            .bind(slug)
            .bind(enc_key)
            .bind(&role)
            .fetch_optional(platform)
            .await?
            .flatten()
    };
    let password = match stored {
        Some(p) => p,
        None => {
            let password: String = sqlx::query_scalar("select encode(gen_random_bytes(24), 'hex')").fetch_one(platform).await?;
            let exists: bool = sqlx::query_scalar("select exists(select 1 from pg_roles where rolname = $1)").bind(&role).fetch_one(platform).await?;
            let owner = crate::owner::role_name(slug);
            // Names come from a validated slug and the password is hex, so inlining them in DDL is safe.
            let verb = if exists { "alter" } else { "create" };
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                "{verb} role \"{role}\" login password '{password}' nosuperuser nocreatedb nocreaterole inherit;
                 grant \"{owner}\" to \"{role}\";
                 alter role \"{role}\" set role = \"{owner}\";
                 grant connect on database \"{db}\" to \"{role}\""
            )))
            .execute(platform)
            .await?;
            if rotate {
                sqlx::query("select pg_terminate_backend(pid) from pg_stat_activity where usename = $1").bind(&role).execute(platform).await?;
            }
            sqlx::query(
                "update platform.projects set direct_role = $2, direct_password_enc = pgp_sym_encrypt($3, $4, 'cipher-algo=aes256, s2k-digest-algo=sha256') where slug = $1",
            )
            .bind(slug)
            .bind(&role)
            .bind(&password)
            .bind(enc_key)
            .execute(platform)
            .await?;
            password
        }
    };
    Ok(json!({
        "configured": host.is_some(),
        "host": host,
        "port": port,
        "database": db,
        "user": role,
        "password": password,
        "sslmode": ssl,
        "uri": uri(&role, &password, host.as_deref().unwrap_or("your-db-host"), port, db, &ssl),
    }))
}

pub async fn drop_role(platform: &PgPool, slug: &str) {
    let role = role_name(slug);
    if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(format!("drop role if exists \"{role}\""))).execute(platform).await {
        eprintln!("could not drop role {role}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::{enc, role_name, uri};

    #[test]
    fn enc_escapes_uri_delimiters() {
        assert_eq!(enc("a@b:c/d?e#f%g"), "a%40b%3Ac%2Fd%3Fe%23f%25g");
        assert_eq!(enc("a b+c"), "a%20b%2Bc");
        assert_eq!(enc("Az09-._~"), "Az09-._~");
    }

    #[test]
    fn uri_layout_and_encoding() {
        // Every part goes through enc(); user and database names stand in for any value with delimiters.
        assert_eq!(uri("p_shop_direct", "", "db.example.com", 5432, "p_shop", "require"), "postgresql://p_shop_direct:@db.example.com:5432/p_shop?sslmode=require");
        assert_eq!(uri("u@x", "", "h", 1, "d/b", "prefer"), "postgresql://u%40x:@h:1/d%2Fb?sslmode=prefer");
        assert!(uri("u", "", "::1", 5432, "d", "prefer").contains("@[::1]:5432/"));
    }

    #[test]
    fn role_fits_identifier() {
        assert_eq!(role_name("demo-store"), "p_demo_store_direct");
        assert!(role_name(&"a".repeat(40)).len() <= 63);
    }
}
