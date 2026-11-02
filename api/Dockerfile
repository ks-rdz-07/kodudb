# KoduDB API image. Build: docker build -t kodudb-api api
# Build on the same Debian release as the runtime image: aws-lc (C) must link against the same glibc.
FROM docker.io/library/rust:1-slim-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
# Cache dependencies separately from source.
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release --locked && rm -rf src
COPY sql sql
COPY src src
RUN touch src/main.rs && cargo test --release --locked && cargo build --release --locked

FROM docker.io/library/debian:bookworm-slim
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="KoduDB API" \
      org.opencontainers.image.description="KoduDB API: PostgreSQL backend with authentication, REST API, row-level security, S3 file storage and realtime for apps and IoT devices." \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="The KoduDB contributors"
# CA certificates: the S3 client verifies TLS against the system store.
# The API runs as an unprivileged user (uid 10001) that owns /data, where local file storage lives.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 kodudb \
    && useradd --system --uid 10001 --gid kodudb --home-dir /data --shell /usr/sbin/nologin kodudb \
    && mkdir -p /data/storage && chown -R kodudb:kodudb /data
COPY --from=build /app/target/release/kodudb-api /usr/local/bin/kodudb-api
ENV STORAGE_ROOT=/data/storage PORT=8787
USER 10001:10001
WORKDIR /data
EXPOSE 8787
VOLUME ["/data/storage"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["kodudb-api", "healthcheck"]
CMD ["kodudb-api"]
