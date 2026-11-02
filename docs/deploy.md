# Deploying KoduDB

KoduDB is two apps and a database:

| Part | Folder | Needs |
|------|--------|-------|
| API (Rust) | `api/` | `DATABASE_URL` (a Postgres 15+ user that may create databases and roles) |
| Console (Next.js) | `console/` | `KODUDB_API_URL` (where it reaches the API) |
| Postgres | — | your own server or container |

Nothing else is required. On first start the API creates `JWT_SECRET`, `ENCRYPTION_KEY` and the console
sign-in (`DASHBOARD_USERNAME=admin` and a random `DASHBOARD_PASSWORD`), keeps them in its database
(`kodudb.secrets`) so restarts and replicas agree, appends them to `.env` when one exists, and prints the
sign-in once in its log:

```
  ================  KoduDB console sign-in  ================
    username: admin
    password: <generated>
```

Set any of them as an environment variable to choose it yourself; a set variable always wins. All
variables are listed in [`.env.example`](../.env.example).

## Pick a build type

| Build type | API (`api/`) | Console (`console/`) |
|------------|--------------|---------------------|
| **Dockerfile** | `api/Dockerfile` | `console/Dockerfile` |
| **Docker Compose** | `compose.yml` (API, console and Postgres together) | |
| **Railpack** | `api/railpack.json` | `console/railpack.json` |
| **Nixpacks** | `api/nixpacks.toml` | `console/nixpacks.toml` |
| **Heroku Buildpacks** | Use the Dockerfile: Heroku's builder has no Rust support | `console/Procfile` (Node detected) |
| **Paketo Buildpacks** | `api/project.toml` (community Rust buildpack) | `console/project.toml` |
| **PM2** (Linux, macOS, Windows) | `ecosystem.config.cjs` runs both | |
| **Windows Server** | `scripts\windows\install.ps1` (PM2 + start-up task) | |

On platforms that build from a repository (Dokploy, Coolify, Railway and similar), create two apps from
this repository and set the build path to `api` and to `console`.

### Docker Compose

```sh
node scripts/gen-env.mjs     # creates .env, or adds what is missing; prints the console sign-in
docker compose up -d         # or: podman compose up -d
```

Console on http://localhost:3100, API on http://localhost:8787. `gen-env.mjs` never changes a value that
is already set, so run it before every start if you like.

### Dockerfile (single containers)

```sh
docker build -t kodudb-api api && docker build -t kodudb-console console
docker run -d --name kodudb-api -p 8787:8787 -v kodudb-files:/data/storage \
  -e DATABASE_URL=postgres://postgres:secret@db-host:5432/kodudb kodudb-api
docker logs kodudb-api       # the console sign-in, on first start
docker run -d --name kodudb-console -p 3100:3000 -e KODUDB_API_URL=http://api-host:8787 kodudb-console
```

### Railpack, Nixpacks, Heroku and Paketo buildpacks

- API: set `DATABASE_URL` (and `KODUDB_PUBLIC_URL` to its public address). Mount a volume and set
  `STORAGE_ROOT` to it, or uploaded files are lost on redeploy. The sign-in is in the first deploy's log.
- Console: set `KODUDB_API_URL` to the API's internal or public address.
- Buildpack images run as a non-root user: `STORAGE_ROOT` defaults to `./storage`, which they can write.
- Managed Postgres plans that forbid `CREATE DATABASE` / `CREATE ROLE` (Heroku Postgres, many hosted
  plans) can run the default project only; extra projects need their own databases.

### PM2

```sh
cd api && cargo build --release && cd ..
cd console && npm ci && npm run build && cd ..
pm2 start ecosystem.config.cjs   # completes .env first, then starts kodudb-api and kodudb-console
pm2 save && pm2 startup          # start again after a reboot (Linux, macOS)
```

Set `DATABASE_URL` in `.env` to your Postgres server first; `API_PORT` and `CONSOLE_PORT` change the ports.

### Windows Server

From an elevated PowerShell in the repository:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1 -DatabaseUrl "postgres://postgres:secret@127.0.0.1:5432/kodudb"
```

It needs Node.js 22+, Rust (rustup) and PostgreSQL. It completes `.env`, builds both apps, runs them with
PM2 and registers a `KoduDB` start-up task. `-Uninstall` stops them and removes the task (data stays).

## Lost the console password?

- Set `DASHBOARD_PASSWORD` in the environment (or `.env`) and restart the API, or
- read the generated one: `select value from kodudb.secrets where name = 'DASHBOARD_PASSWORD';`

Secrets the API generated sit in its database next to the data they protect. To keep them apart, set
`JWT_SECRET` and `ENCRYPTION_KEY` in your platform's secret settings instead.
