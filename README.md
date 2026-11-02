<p align="center">
  <img src="docs/images/hero.jpg" alt="KoduDB: your data, your backend" width="100%">
</p>

<p align="center">
  <img alt="Status: preview" src="https://img.shields.io/badge/status-preview-ffc53d?style=for-the-badge">
  <a href="../../releases"><img alt="Version 0.1.1" src="https://img.shields.io/badge/version-0.1.1-e5484d?style=for-the-badge"></a>
  <img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-30a46c?style=for-the-badge">
  <img alt="Docker | Podman | Windows Server" src="https://img.shields.io/badge/runs%20on-Docker%20%7C%20Podman%20%7C%20Windows-3e63dd?style=for-the-badge">
  <br>
  <a href="../../actions/workflows/ci.yml"><img alt="CI" src="../../actions/workflows/ci.yml/badge.svg"></a>
  <a href="../../actions/workflows/security.yml"><img alt="Security" src="../../actions/workflows/security.yml/badge.svg"></a>
  <img alt="Postgres 15+" src="https://img.shields.io/badge/Postgres-15%2B-336791">
  <img alt="API: Rust" src="https://img.shields.io/badge/API-Rust%20(axum)-b7410e">
  <img alt="Console: Next.js" src="https://img.shields.io/badge/console-Next.js-000000">
</p>

# KoduDB

**An open backend platform on Postgres, running on infrastructure you control.**
Identity, an auto-generated REST API, files, live events, metrics, a change log, external data sources,
multiple projects with branching, and migrations synced to GitHub. Three containers: Postgres, a Rust API
(axum + sqlx) and a Next.js console.

> [!IMPORTANT]
> **Preview.** KoduDB is young. Read [Known limits](#known-limits) before you put production data in it, and
> please [report problems](../../issues/new/choose).

<p align="center">
  <img src="docs/media/preview.gif" alt="Product tour" width="720"><br>
  <sub>Full video: <a href="docs/media/kodudb-tour.mp4">1920×1080 MP4</a></sub>
</p>

## Quick start

```sh
node scripts/gen-env.mjs                 # creates .env and prints the console sign-in
docker compose up -d --build             # or: podman compose -f compose.yml up -d --build
# console: http://localhost:3100    API: http://localhost:8787
```

More options (Podman, PM2, Windows Server, Railpack, Nixpacks, buildpacks) are in [Deploy anywhere](#deploy-anywhere).

## Why KoduDB

- **Self-hosted and open source.** Apache-2.0, no telemetry, runs on your own servers or any container platform.
- **PostgreSQL at the core.** Every project is a real Postgres database you can connect to with any tool.
- **Authentication built in.** Email and password, two-factor (TOTP), and sign-in with Google, GitHub, Microsoft, Apple, Okta, Keycloak or any OpenID Connect provider.
- **Instant REST API.** Generated from your schema, with filtering, paging, upserts and an OpenAPI 3.1 reference.
- **Row-level security everywhere.** The same policies protect REST requests, file downloads and realtime events.
- **Files and realtime.** Buckets with public and private files, and a WebSocket change feed per table.
- **Branching and migrations.** Branch a project for a Git branch; every schema change becomes a migration you can push to GitHub.
- **Observability.** Request metrics, latency percentiles, searchable logs and a per-table change log.

<details>
<summary><b>Contents</b></summary>

- [Quick start](#quick-start) · [Why KoduDB](#why-kodudb) · [Run it](#run-it-docker-or-podman-compose) · [Deploy anywhere](#deploy-anywhere)
- [Keys](#keys) · [Isolation](#isolation) · [Limits and abuse protection](#limits-and-abuse-protection) · [Features](#features)
- [Tests](#tests) · [Screenshots](#screenshots) · [Known limits](#known-limits)
- [Contributing](#contributing) · [Media kit](#media-kit) · [License](#license)
</details>

<table>
  <tr>
    <td width="50%"><img src="docs/images/feature-build.jpg" alt="Build"></td>
    <td width="50%"><img src="docs/images/feature-secure.jpg" alt="Secure"></td>
  </tr>
  <tr>
    <td><b>Build.</b> Each project is its own Postgres database. Model data in the explorer or the query console
      (with SQL IntelliSense); the REST API and its OpenAPI reference follow the live schema.</td>
    <td><b>Secure.</b> Email and password, two-factor, and sign-in providers (any OpenID Connect provider plus
      common OAuth presets). Row security policies apply to every request, file and live event.</td>
  </tr>
  <tr>
    <td><img src="docs/images/feature-ship.jpg" alt="Ship"></td>
    <td><img src="docs/images/feature-observe.jpg" alt="Observe"></td>
  </tr>
  <tr>
    <td><b>Ship.</b> Every create, alter and drop is recorded as a numbered migration. Branch a project for a Git
      branch, push migrations to GitHub and open pull requests.</td>
    <td><b>Observe.</b> Request rate, latency percentiles, errors, busiest routes, searchable request logs with a
      live tail, and a per-table change log of who changed which row.</td>
  </tr>
</table>

<p align="center"><img src="docs/images/themes.jpg" alt="Light and dark themes" width="85%"></p>

## Run it (Docker or Podman Compose)

```sh
node scripts/gen-env.mjs              # creates .env or adds what is missing; prints the console sign-in
podman compose -f compose.yml up -d --build      # or: docker compose up -d --build
node scripts/seed-demo.mjs            # optional: a "Demo Store" project with sample data
```

- Console: http://localhost:3100. Sign in with `DASHBOARD_USERNAME` (default `admin`) and `DASHBOARD_PASSWORD` from `.env`.
- API: http://localhost:8787 (default project), `http://localhost:8787/p/<project>` for others
- Postgres: `127.0.0.1:54329`

## Deploy anywhere

Dockerfile, Docker Compose, Railpack, Nixpacks, Heroku and Paketo buildpacks, PM2 and Windows Server are
covered in [docs/deploy.md](docs/deploy.md). The API needs only `DATABASE_URL` and the console only
`KODUDB_API_URL`: on first start the API generates `JWT_SECRET`, `ENCRYPTION_KEY` and the console sign-in,
keeps them in its database (so every restart and replica agrees), writes them to `.env` when there is one,
and prints the sign-in once in its log. The console holds no secrets; it signs in through the API and
uses a 12-hour token. All settings are listed in [.env.example](.env.example).

## Keys

Every project has two keys, sent in the `apikey` header:

| Key | Where it goes | What it can do |
|---|---|---|
| **Public key** (`PUBLIC_KEY`) | Browsers, mobile apps | Whatever the project's row security policies allow; add a user's access token as `Authorization: Bearer` to act as that user |
| **Secret key** (`SECRET_KEY`) | Servers only | Everything; skips row security |

**Rotation.** Projects & keys → *Rotate keys* issues new keys for one project, *Rotate all keys* for every
project; old keys and every user session stop working at once (`POST /platform/v1/projects/<slug>/rotate-keys`,
`POST /platform/v1/rotate-keys`). The default project signs with `.env`: run `node scripts/gen-env.mjs --rotate`
and restart `api` and `console`. Stored secrets (project keys, GitHub tokens, data-source URLs) are encrypted
with `ENCRYPTION_KEY`, so signing keys rotate without touching them.

## Isolation

Each project's database is owned by its own login role (`p_<project>_owner`, not a superuser) and only that
role may connect to it; the API uses it for everything the project does, so a project's keys cannot reach
other projects, the platform database or the server (`COPY … PROGRAM`, `ALTER SYSTEM`, untrusted extensions
are refused). Untrusted extensions are enabled through `POST /platform/v1/projects/<slug>/extensions`
(root key). The default project is the platform database itself: its secret key is the platform admin key.

## Limits and abuse protection

- Failed sign-ins are limited to 10 per email and 100 per client address per 15 minutes (429 with
  `Retry-After`); the console login to 5 failures per minute. Counters are in memory per process.
- The client address is the TCP peer. Set `TRUST_PROXY=1` on the API only when it sits behind a proxy you
  run, so the first `X-Forwarded-For` hop is used.
- Live events run one row-security check per event per user, however many sockets that user has open;
  `realtime_checks` in `/meta/v1/stats` counts them.

## Features

| Area | What you get |
|---|---|
| Projects | Each project is its own Postgres database (`p_<slug>`) with its own keys, files and live events |
| Branching | Clone a project's database (schema + data) into a branch project tied to a Git branch |
| Migrations | Every create/alter/drop is recorded as a numbered migration; push to GitHub, open pull requests from branches |
| REST API | `/rest/v1/<table>` with `eq neq gt gte lt lte like ilike is in not.`, select, order, paging, counts, upsert, functions; row security enforced |
| Identity | Email/password, access and refresh tokens, admin user management, ban, sign-in activity |
| Two-factor | Authenticator apps (TOTP, RFC 6238): QR setup, a code required after the password (no session until then, email links included), replay-proof codes, 5 wrong codes per 15 min, `aal1`/`aal2` in tokens for policies, admin reset |
| Sign-in providers | Any number per project. Presets: Google, Apple, Microsoft, GitHub (and Enterprise), GitLab, Discord, Facebook, LinkedIn, Slack, Twitch, Bitbucket, Okta, Auth0, Clerk, Amazon Cognito, Keycloak, authentik, ZITADEL, Authelia, Logto, Casdoor, Ory, Dex, Kanidm, FusionAuth, or any other OpenID Connect provider. OpenID Connect uses discovery, PKCE (S256), a nonce and full ID-token checks (signature from the provider's keys, issuer, audience, expiry); keys are re-fetched when the provider rotates them. Accounts link by verified email only (a per-provider switch can trust a directory you control); a state cookie blocks login CSRF; an authenticator code is still asked for. `GET /auth/v1/providers` lists the ones that are on, for sign-in buttons |
| Email | Per-project SMTP (password encrypted), optional confirm-before-sign-in, password reset (`/auth/v1/recover`), resend, single-use 1-hour links (stored hashed, redirects only to your site URL), editable HTML templates with live preview, delivery log |
| Files | Buckets, uploads, public links, row-security-checked private files |
| Live events | WebSocket change feed per table; subscribers only receive rows their policies allow |
| Metrics & request logs | Request rate, latency p50/p95/p99, errors, busiest routes, database health; searchable log with live tail |
| Change log | Per-table audit trail: who changed which row, before and after |
| Data sources | Query external PostgreSQL, MySQL/MariaDB, SQL Server and MongoDB; connection strings encrypted at rest |
| Query console | CodeMirror editor with SQL IntelliSense: Postgres keywords, live tables and columns, common functions; Ctrl+Enter runs |
| API reference | Scalar, driven by an OpenAPI 3.1 document generated from each project's live schema, with sample payloads, example responses and "Test request" pre-filled with the public key |
| Console | Ctrl+K command palette (pages and tables), schema browser, row security editor, keyboard-accessible Radix dialogs and menus |

## Tests

```sh
podman build -t kodudb-api ./api       # runs Rust unit tests during the build
cd console && npm test                  # console unit tests
node --test --test-concurrency=1 "tests/*.test.mjs"   # end-to-end, against the running stack (sequential: key rotation is global)
```

The platform suite starts a mock GitHub container on the stack network, so no real token is needed.

## Screenshots

Captured with `scripts/screenshots.cjs` against the seeded Demo Store (demo data only). Click a group to expand it.

<details open>
<summary><b>Console</b> (11)</summary>
<br>

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/01-overview.png" alt="Overview"><br><sub>Overview</sub></td>
    <td width="50%" align="center"><img src="docs/samples/18-dark-overview.png" alt="Overview, dark"><br><sub>Overview, dark</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/16-command-palette.png" alt="Command palette (Ctrl+K)"><br><sub>Command palette (Ctrl+K)</sub></td>
    <td width="50%" align="center"><img src="docs/samples/20-phone-overview.png" alt="On a phone"><br><sub>On a phone</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/27-sign-in-light.png" alt="Sign-in"><br><sub>Sign-in</sub></td>
    <td width="50%" align="center"><img src="docs/samples/27-sign-in-dark.png" alt="Sign-in, dark"><br><sub>Sign-in, dark</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/28-console-background-light.png" alt="Console background"><br><sub>Console background</sub></td>
    <td width="50%" align="center"><img src="docs/samples/28-console-background-dark.png" alt="Console background, dark"><br><sub>Console background, dark</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/39-profile-top-bar.png" alt="Profile in the top bar"><br><sub>Profile in the top bar</sub></td>
    <td width="50%" align="center"><img src="docs/samples/39-profile-menu.png" alt="Profile menu"><br><sub>Profile menu</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/00-sign-in.png" alt="Sign-in form"><br><sub>Sign-in form</sub></td>
    <td></td>
  </tr>
</table>
</details>

<details>
<summary><b>Projects and data</b> (8)</summary>
<br>

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/02-projects-and-keys.png" alt="Projects & keys"><br><sub>Projects & keys</sub></td>
    <td width="50%" align="center"><img src="docs/samples/17-rotate-keys-dialog.png" alt="Rotate keys"><br><sub>Rotate keys</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/03-data-explorer.png" alt="Data explorer"><br><sub>Data explorer</sub></td>
    <td width="50%" align="center"><img src="docs/samples/06-schema-row-security.png" alt="Schema and row security"><br><sub>Schema and row security</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/04-query-console.png" alt="Query console"><br><sub>Query console</sub></td>
    <td width="50%" align="center"><img src="docs/samples/05-sql-intellisense.png" alt="SQL IntelliSense"><br><sub>SQL IntelliSense</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/13-migrations.png" alt="Migrations"><br><sub>Migrations</sub></td>
    <td width="50%" align="center"><img src="docs/samples/14-data-sources.png" alt="Data sources"><br><sub>Data sources</sub></td>
  </tr>
</table>
</details>

<details>
<summary><b>Identity and email</b> (14)</summary>
<br>

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/07-identity.png" alt="Users"><br><sub>Users</sub></td>
    <td width="50%" align="center"><img src="docs/samples/21-identity-awaiting-confirmation.png" alt="Awaiting email confirmation"><br><sub>Awaiting email confirmation</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/29-identity-two-factor.png" alt="Two-factor users"><br><sub>Two-factor users</sub></td>
    <td width="50%" align="center"><img src="docs/samples/30-reset-two-factor-menu.png" alt="Reset two-factor"><br><sub>Reset two-factor</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/32-sign-in-providers.png" alt="Sign-in providers"><br><sub>Sign-in providers</sub></td>
    <td width="50%" align="center"><img src="docs/samples/37-sign-in-providers-dark.png" alt="Sign-in providers, dark"><br><sub>Sign-in providers, dark</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/36-add-provider-presets.png" alt="Add a provider from presets"><br><sub>Add a provider from presets</sub></td>
    <td width="50%" align="center"><img src="docs/samples/38-add-provider-search.png" alt="Search providers"><br><sub>Search providers</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/35-provider-oidc-settings.png" alt="OpenID Connect provider settings"><br><sub>OpenID Connect provider settings</sub></td>
    <td width="50%" align="center"><img src="docs/samples/33-identity-linked-github.png" alt="Users linked to a provider"><br><sub>Users linked to a provider</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/22-email-settings.png" alt="Email settings"><br><sub>Email settings</sub></td>
    <td width="50%" align="center"><img src="docs/samples/23-email-test-sent.png" alt="Test email sent"><br><sub>Test email sent</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/24-email-templates.png" alt="Email templates"><br><sub>Email templates</sub></td>
    <td width="50%" align="center"><img src="docs/samples/25-sent-emails.png" alt="Sent emails"><br><sub>Sent emails</sub></td>
  </tr>
</table>
</details>

<details>
<summary><b>Files, live events and monitoring</b> (6)</summary>
<br>

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/08-files.png" alt="Files"><br><sub>Files</sub></td>
    <td width="50%" align="center"><img src="docs/samples/09-live-events.png" alt="Live events"><br><sub>Live events</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/10-metrics.png" alt="Metrics"><br><sub>Metrics</sub></td>
    <td width="50%" align="center"><img src="docs/samples/19-dark-metrics.png" alt="Metrics, dark"><br><sub>Metrics, dark</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/11-request-logs.png" alt="Request logs"><br><sub>Request logs</sub></td>
    <td width="50%" align="center"><img src="docs/samples/12-change-log.png" alt="Change log"><br><sub>Change log</sub></td>
  </tr>
</table>
</details>

<details>
<summary><b>API reference</b> (4)</summary>
<br>

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/15-api-reference.png" alt="Generated API reference"><br><sub>Generated API reference</sub></td>
    <td width="50%" align="center"><img src="docs/samples/26-api-reference-recover.png" alt="Password recovery endpoint"><br><sub>Password recovery endpoint</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/samples/31-api-reference-two-factor.png" alt="Two-factor endpoints"><br><sub>Two-factor endpoints</sub></td>
    <td width="50%" align="center"><img src="docs/samples/34-api-reference-providers.png" alt="Sign-in provider endpoints"><br><sub>Sign-in provider endpoints</sub></td>
  </tr>
</table>
</details>

## Known limits

- Tokens are stateless: logout is client-side and a banned user's access token works until it expires (1 hour); rotating a project's keys ends all of its sessions.
- Branching briefly disconnects the source project while Postgres copies the database; files are not copied.
- Data-source queries open a fresh connection per request and cap results at 1000 rows.
- Emails are sent in the background and logged; there is no retry queue yet, so a failed send needs a resend.
- Two-factor supports one authenticator per user and no backup codes yet; a lost phone needs an admin reset.
- Sign-in providers: linking an account whose email was never confirmed removes its password, because whoever set it may not own the mailbox. Apple needs an https API (its form-post callback carries the state cookie only with `SameSite=None; Secure`) and a client-secret JWT you generate from your Apple key. X (Twitter) is not a preset: it does not reliably share an email address. Microsoft does not mark emails as verified, so it needs "trust email addresses" for your own tenant. Only the GitHub and OpenID Connect paths are tested end to end (against a mock); Discord, Facebook and Bitbucket profile mapping is unit-tested.
- Not built yet: backups and point-in-time restore, image transforms, server-side functions.

## Contributing
Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and look for
[`good first issue`](../../labels/good%20first%20issue).

Every pull request goes through the same pipeline:

| Step | What runs |
| --- | --- |
| **Tests** | Rust unit tests, console unit tests, type check and build, end-to-end tests against a live stack |
| **Security** | cargo-audit and npm audit, gitleaks secret scan, ClamAV malware scan plus a block on executables or archives in the diff, and CodeQL with dependency review (public repo) |
| **Bot review** | An AI review comments on security, data safety, bugs and missing tests |
| **Human review** | Code-owner approval. Nobody can push to `main` directly. |
| **Auto-merge** | Squash-merges once checks and review pass (maintainer label `automerge`, or Dependabot patch/minor updates) |
| **Release** | When the version in `api/Cargo.toml` changes, container images are pushed to GitHub Packages and a GitHub Release is published. |

Security problems: please use private reporting as described in [SECURITY.md](SECURITY.md), not a public issue.
Everyone is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Media kit
Images in [`docs/images`](docs/images) (hero, social preview 1280×640, Open Graph 1200×630, billboard 3840×1280,
square post, feature cards, [brand sheet](docs/images/brand-sheet.jpg)) and video in [`docs/media`](docs/media).
They are generated from the console screenshots in `docs/samples`, which use demo data only:
```sh
cd marketing && npm ci && npx playwright install chromium
node images.mjs            # images -> docs/images
node images.mjs --video    # plus the tour -> docs/media (needs ffmpeg)
```

## License
[Apache License 2.0](LICENSE), which includes an express patent grant from every contributor. Third-party code
and assets (React Bits backgrounds, provider logos from thesvg) are listed in [NOTICE](NOTICE).

## Contributors
Thanks to everyone who helps build KoduDB. New contributors show up here automatically after their first merged
pull request. Want to join them? Start with [CONTRIBUTING.md](CONTRIBUTING.md).

<p align="center">
  <a href="../../graphs/contributors">
    <img src="../../raw/contributors/contributors.svg" alt="Contributors">
  </a>
</p>
