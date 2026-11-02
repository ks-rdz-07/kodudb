# Deploying KoduDB from published images

| Folder | Target |
|--------|--------|
| [`compose/`](compose) | Any Docker host: Postgres, API, console, RustFS, optional HTTPS (Caddy) |
| [`helm/kodudb/`](helm/kodudb) | Kubernetes: EKS, GKE, AKS, DigitalOcean, k3s and others |
| [`terraform/`](terraform) | AWS, Google Cloud, Azure, DigitalOcean, Hetzner VMs, and Kubernetes through Helm |
| [`fly/`](fly) | Fly.io |
| [`../render.yaml`](../render.yaml) | Render Blueprint |
| [`../.do/app.yaml`](../.do/app.yaml) | DigitalOcean App Platform |

Every target has dev, staging and prod profiles. Full instructions and the environment variable reference:
[docs/deploy.md](../docs/deploy.md).
