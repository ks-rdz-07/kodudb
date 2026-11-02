//! Per-project settings, stored as JSON in platform.projects.settings and mirrored in memory (AppState.settings)
//! so request paths read them without a query. Changes through /platform/v1/projects/{slug}/settings.
use std::{
    sync::{Arc, RwLock},
    time::Duration,
};

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::{postgres::PgPoolOptions, PgPool};

use crate::ctx::{err, R};

pub type Handle = Arc<RwLock<Settings>>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Close idle database sessions after `idle_minutes` (idle_session_timeout, idle_in_transaction_session_timeout and the pool's idle timeout).
    pub idle_close: bool,
    pub idle_minutes: i32,
    /// Cancel statements of REST, RPC and storage requests that run longer than `statement_seconds`.
    pub statement_timeout: bool,
    pub statement_seconds: i32,
    pub allow_signups: bool,
    pub request_logging: bool,
    pub log_retention_days: i32,
    pub realtime_enabled: bool,
    pub upload_limit: bool,
    pub upload_mb: i32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            idle_close: false,
            idle_minutes: 15,
            statement_timeout: false,
            statement_seconds: 30,
            allow_signups: true,
            request_logging: true,
            log_retention_days: 14,
            realtime_enabled: true,
            upload_limit: false,
            upload_mb: 50,
        }
    }
}

impl Settings {
    pub fn validate(&self) -> R<()> {
        let check = |name: &str, v: i32, max: i32| {
            if (1..=max).contains(&v) { Ok(()) } else { Err(err(StatusCode::BAD_REQUEST, format!("{name} must be between 1 and {max}"))) }
        };
        check("idle_minutes", self.idle_minutes, 1440)?;
        check("statement_seconds", self.statement_seconds, 3600)?;
        check("log_retention_days", self.log_retention_days, 365)?;
        check("upload_mb", self.upload_mb, 1024)
    }

    /// Idle timeout in milliseconds for Postgres sessions, when switched on.
    pub fn idle_ms(&self) -> Option<i64> {
        self.idle_close.then(|| self.idle_minutes as i64 * 60_000)
    }

    /// How long the API's own pool keeps an idle connection.
    pub fn pool_idle(&self) -> Duration {
        Duration::from_secs(if self.idle_close { self.idle_minutes as u64 * 60 } else { 300 })
    }

    pub fn same_idle(&self, o: &Settings) -> bool {
        self.idle_close == o.idle_close && self.idle_minutes == o.idle_minutes
    }
}

pub async fn load(platform: &PgPool, slug: &str) -> Settings {
    let v: Result<Option<serde_json::Value>, _> = sqlx::query_scalar("select settings from platform.projects where slug = $1").bind(slug).fetch_optional(platform).await;
    match v {
        Ok(Some(v)) => serde_json::from_value(v).unwrap_or_default(),
        Ok(None) => Settings::default(),
        Err(e) => {
            eprintln!("settings of {slug} not loaded, using defaults: {e}");
            Settings::default()
        }
    }
}

/// Every new connection of the pool gets the idle timeouts. Set per session (not with ALTER ROLE/DATABASE) so
/// the realtime LISTEN connection, which is idle by design, is never cut.
pub fn on_connect(opts: PgPoolOptions, h: Handle) -> PgPoolOptions {
    opts.after_connect(move |conn, _| {
        let ms = h.read().unwrap().idle_ms();
        Box::pin(async move {
            if let Some(ms) = ms {
                sqlx::query("select set_config('idle_session_timeout', $1, false), set_config('idle_in_transaction_session_timeout', $1, false)")
                    .bind(ms.to_string())
                    .execute(&mut *conn)
                    .await?;
            }
            Ok(())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::Settings;

    #[test]
    fn ranges_are_enforced() {
        assert!(Settings::default().validate().is_ok());
        let bad = |f: fn(&mut Settings)| {
            let mut s = Settings::default();
            f(&mut s);
            s.validate().is_err()
        };
        assert!(bad(|s| s.idle_minutes = 0));
        assert!(bad(|s| s.idle_minutes = 1441));
        assert!(bad(|s| s.statement_seconds = 3601));
        assert!(bad(|s| s.log_retention_days = 366));
        assert!(bad(|s| s.upload_mb = 0));
        let mut ok = Settings::default();
        (ok.idle_minutes, ok.statement_seconds, ok.log_retention_days) = (1440, 1, 365);
        assert!(ok.validate().is_ok());
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let s: Settings = serde_json::from_value(serde_json::json!({ "allow_signups": false })).unwrap();
        assert!(!s.allow_signups && s.request_logging && s.idle_ms().is_none());
        assert_eq!(Settings { idle_close: true, idle_minutes: 2, ..Default::default() }.idle_ms(), Some(120_000));
    }
}
