# KoduDB API

**Open-source backend and real-time data platform for apps and IoT devices.** The KoduDB API turns PostgreSQL into a
complete backend: authentication, an auto-generated REST API with row-level security, S3 file storage, realtime
changes over WebSocket, metrics and request logs. Devices such as ESP32, Raspberry Pi and industrial gateways write
readings and receive commands in real time, each limited by its own security policies.

Pair it with [`kns777/kodudb-console`](https://hub.docker.com/r/kns777/kodudb-console) for the web console.

## Quick start

```yaml
# compose.yml
services:
  db:
    image: postgres:17-alpine
    environment: { POSTGRES_PASSWORD: change-me, POSTGRES_DB: kodudb }
    volumes: [db:/var/lib/postgresql/data]
  storage:
    image: rustfs/rustfs:1.0.4
    environment: { RUSTFS_ACCESS_KEY: kodudb-storage, RUSTFS_SECRET_KEY: change-me-too, RUSTFS_CONSOLE_ENABLE: "true" }
    volumes: [objects:/data]
    ports: ["9000:9000", "9001:9001"]
  api:
    image: kns777/kodudb-api:0.3
    environment:
      DATABASE_URL: postgres://postgres:change-me@db:5432/kodudb
      S3_ENDPOINT: http://storage:9000
      S3_ACCESS_KEY: kodudb-storage
      S3_SECRET_KEY: change-me-too
      S3_PUBLIC_URL: http://localhost:9000
      KODUDB_PUBLIC_URL: http://localhost:8787
    ports: ["8787:8787"]
    depends_on: [db, storage]
  console:
    image: kns777/kodudb-console:0.3
    environment: { KODUDB_API_URL: http://api:8787, KODUDB_PUBLIC_URL: http://localhost:8787 }
    ports: ["3100:3000"]
volumes: { db: {}, objects: {} }
```

```sh
docker compose up -d
docker compose logs api | grep -A3 sign-in    # console sign-in, printed once on first start
```

Console on http://localhost:3100, API on http://localhost:8787. Replace the example passwords before exposing the
host. The project's deployment guide also covers Kubernetes (Helm), Terraform and PaaS platforms.

## Tags

| Tag | Meaning |
|-----|---------|
| `0.3.2` | An exact release |
| `0.3` | The newest patch release of 0.3 |
| `latest` | The newest release |

Every tag is a multi-architecture image for **linux/amd64** and **linux/arm64** (Raspberry Pi 4/5, ARM servers and
gateways), with SBOM and build provenance attestations.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | required | PostgreSQL 15+ URL; the user must be able to create databases and roles for extra projects |
| `KODUDB_PUBLIC_URL` | `http://localhost:8787` | Public API address, used in email and sign-in links |
| `S3_ENDPOINT` | none | S3-compatible storage; per-project buckets and access keys are created automatically (RustFS) |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | none | Storage root credentials |
| `S3_PUBLIC_URL`, `S3_CONSOLE_URL`, `S3_REGION` | | Storage address shown to users, storage console link, signing region |
| `STORAGE_ROOT` | `/data/storage` | Local file storage when no S3 storage is configured |
| `JWT_SECRET`, `ENCRYPTION_KEY` | generated | Generated on first start and kept in the database; set them to choose your own |
| `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD` | `admin`, generated | Console sign-in |
| `TRUST_PROXY` | off | Set to `1` behind your own reverse proxy |
| `PORT` | `8787` | Listen port |

## Ports, volumes and health

- **Port** `8787`: REST API, authentication, files and the realtime WebSocket.
- **Volume** `/data/storage`: local file storage (only used without S3).
- **Health**: built-in `HEALTHCHECK` (`kodudb-api healthcheck` calls `/health`).

## Security

- Runs as an unprivileged user (uid **10001**), not root.
- Stored credentials (project keys, SMTP passwords, provider secrets, storage keys) are encrypted with
  `ENCRYPTION_KEY`; back it up with the database.
- No telemetry. The API connects only to the database, storage, SMTP, sign-in providers and data sources you
  configure.
- Report vulnerabilities privately through the project's security policy.

**Upgrading from 0.2.0 or earlier with local file storage:** the files volume was written as root. Give it to the
new user once: `docker compose run --rm --user root api chown -R 10001:10001 /data/storage`.

## License

Apache License 2.0.
