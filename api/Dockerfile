FROM docker.io/library/rust:1-slim AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
# Cache dependencies separately from source.
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src
COPY sql sql
COPY src src
RUN touch src/main.rs && cargo test --release && cargo build --release

FROM docker.io/library/debian:bookworm-slim
COPY --from=build /app/target/release/kodudb-api /usr/local/bin/kodudb-api
ENV STORAGE_ROOT=/data/storage
EXPOSE 8787
CMD ["kodudb-api"]
