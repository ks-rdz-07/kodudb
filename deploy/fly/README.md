# KoduDB on Fly.io

Two apps (API and console) from the published images, a volume for files, and Fly Postgres (or any Postgres).

```sh
# 1. API app, its volume and its database
fly launch --no-deploy --copy-config -c deploy/fly/api.fly.toml --name kodudb-api
fly volumes create kodudb_files --size 5 -a kodudb-api
fly postgres create --name kodudb-pg            # or use Fly Managed Postgres / any provider
fly postgres attach kodudb-pg -a kodudb-api     # sets DATABASE_URL as a secret
fly secrets set -a kodudb-api KODUDB_PUBLIC_URL=https://kodudb-api.fly.dev
fly deploy -c deploy/fly/api.fly.toml
fly logs -a kodudb-api | grep -A3 sign-in       # console sign-in, printed once

# 2. Console app
fly launch --no-deploy --copy-config -c deploy/fly/console.fly.toml --name kodudb-console
fly secrets set -a kodudb-console KODUDB_PUBLIC_URL=https://kodudb-api.fly.dev
fly deploy -c deploy/fly/console.fly.toml
```

If you choose other app names, update `KODUDB_API_URL` in `console.fly.toml` (`http://<api-app>.internal:8787`).

**Files.** The API keeps files on the `kodudb_files` volume. For S3 storage (shared by several API machines), set
`S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` and `S3_PUBLIC_URL` as secrets; per-project keys need a RustFS server.

**Environments.** Use separate apps per environment, for example `kodudb-api-staging` and `kodudb-api-prod`, each
with its own volume, database and secrets (`fly deploy -c deploy/fly/api.fly.toml -a kodudb-api-staging`).
