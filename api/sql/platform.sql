-- KoduDB platform registry (lives in the root database next to the "default" project).
create schema if not exists platform;
create table if not exists platform.projects (
  slug text primary key check (slug ~ '^[a-z][a-z0-9-]{1,62}$'),
  name text not null,
  db_name text unique not null,
  jwt_secret_enc bytea,                 -- null for "default", which uses JWT_SECRET
  parent text references platform.projects(slug),
  git_branch text not null default 'main',
  github_repo text,
  github_token_enc bytea,
  github_api_url text,
  created_at timestamptz not null default now()
);
-- Only the platform (superuser) may connect here and to the maintenance database; project roles
-- connect to their own database alone.
do $$ begin
  execute format('revoke all on database %I from public', current_database());
  revoke all on database postgres from public;
end $$;

-- The login role the API uses for this project's database (never the superuser).
alter table platform.projects add column if not exists owner_role text;
alter table platform.projects add column if not exists owner_password_enc bytea;
alter table platform.projects add column if not exists storage_access_key text;
alter table platform.projects add column if not exists storage_secret_enc bytea;  -- S3 key of the project (see objects.rs)
-- Optional own S3-compatible provider of the project (see providers.rs); all null = the bundled RustFS.
alter table platform.projects add column if not exists storage_provider text;
alter table platform.projects add column if not exists storage_endpoint text;
alter table platform.projects add column if not exists storage_region text;
alter table platform.projects add column if not exists storage_bucket text;
alter table platform.projects add column if not exists storage_path_style boolean;
alter table platform.projects add column if not exists storage_custom_access text;
alter table platform.projects add column if not exists storage_custom_secret_enc bytea;

insert into platform.projects (slug, name, db_name) values ('default', 'Default project', current_database())
  on conflict (slug) do nothing;

create schema if not exists kodudb;
create table if not exists kodudb.request_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  project text not null default 'default',
  method text not null,
  path text not null,
  route text,
  status int not null,
  ms real not null,
  ip text
);
create index if not exists request_log_project_at_idx on kodudb.request_log (project, at desc);
