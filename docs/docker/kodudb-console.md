# KoduDB Console

**Web console for KoduDB, the open-source backend and real-time data platform for apps and IoT devices.** Manage
projects and keys, explore and edit data, write SQL with IntelliSense, configure authentication and sign-in
providers, manage files and S3 access, watch realtime events from devices, and read metrics, request logs and the
change log.

It needs a running [`kns777/kodudb-api`](https://hub.docker.com/r/kns777/kodudb-api); see that image for a complete
Compose example with PostgreSQL and file storage.

## Quick start

```sh
docker run -d --name kodudb-console -p 3100:3000 \
  -e KODUDB_API_URL=http://kodudb-api:8787 \
  -e KODUDB_PUBLIC_URL=http://localhost:8787 \
  kns777/kodudb-console:0.3
```

Open http://localhost:3100 and sign in with the console credentials the API printed on its first start.

## Tags

| Tag | Meaning |
|-----|---------|
| `0.3.2` | An exact release |
| `0.3` | The newest patch release of 0.3 |
| `latest` | The newest release |

Multi-architecture: **linux/amd64** and **linux/arm64**, with SBOM and build provenance attestations.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `KODUDB_API_URL` | `http://localhost:8787` | Where the console reaches the API (internal address; `host:port` is accepted) |
| `KODUDB_PUBLIC_URL` | `http://localhost:8787` | Public API address shown in the console |
| `PORT` | `3000` | Listen port |

The console keeps no secrets: it signs in through the API and uses a 12-hour session.

## Ports and health

- **Port** `3000`: the web console.
- **Health**: built-in `HEALTHCHECK` on the sign-in page.

## Security

- Runs as the unprivileged `node` user, not root.
- Next.js telemetry is disabled.

## License

Apache License 2.0.
