//! Per-project database owner role. The API connects to a project's database as this role, never as
//! the superuser, so a project's keys cannot reach other databases or the server itself.
use sqlx::{
    postgres::{PgConnectOptions, PgPoolOptions},
    PgPool,
};

use crate::ctx::R;

/// Postgres identifiers are capped at 63 bytes: long names keep a readable prefix plus a hash.
pub fn pg_name(prefix: &str, slug: &str, suffix: &str) -> String {
    let body = slug.replace('-', "_");
    let base = format!("{prefix}{body}{suffix}");
    if base.len() <= 63 {
        return base;
    }
    let hash = slug.bytes().fold(0x811c_9dc5_u32, |h, b| (h ^ b as u32).wrapping_mul(0x0100_0193));
    let keep = 63 - prefix.len() - suffix.len() - 9;
    format!("{prefix}{}_{hash:08x}{suffix}", &body[..keep])
}

pub fn role_name(slug: &str) -> String {
    pg_name("p_", slug, "_owner")
}

const BOOT_SCHEMAS: &str = "auth, storage, realtime, history, kodudb, kodudb_schema";

/// Run inside the project database as superuser. `{role}` is the owner. Hands over every object in
/// `public` that someone else owns (the bootstrap superuser, or the parent project's owner in a branch),
/// gives the role what the API needs in the bootstrap schemas, and makes its future tables reachable by
/// the request roles.
const OWNER_SQL: &str = r#"
-- Housekeeping, not the user's schema: keep the migration recorder (an event trigger) out of it.
set session_replication_role = replica;
do $$
declare r record; target text := '{role}';
begin
  for r in
    select c.relkind, format('%I.%I', n.nspname, c.relname) obj
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      and pg_get_userbyid(c.relowner) <> target
      and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype in ('e', 'a', 'i'))
  loop
    execute format('alter %s %s owner to %I',
      case r.relkind when 'v' then 'view' when 'm' then 'materialized view' when 'f' then 'foreign table' when 'S' then 'sequence' else 'table' end,
      r.obj, target);
  end loop;

  for r in
    select p.oid::regprocedure::text fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and pg_get_userbyid(p.proowner) <> target
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter routine %s owner to %I', r.fn, target);
  end loop;

  for r in
    select format('%I.%I', n.nspname, t.typname) typ
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype in ('e', 'd', 'c') and pg_get_userbyid(t.typowner) <> target
      and not exists (select 1 from pg_class c where c.reltype = t.oid)
      and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype in ('e', 'i'))
  loop
    execute format('alter type %s owner to %I', r.typ, target);
  end loop;

  -- A branch inherits its parent owner's default privileges; drop them so the parent role is not referenced.
  for r in
    select distinct pg_get_userbyid(defaclrole) rol from pg_default_acl
    where pg_get_userbyid(defaclrole) not in (target, current_user)
  loop
    execute format('alter default privileges for role %I in schema public revoke all on tables from anon, authenticated, service_role', r.rol);
    execute format('alter default privileges for role %I in schema public revoke all on sequences from anon, authenticated, service_role', r.rol);
    execute format('alter default privileges for role %I in schema public revoke all on functions from anon, authenticated, service_role', r.rol);
  end loop;
end $$;

grant usage on schema {schemas} to "{role}";
grant all on all tables in schema {schemas} to "{role}";
grant all on all sequences in schema {schemas} to "{role}";
grant execute on all functions in schema {schemas} to "{role}";
alter default privileges for role "{role}" in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role "{role}" in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role "{role}" in schema public grant execute on functions to anon, authenticated, service_role;
"#;

/// Connection options for the project database as its owner.
pub async fn owner_options(platform: &PgPool, opts: &PgConnectOptions, enc_key: &str, slug: &str, db: &str) -> R<PgConnectOptions> {
    let (role, password): (String, String) =
        sqlx::query_as("select owner_role, pgp_sym_decrypt(owner_password_enc, $2) from platform.projects where slug = $1")
            .bind(slug)
            .bind(enc_key)
            .fetch_one(platform)
            .await?;
    Ok(opts.clone().database(db).username(&role).password(&password))
}

/// Creates the owner role if missing, gives it the database and the privileges the API needs. Idempotent:
/// it runs on every API start for every project, and again after a branch is cloned.
pub async fn ensure_owner(platform: &PgPool, opts: &PgConnectOptions, enc_key: &str, slug: &str, db: &str) -> R<()> {
    let role = role_name(slug);
    let has_password: bool =
        sqlx::query_scalar("select owner_password_enc is not null and owner_role = $2 from platform.projects where slug = $1")
            .bind(slug)
            .bind(&role)
            .fetch_one(platform)
            .await?;
    if !has_password {
        let password: String = sqlx::query_scalar("select encode(gen_random_bytes(24), 'hex')").fetch_one(platform).await?;
        let exists: bool = sqlx::query_scalar("select exists(select 1 from pg_roles where rolname = $1)").bind(&role).fetch_one(platform).await?;
        // The role name comes from a validated slug and the password is hex, so both are safe to inline in DDL.
        let verb = if exists { "alter" } else { "create" };
        sqlx::query(sqlx::AssertSqlSafe(format!("{verb} role \"{role}\" login password '{password}' nosuperuser nocreatedb nocreaterole noinherit")))
            .execute(platform)
            .await?;
        sqlx::query("update platform.projects set owner_role = $2, owner_password_enc = pgp_sym_encrypt($3, $4, 'cipher-algo=aes256, s2k-digest-algo=sha256') where slug = $1")
            .bind(slug)
            .bind(&role)
            .bind(&password)
            .bind(enc_key)
            .execute(platform)
            .await?;
    }
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "grant anon, authenticated, service_role to \"{role}\";
         alter database \"{db}\" owner to \"{role}\";
         revoke all on database \"{db}\" from public;
         grant connect, temporary on database \"{db}\" to \"{role}\";"
    )))
    .execute(platform)
    .await?;

    let pool = PgPoolOptions::new().max_connections(1).connect_with(opts.clone().database(db)).await?;
    let sql = OWNER_SQL.replace("{role}", &role).replace("{schemas}", BOOT_SCHEMAS);
    let applied = sqlx::raw_sql(sqlx::AssertSqlSafe(sql.as_str())).execute(&pool).await;
    pool.close().await;
    applied?;
    Ok(())
}

/// Removes the owner role after its database is gone. Failure is logged, not fatal: a leftover
/// role without a database can do nothing.
pub async fn drop_owner(platform: &PgPool, slug: &str) {
    let role = role_name(slug);
    if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(format!("drop role if exists \"{role}\""))).execute(platform).await {
        eprintln!("could not drop role {role}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::{pg_name, role_name};

    #[test]
    fn names_fit_postgres_identifiers() {
        assert_eq!(role_name("demo-store"), "p_demo_store_owner");
        let long = "a".repeat(40) + "-" + &"b".repeat(40);
        let n = role_name(&long);
        assert!(n.len() <= 63, "{n}");
        assert_ne!(n, role_name(&("a".repeat(40) + "-" + &"b".repeat(39) + "c")));
        assert_eq!(pg_name("p_", "shop", ""), "p_shop");
    }
}
