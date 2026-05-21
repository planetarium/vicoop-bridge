# syntax=docker/dockerfile:1.6
#
# vicoop-bridge — bundled-direct deployment profile. The bridge client +
# agent CLI install machinery share one image; the operator runs a single
# container. The alternative profile (#249) keeps the bridge bare-metal
# and spawns a per-backend agent runtime container; both profiles
# coexist.
#
# Two stages:
#
#   1. build  — `bun build --compile` produces a self-contained vicoop-client
#               native binary. The build stage uses pnpm to install workspace
#               deps and builds the protocol package whose dist/index.js
#               is resolved by bun at compile time.
#   2. runtime — node:20-bookworm-slim with the system tools each agent CLI
#               needs at runtime (node, git, curl, jq). Backend CLIs are
#               NOT baked into the image; entrypoint.sh installs them into
#               /data on first boot.
#
# See docs/container.md for operator-facing usage; see #244 (this profile)
# and #249 (external-runtime profile) for the design.

ARG NODE_BASE=node:20-bookworm-slim
ARG BUN_VERSION=1.2.20

# ---- build stage ---------------------------------------------------------
# node:20-bookworm-slim gives us node+npm (for pnpm). bun is installed via
# its official script — pinning the version with BUN_VERSION keeps the
# native binary output reproducible.
FROM ${NODE_BASE} AS build

ARG BUN_VERSION

WORKDIR /src

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@9.12.0

ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install \
 | bash -s "bun-v${BUN_VERSION}" \
 && bun --version

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
# Every workspace member's package.json must exist for pnpm's
# --frozen-lockfile to validate; the actual sources of admin-ui / server
# aren't needed for the client build but the manifests are.
COPY packages/protocol/package.json packages/protocol/
COPY packages/client/package.json   packages/client/
COPY packages/server/package.json   packages/server/
COPY packages/admin-ui/package.json packages/admin-ui/

# Only install deps the client build actually needs (protocol + client),
# leaving admin-ui/server's native-compile-heavy deps (keccak / etc.) out
# of the build stage. `client...` follows the workspace dependency graph
# to include @vicoop-bridge/protocol transitively.
#
# `--ignore-scripts` skips post-install native builds (ws's optional
# `bufferutil` / `utf-8-validate`, etc.) — bun compiles a static binary
# anyway, and ws falls back to pure-JS when these aren't present.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter '@vicoop-bridge/client...'

COPY packages/protocol packages/protocol
COPY packages/client   packages/client

# protocol must be built before the client compile — bun resolves
# `@vicoop-bridge/protocol` via the package's exports.import (dist/index.js)
# at compile time.
RUN pnpm --filter @vicoop-bridge/protocol build

# Compile the client into a single-file binary. The bun target follows
# the build platform automatically so a host-arch dev build (Apple
# Silicon arm64) produces an arm64 binary, while a buildx invocation
# with `--platform linux/amd64` produces x64. Manual override:
# `--build-arg BUN_TARGET=bun-linux-x64`.
ARG TARGETARCH
ARG BUN_TARGET
RUN mkdir -p /out \
 && cd packages/client \
 && TARGET="${BUN_TARGET:-$(case "${TARGETARCH:-$(uname -m | sed s/aarch64/arm64/; sed s/x86_64/amd64/)}" in \
        amd64) echo bun-linux-x64 ;; \
        arm64) echo bun-linux-arm64 ;; \
        *)     echo bun-linux-x64 ;; \
    esac)}" \
 && echo "[build] bun target: $TARGET" \
 && bun build --compile --target="$TARGET" src/cli.ts --outfile /out/vicoop-client \
 && chmod +x /out/vicoop-client

# ---- runtime stage -------------------------------------------------------
FROM ${NODE_BASE}

# Identifies this binary as the one shipped by the image, so
# `vicoop-client upgrade` can short-circuit with a `docker pull` hint.
# Wired by release.yml at build time; default keeps local builds usable.
ARG VICOOP_BRIDGE_IMAGE=0.0.0-dev
ENV VICOOP_BRIDGE_IMAGE=$VICOOP_BRIDGE_IMAGE

# System dependencies. Each justified:
#   - ca-certificates, curl: TLS + ad-hoc requests in install recipes
#   - git, openssh-client: agent CLIs clone repos, sometimes via ssh
#   - jq: shell-side JSON manipulation in entrypoint / install-backend
#   - tini: PID-1 reaper. agent CLI subprocesses spawn other children
#     (e.g. claude code -> bash); without tini we leak zombies.
#   - iptables, ipset, dnsutils, iproute2: init-firewall.sh
#   - python3: occasionally pulled in by node-gyp during agent CLI installs;
#     small and worth bundling so install-backend.sh doesn't fail on first
#     run for unpackaged native deps. Reconsider if the layer grows.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq openssh-client tini \
      iptables ipset dnsutils iproute2 \
 && rm -rf /var/lib/apt/lists/*

# Node's `semver` is bundled with npm; we install it as a global lib here
# so entrypoint.sh can `node -e "require('semver')..."` for compat checks.
RUN npm install -g semver

# Canonical data root for all persistent state. Mounted as a named volume
# in operator-side compose. Per backend creds get redirected here via
# CLAUDE_CONFIG_DIR / CODEX_HOME so the whole stateful surface lives in
# one place.
ENV VICOOP_DATA=/data
ENV VICOOP_HOME=/data
ENV CLAUDE_CONFIG_DIR=/data/creds/claude
ENV CODEX_HOME=/data/creds/codex
ENV PATH=/data/agents/claude/bin:/data/agents/codex/bin:/data/agents/claude/.npm-global/bin:/data/agents/codex/.npm-global/bin:$PATH

# Disable agent CLI self-updaters inside the container. Each backend's
# native upgrade flow gets driven from install-backend.sh instead so we
# can keep installed.json in sync.
ENV DISABLE_AUTOUPDATER=1

# Image scripts. The /usr/local/lib path matches install-backend.sh's
# $VICOOP_LIB default so operators can `docker exec` them without env
# overrides.
COPY container/bundled/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY container/install-backend.sh    /usr/local/lib/vicoop-bridge/install-backend.sh
COPY container/init-firewall.sh      /usr/local/lib/vicoop-bridge/init-firewall.sh
COPY container/backends/             /usr/local/lib/vicoop-bridge/backends/
RUN chmod 755 /usr/local/bin/entrypoint.sh \
              /usr/local/lib/vicoop-bridge/install-backend.sh \
              /usr/local/lib/vicoop-bridge/init-firewall.sh \
              /usr/local/lib/vicoop-bridge/backends/*.sh

# The bridge client binary.
COPY --from=build /out/vicoop-client /usr/local/bin/vicoop-client

# Pre-seed /data with the directory tree the entrypoint expects, owned by
# the unprivileged `node` user provided by the node:20 base image. A
# volume mount on /data at runtime inherits these permissions.
RUN mkdir -p /data/agents /data/creds/claude /data/creds/codex \
 && mkdir -p /home/node/work \
 && chown -R node:node /data /home/node/work

USER node
WORKDIR /home/node/work

# tini as PID 1 → entrypoint.sh → exec vicoop-client. Forwarding args
# means `docker run ... <flags>` reach the bridge client unchanged.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]

# Image-level metadata helpful for `docker inspect` / registries.
LABEL org.opencontainers.image.source="https://github.com/planetarium/vicoop-bridge"
LABEL org.opencontainers.image.description="vicoop-bridge client (A2A bridge for local coding agents)"
LABEL org.opencontainers.image.licenses="Apache-2.0"
