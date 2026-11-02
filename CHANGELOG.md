# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project uses semantic versioning.

## [0.1.1]

### Security
- SQL Server driver updated (tiberius 0.13), removing a TLS library with known advisories (rustls 0.21,
  rustls-webpki 0.101).
- sqlx 0.9 no longer depends on the RSA crate with an unfixed timing advisory (RUSTSEC-2023-0071).
  Token signing uses the aws-lc-rs backend, which keeps it out of the tree.
- A single TLS crypto provider (aws-lc-rs) is installed at startup.

### Changed
- Dependency roundup: sqlx 0.9, jsonwebtoken 11, tower-http 0.7, hmac 0.13, sha1 0.11, TypeScript 7,
  Node.js 26 container base, thesvg 4, lucide-react, Scalar API reference, and GitHub Actions.
- Dynamic SQL is explicitly marked as reviewed (`AssertSqlSafe`), as sqlx 0.9 requires; identifiers and
  literals are still quoted as before.

### Docs
- README screenshots grouped by area, with captions.

## [0.1.0]

First preview release.

### Added
- Projects: each project is its own Postgres database with its own keys, files and live events, owned by a
  dedicated non-superuser role.
- Branching: clone a project into a branch project tied to a Git branch.
- Migrations: every schema change is recorded and can be pushed to GitHub, with pull requests from branches.
- REST API generated from the live schema, with row security enforced.
- Identity: email and password, access and refresh tokens, two-factor (TOTP), sign-in providers (OpenID
  Connect and OAuth presets), per-project SMTP, password reset and editable email templates.
- Files, live events over WebSocket, metrics, request logs, change log and external data sources.
- Console: query console with SQL IntelliSense, schema browser, row security editor, API reference,
  command palette, light and dark themes.
- Deployment guides for Docker Compose, Podman, Railpack, Nixpacks, buildpacks, PM2 and Windows Server.
