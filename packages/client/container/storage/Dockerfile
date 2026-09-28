FROM oven/bun:1.2.20 AS build
WORKDIR /build
COPY packages/client/src/caller-storage-manager.ts packages/client/src/caller-storage-manager-cli.ts packages/client/src/caller-runtime-sqlite.ts ./
RUN bun build --compile --external better-sqlite3 ./caller-storage-manager-cli.ts --outfile /vicoop-storage

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends util-linux e2fsprogs coreutils \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /vicoop-storage /usr/local/bin/vicoop-storage
ENTRYPOINT ["/usr/local/bin/vicoop-storage"]
