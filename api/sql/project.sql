-- KoduDB project bootstrap: roles, auth, storage, realtime, history, connectors, schema versioning.
-- Runs once in every project database (idempotent).
create extension if not exists pgcrypto;

do $$ begin
  create role anon nologin noinherit;
  exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated nologin noinherit;
  exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role nologin noinherit bypassrls;
  exception when duplicate_object then null; end $$;
grant anon, authenticated, service_role to current_user;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- ---------- auth ----------
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  encrypted_password text not null,
  role text not null default 'authenticated',
  user_metadata jsonb not null default '{}',
  banned boolean not null default false,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists auth.audit_log (
  id bigserial primary key,
  user_id uuid,
  email text,
  action text not null,
  ip text,
  created_at timestamptz not null default now()
);

-- ---------- email: confirmation, recovery, settings, templates ----------
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'email_confirmed_at') then
    alter table auth.users add column email_confirmed_at timestamptz;
    -- Users that existed before confirmation could be required stay able to sign in.
    update auth.users set email_confirmed_at = created_at;
  end if;
end $$;

create table if not exists auth.settings (
  id int primary key default 1 check (id = 1),
  require_email_confirmation boolean not null default false,
  site_url text not null default 'http://localhost:3000',
  smtp_host text,
  smtp_port int not null default 587,
  smtp_user text,
  smtp_pass_enc bytea,
  smtp_from text,
  smtp_security text not null default 'starttls' check (smtp_security in ('starttls', 'tls', 'none')),
  updated_at timestamptz not null default now()
);
insert into auth.settings (id) values (1) on conflict do nothing;

create table if not exists auth.email_templates (
  kind text primary key,
  subject text not null,
  body text not null,
  updated_at timestamptz not null default now()
);
insert into auth.email_templates (kind, subject, body) values
  ('confirm', 'Confirm your email for {{project}}',
   '<p>Hi,</p><p>Confirm your email address to finish signing up for {{project}}.</p><p><a href="{{link}}">Confirm email</a></p><p>The link works once and expires in one hour. If you did not sign up, ignore this email.</p>'),
  ('recovery', 'Reset your {{project}} password',
   '<p>Hi,</p><p>Someone asked to reset the password for {{email}}.</p><p><a href="{{link}}">Choose a new password</a></p><p>The link works once and expires in one hour. If it was not you, ignore this email.</p>')
on conflict (kind) do nothing;
-- Older databases limited kinds to confirm and recovery.
alter table auth.email_templates drop constraint if exists email_templates_kind_check;
-- Notices: sent after the event, no link.
insert into auth.email_templates (kind, subject, body) values
  ('password_changed', 'Your {{project}} password was changed',
   '<p>Hello,</p><p>The password for {{email}} on {{project}} was just changed.</p><p>If it was you, no action is needed. If it was not, reset your password right away and contact the site owner.</p>'),
  ('mfa_enabled', 'Two-factor sign-in is on for your {{project}} account',
   '<p>Hello,</p><p>An authenticator was added to {{email}} on {{project}}. From now on, signing in also asks for a code from it.</p><p>If it was not you, contact the site owner.</p>'),
  ('mfa_disabled', 'Two-factor sign-in was removed from your {{project}} account',
   '<p>Hello,</p><p>An authenticator was removed from {{email}} on {{project}}. Signing in no longer asks for a code from it.</p><p>If it was not you, change your password and contact the site owner.</p>')
on conflict (kind) do nothing;

-- Single-use links: only a hash of the token is stored.
create table if not exists auth.one_time_tokens (
  token_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('confirm', 'recovery')),
  redirect_to text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists auth.email_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  to_email text not null,
  kind text not null,
  subject text,
  status text not null,
  error text
);

-- ---------- multi-factor sign-in (TOTP) ----------
create table if not exists auth.mfa_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  friendly_name text,
  secret_enc bytea not null,                -- base32 secret, pgp_sym_encrypt with the platform key
  status text not null default 'unverified' check (status in ('unverified', 'verified')),
  last_used_step bigint,                    -- a code's 30 s step can be used once (no replay)
  created_at timestamptz not null default now(),
  verified_at timestamptz
);
create index if not exists mfa_factors_user_idx on auth.mfa_factors (user_id);

-- ---------- OAuth sign-in (GitHub) ----------
-- Users who only sign in through a provider have no password.
alter table auth.users alter column encrypted_password drop not null;

-- One row per configured provider; `preset` picks the protocol and defaults (see api/src/oauth.rs).
create table if not exists auth.oauth_providers (
  provider text primary key,                -- slug used in /authorize?provider= and in auth.identities
  preset text,
  display_name text,
  enabled boolean not null default false,
  client_id text,
  client_secret_enc bytea,                  -- pgp_sym_encrypt with the platform key
  enterprise_url text,                      -- GitHub Enterprise Server; null means github.com
  issuer text,                              -- OpenID Connect issuer (discovery at /.well-known/openid-configuration)
  scopes text,                              -- null means the preset's scopes
  trust_email boolean not null default false, -- accept emails the provider does not mark as verified
  updated_at timestamptz not null default now()
);
alter table auth.oauth_providers drop constraint if exists oauth_providers_provider_check;
alter table auth.oauth_providers add column if not exists preset text;
alter table auth.oauth_providers add column if not exists display_name text;
alter table auth.oauth_providers add column if not exists issuer text;
alter table auth.oauth_providers add column if not exists scopes text;
alter table auth.oauth_providers add column if not exists trust_email boolean not null default false;
update auth.oauth_providers set preset = provider where preset is null;

-- One row per provider account linked to a user.
create table if not exists auth.identities (
  provider text not null,
  provider_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  identity_data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  last_sign_in_at timestamptz,
  primary key (provider, provider_id)
);
create index if not exists identities_user_idx on auth.identities (user_id);

-- Claims are set per request by the API with set_config('request.jwt.claims', ...).
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select auth.jwt() ->> 'role'
$$;
grant execute on all functions in schema auth to anon, authenticated, service_role;

-- ---------- storage ----------
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  public boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id) on delete cascade,
  name text not null,
  owner uuid references auth.users(id) on delete set null,
  size bigint not null default 0,
  mimetype text,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);
grant select on storage.buckets to anon, authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
grant all on all tables in schema storage to service_role;

-- Default storage rules: public buckets readable by all, owners manage their own files.
alter table storage.objects enable row level security;
drop policy if exists "public read" on storage.objects;
create policy "public read" on storage.objects for select
  using (exists (select 1 from storage.buckets b where b.id = bucket_id and b.public) or owner = auth.uid());
drop policy if exists "owner write" on storage.objects;
create policy "owner write" on storage.objects for insert to authenticated with check (owner = auth.uid());
drop policy if exists "owner update" on storage.objects;
create policy "owner update" on storage.objects for update to authenticated using (owner = auth.uid());
drop policy if exists "owner delete" on storage.objects;
create policy "owner delete" on storage.objects for delete to authenticated using (owner = auth.uid());

-- ---------- realtime ----------
create schema if not exists realtime;
create or replace function realtime.broadcast_change() returns trigger language plpgsql as $$
declare
  rec jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  payload text;
begin
  payload := jsonb_build_object('schema', tg_table_schema, 'table', tg_table_name,
    'type', tg_op, 'record', rec,
    'old_record', case when tg_op = 'UPDATE' then to_jsonb(old) end)::text;
  -- pg_notify caps payloads at 8000 bytes; send keys only for wide rows.
  if octet_length(payload) > 7900 then
    payload := jsonb_build_object('schema', tg_table_schema, 'table', tg_table_name,
      'type', tg_op, 'record', jsonb_build_object('id', rec -> 'id'), 'truncated', true)::text;
  end if;
  perform pg_notify('kodudb_realtime', payload);
  return null;
end $$;

create schema if not exists kodudb;

-- ---------- external database connectors (URL encrypted with pgp_sym_encrypt) ----------
create table if not exists kodudb.connections (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  kind text not null check (kind in ('postgres', 'mysql', 'mssql', 'mongodb')),
  url_encrypted bytea not null,
  host_hint text,
  created_at timestamptz not null default now()
);

-- ---------- data history: per-table row change log ----------
create schema if not exists history;
create table if not exists history.changes (
  id bigserial primary key,
  at timestamptz not null default now(),
  table_name text not null,
  op text not null,
  actor uuid,
  actor_role text,
  old_record jsonb,
  new_record jsonb
);
create index if not exists changes_table_at_idx on history.changes (table_name, at desc);

-- Enabled per table from the console with trigger "kodudb_history".
create or replace function history.capture() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into history.changes (table_name, op, actor, actor_role, old_record, new_record)
  values (tg_table_name, tg_op, auth.uid(), auth.role(),
          case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end);
  return null;
end $$;
grant execute on function history.capture() to anon, authenticated, service_role;

-- ---------- schema version tracking: every DDL statement becomes a numbered migration ----------
create schema if not exists kodudb_schema;
create table if not exists kodudb_schema.migrations (
  version bigserial primary key,
  at timestamptz not null default now(),
  tag text not null,
  object text,
  statement text not null,
  txid bigint not null,
  actor text not null default current_user,
  pushed_at timestamptz,
  git_sha text
);

-- One migration per submitted query: later commands of the same query append their tag/object.
create or replace function kodudb_schema.record(cmd text, obj text) returns void language plpgsql as $$
declare q text := current_query();
begin
  update kodudb_schema.migrations m
     set tag = case when cmd = any(string_to_array(m.tag, ', ')) then m.tag else m.tag || ', ' || cmd end,
         object = case when obj is null or obj = any(string_to_array(coalesce(m.object, ''), ', ')) then m.object
                       else concat_ws(', ', m.object, obj) end
   where m.txid = txid_current() and m.statement = q;
  if not found then
    insert into kodudb_schema.migrations (tag, object, statement, txid) values (cmd, obj, q, txid_current());
  end if;
end $$;

create or replace function kodudb_schema.capture_ddl() returns event_trigger language plpgsql as $$
declare r record;
begin
  for r in select * from pg_event_trigger_ddl_commands() loop
    continue when r.schema_name in ('kodudb_schema', 'kodudb', 'pg_temp');
    -- Sequences/indexes created implicitly (identity, serial, primary key) belong to their table's statement.
    continue when r.object_type in ('sequence', 'index') and current_query() !~* '\m(sequence|index)\M';
    perform kodudb_schema.record(r.command_tag, r.object_identity);
  end loop;
end $$;

create or replace function kodudb_schema.capture_drop() returns event_trigger language plpgsql as $$
declare r record;
begin
  for r in select * from pg_event_trigger_dropped_objects() where original loop
    continue when r.schema_name in ('kodudb_schema', 'kodudb', 'pg_temp');
    perform kodudb_schema.record(tg_tag, r.object_identity);
  end loop;
end $$;

drop event trigger if exists kodudb_capture_ddl;
create event trigger kodudb_capture_ddl on ddl_command_end execute function kodudb_schema.capture_ddl();
drop event trigger if exists kodudb_capture_drop;
create event trigger kodudb_capture_drop on sql_drop execute function kodudb_schema.capture_drop();
