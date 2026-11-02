# Contributing to KoduDB

Thanks for helping. This guide covers setup, the code layout, and the rules every change must follow.

## Development setup

Requires Docker or Podman, Node.js 22 or newer, and (to work on the API outside a container) a Rust
toolchain.

```sh
node scripts/gen-env.mjs                      # creates .env and prints the console sign-in
podman compose -f compose.yml up -d --build   # or: docker compose up -d --build
node scripts/seed-demo.mjs                    # optional demo project
```

The console runs on http://localhost:3100 and the API on http://localhost:8787. For console work with hot
reload: `cd console && npm ci && npm run dev`.

## Tests

```sh
cd api && cargo test                                   # Rust unit tests (also run by the API Docker build)
cd console && npm test && npx tsc --noEmit             # console unit tests and type check
node --test --test-concurrency=1 "tests/*.test.mjs"    # end-to-end, against the running stack
```

The email, sign-in provider and platform suites start mock servers with Podman.

## Project layout

| Path | Purpose |
| ---- | ------- |
| `api/src/` | Rust API (axum + sqlx): REST, identity, files, live events, platform |
| `api/sql/` | Platform and per-project database schema |
| `console/` | Next.js console (Radix Themes, Tailwind CSS) |
| `tests/` | End-to-end tests and mock servers |
| `scripts/` | `.env` generator, demo seed, screenshot capture, Windows install |
| `marketing/` | Image and video generators for `docs/images` and `docs/media` (demo data only) |
| `docs/` | Deployment guide, screenshots, media kit |

## Rules

- Keep the dependency list short. Discuss a new dependency in an issue first.
- Security-sensitive code (keys, tokens, row security, isolation, encryption) needs a test.
- Never weaken row security or project isolation to make a feature work.
- New logic needs a test: a Rust unit test, a console unit test, or an end-to-end test in `tests/`.
- Use demo data only in screenshots, fixtures and examples (`customer1@example.com`, "Demo Store").

## Branches and pull requests

1. Fork the repository, or create a branch if you have write access.
2. Keep each pull request to one change.
3. Run the tests before you push.
4. Fill in the pull request template. Attach screenshots for console changes.
5. Open the pull request against `main`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, for example
`fix(auth): reject expired reset links`. Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`,
`ci`.

## Sign-off (DCO)

Every commit needs a `Signed-off-by` line. Add it with `git commit -s`. The sign-off certifies the
Developer Certificate of Origin for that commit.

## License

The project is licensed under the Apache License 2.0 (see `LICENSE`). Contributions are accepted under the
same license (inbound = outbound): by submitting a change, you agree that it is licensed under Apache-2.0.

## Conduct and security

Participation is governed by `CODE_OF_CONDUCT.md`. Report security problems privately as described in
`SECURITY.md`, not in public issues.

## What happens after you open a pull request

- `main` is protected by a ruleset: nobody pushes to it directly. Work on a branch (or a fork) and open a PR.
- Required checks must pass: API tests, console tests and build, end-to-end tests, cargo-audit, npm audit,
  gitleaks, and the ClamAV and binary check. On the public repo, CodeQL and dependency review also run.
  Pull requests may not add executables or archives (`.exe`, `.dll`, `.zip`…). Binary media is allowed only
  under `docs/images/`, `docs/media/` and `docs/samples/`.
- A bot review comments on security, data safety, bugs and missing tests. Treat it as a second opinion. A
  maintainer still has to approve.
- On a first-time contributor's PR, workflows wait until a maintainer approves running them.
- Once approved, a maintainer adds the `automerge` label, and GitHub squash-merges when everything is green.
- Bumping `version` in `api/Cargo.toml` publishes container images to GitHub Packages and a GitHub Release.
