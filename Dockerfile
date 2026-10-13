FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl build-essential pkg-config git && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain nightly-2025-03-01
WORKDIR /build
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY .cargo .cargo
COPY native native
RUN cargo build --release --locked

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && groupadd --gid 10001 companion && useradd --uid 10001 --gid companion --no-create-home companion
WORKDIR /app
RUN mkdir -p /app/data && chown 10001:10001 /app/data
COPY --from=build /build/target/release/minecraft-companion /usr/local/bin/minecraft-companion
USER 10001:10001
ENV LOG_FORMAT=json
VOLUME ["/app/data"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/minecraft-companion"]
