# Implementation Plan: KoduDB hardening and next features

## Overview

KoduDB runs (Postgres + Rust API + Next.js console, 77 tests green), but the code review found one
critical and four required issues, and the feature list still has five large items. This plan
fixes the security issues first (each as its own verifiable slice), then hardens performance and
correctness, then adds features as vertical slices (API + console + tests together).
Tasks are tracked in `tasks/todo.md`.

## Current state (verified 2026-10-29)

- `api/src/platform.rs:109`: every project pool connects with the root `postgres` credentials, so a
  project's secret key can run superuser SQL through `/meta/v1/query` (confirmed live:
  `is_superuser = on`, all databases listed).
- Project databases are created without an `OWNER`; `CONNECT` is never revoked from `PUBLIC`.
- `anon`, `authenticated`, `service_role` are cluster-wide roles granted to the bootstrap user
  (`api/sql/project.sql:6-14`); `ctx::scoped` relies on `SET LOCAL ROLE` to them.
- `Registry::load` holds the write lock across a pool connect (`platform.rs:96-109`).
- Verification commands: `podman build -t kodudb-api ./api` (Rust tests), `cd console && npm test` and
  `npx tsc --noEmit`, `node --test tests/api.test.mjs tests/platform.test.mjs` (stack running).

## Architecture decisions

- **One login role per project** (`p_<slug>_owner`, `NOSUPERUSER NOCREATEDB NOCREATEROLE`), password
  stored with `pgp_sym_encrypt(…, ENCRYPTION_KEY)` in `platform.projects`. The project database is
  owned by it and `CONNECT` is revoked from `PUBLIC`. The role is granted `anon`, `authenticated`,
  `service_role` so `SET LOCAL ROLE` keeps working. Superuser stays with the platform only
  (provisioning, event triggers, branching).
  *Why:* Postgres enforces the boundary instead of the API; SQL from the console keeps working for
  everything a database owner may do.
- **Event triggers stay superuser-owned** (created at bootstrap as `postgres`); they still fire for the
  owner role's DDL, so migrations keep recording.
- **Untrusted extensions** become a platform action (`POST /platform/v1/projects/{slug}/extensions`,
  root key) rather than raw SQL, because the owner role cannot `CREATE EXTENSION` for untrusted ones.
- **Existing projects are migrated at API start-up** by an idempotent `ensure_owner(slug)`, so no manual
  step and no data loss.
- **Default project is unchanged**: it is the platform database and its secret key is the root admin
  key by design; the README states this.
- Features are vertical slices (Rust endpoint + console page + e2e test) and each is optional to merge.

## Dependency graph

```
T1 owner role (provision + ensure_owner) ──┬── T2 isolation tests ── T3 extensions action
                                           └── (branching uses owner role) T4 branch reassign
T5 registry lock         (independent)
T6 login rate limits     (independent)
T7 realtime batching     (independent)
T8 upload atomicity      (independent)
T9 cleanups              (after T1–T8; touches the same files)
F-slices                 (after Checkpoint B; independent of each other)
```

## Task list

See `tasks/todo.md` for full acceptance criteria. Order:

### Phase A: Close the isolation hole (critical, sequential)
- T1 Per-project owner role on create, connect as it, migrate existing projects
- T2 Isolation tests: no superuser, no cross-database reach
- T3 Extensions through a platform action
- T4 Branches get their own owner role

### Checkpoint A
### Phase B: Hardening (independent, can run in parallel)
- T5 Connect project pools outside the registry write lock
- T6 Rate-limit sign-in (API) and console login
- T7 One RLS check per subscriber group in live events
- T8 Atomic file uploads
- T9 Review cleanups (catalog cache, secure cookie, dead code)

### Checkpoint B
### Phase C: Features (vertical slices, pick order with the user)
- F1 Email delivery + confirm sign-up + password reset (SMTP)
- F2 Email templates in the console
- F3 TOTP multi-factor sign-in
- F4 OAuth sign-in (GitHub first)
- F5 Scheduled backups + restore to a new project
- F6 Image transforms for files
- F7 Server-side functions (runtime choice is an open question)

### Checkpoint C (after each feature)

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Owner role lacks a privilege the API needs (auth/storage/history/kodudb schemas) and a feature breaks | High | T1 grants explicitly per schema + default privileges; the full e2e suite (66 tests) must stay green before T1 is done |
| `ensure_owner` on start-up half-applies on an existing project | High | Run it in one transaction per project inside the project DB; idempotent statements only; test by running start-up twice |
| `reassign owned` on branch clone misses objects owned by the parent role | Med | T4 asserts `select count(*) from pg_class where relowner = parent_role` is 0 in the branch |
| Console extension toggles fail for untrusted extensions after T1 | Med | T3 routes them through the platform action; trusted ones keep working as SQL |
| Rate limiting locks out a real user behind a shared IP | Low | Limit per IP and per email separately; 429 with Retry-After; in-memory, resets on restart |
| Feature scope creep (F-slices are each L) | Med | Each F is split into S/M sub-tasks before it starts; user picks order |

## Decisions (2026-10-29)

- Approved: build Phase A now, stop at Checkpoint A for review.
- Phase C order: F1+F2 email (confirm, reset, templates) → F3 TOTP MFA → F4 OAuth → F5 backups.
  F6 image transforms and F7 server-side functions stay in the backlog.

## Open questions
2. Rename the Postgres roles `anon` / `authenticated` / `service_role` to KoduDB names? It breaks every
   existing policy and is not needed for security; recommend **no**.
3. Email: plain SMTP settings per project (recommended) or a provider API (Resend/SES)?
4. OAuth providers beyond GitHub (Google, Microsoft)?
5. Backups: local volume only, or S3-compatible bucket as well?
6. Server-side functions runtime: Deno subprocess per project, or WASM (smaller, safer,
   less compatible)?
