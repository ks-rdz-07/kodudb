# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project uses semantic versioning.

## [0.3.2]

### Security
- Stored secrets (project keys, SMTP passwords, sign-in provider secrets, two-factor secrets, storage keys,
  GitHub tokens, data-source URLs) are encrypted with AES-256 and SHA-256 key derivation instead of pgcrypto's
  default AES-128. Existing values are re-encrypted automatically at start-up; no action needed.

## [0.3.1]

### Fixed
- Query console scripts now run on their own connection, which is closed afterwards. Before, a script that left
  a failed or open transaction (for example `begin;` followed by an error) returned its connection to the shared
  pool, and later requests on that connection failed with "current transaction is aborted, commands ignored
  until end of transaction block". Session changes such as `SET ROLE` or `search_path` can no longer leak either.

## [0.3.0]

### Added
- Deployment from published images: an image-based Compose stack with optional HTTPS (Caddy), a Helm chart
  for Kubernetes, Terraform for AWS, Google Cloud, Azure, DigitalOcean and Hetzner VMs and for Kubernetes, and
  blueprints for Render, Fly.io and DigitalOcean App Platform, each with dev, staging and prod profiles.
- Device SDKs in `sdk/embedded`: a one-file Python client for Raspberry Pi and other Linux boards (CPython) and
  for Raspberry Pi Pico W and ESP32 (MicroPython), and an Arduino library for ESP32 and ESP8266. Both cover
  sign-in with token refresh, insert (single and batch), upsert, select, update, delete, RPC transactions and
  realtime changes with keep-alive and reconnects.
- README and media kit focus on IoT, IIoT and embedded real-time data; new hero image.
- Multi-architecture images (linux/amd64 and linux/arm64, for Raspberry Pi and ARM gateways) with SBOM and
  provenance attestations, tagged `0.3.0`, `0.3` and `latest`; Docker Hub overviews kept in sync.
- Sign-in card shows the copyright and the version; README badges for clones, views, stars, forks and pulls.

### Changed
- Images run as non-root users (API: uid 10001; console: `node`), have built-in health checks and full OCI
  labels.

### Upgrade notes
- Docker installs that store files locally (no S3) must give the files volume to the new user once:
  `docker compose run --rm --user root api chown -R 10001:10001 /data/storage`. Installs using S3 storage
  (the default Compose stack) need no action.

## [0.2.0]

### Added
- S3-compatible file storage, with RustFS bundled in Docker Compose (S3 API on port 9000, web console on 9001).
- Every project gets its own bucket and its own access key, created automatically through the RustFS admin API,
  limited by policy to that bucket and stored encrypted. Files → *S3 access* in the console shows the endpoint,
  bucket and key, rotates the key, and links to the storage console.
- Platform API: `GET /platform/v1/projects/<slug>/storage` and `POST /platform/v1/projects/<slug>/storage/rotate`.
- Existing installs move to S3 without losing files: local files are copied into each project's bucket once on
  the first start with S3 configured, and the local copies are kept.

### Changed
- Local file storage still works when no S3 storage is configured (PM2, Windows, buildpacks).
- The API image includes CA certificates.

### Security
- The console sign-in check compares passwords in constant time without hashing them.

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
