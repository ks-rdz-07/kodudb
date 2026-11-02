# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project uses semantic versioning.

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
