# syntax=docker/dockerfile:1.6
#
# vicoop-runtime — external-runtime container profile (#249).
#
# Agent-agnostic thin sandbox. Provides:
#   - base + system tools (git/curl/jq/openssh + iptables/ipset/dnsutils …)
#   - tini PID 1
#   - shared install machinery (install-backend.sh + backends/*.sh)
#   - init-firewall.sh outbound allowlist
#
# Agent CLIs themselves (claude / codex / …) are NOT baked in. The host-
# resident bridge client provisions them into a named volume mounted at
# /data/agents/<kind> by `docker exec <c> install-backend.sh <kind>` at
# backend init time. The container body is `sleep infinity`; every task
# is driven from outside via `docker exec`.
#
# Companion bundled-direct profile (#244) Dockerfile is at
# container/bundled/Dockerfile — same shared scripts under container/,
# different deployment shape.

ARG NODE_BASE=node:20-bookworm-slim
FROM ${NODE_BASE}

# Identifies the image at runtime so the host bridge client can probe
# (`docker exec <c> printenv VICOOP_RUNTIME_IMAGE`) which runtime
# version is mounted. Release workflow wires the real value via
# build-arg; local builds default to a dev marker.
ARG VICOOP_RUNTIME_IMAGE=0.0.0-dev
ENV VICOOP_RUNTIME_IMAGE=$VICOOP_RUNTIME_IMAGE

# System dependencies. Mirrors container/bundled/Dockerfile's runtime
# stage minus the bridge-client-specific bits (vicoop-client binary,
# semver lib). Each justified:
#   - ca-certificates, curl: TLS + ad-hoc fetches in install recipes
#   - git, openssh-client: agent CLIs clone repos, sometimes via ssh
#   - jq: shell-side JSON manipulation in install-backend
#   - tini: PID-1 reaper. agent CLI subprocesses spawn other children
#     (e.g. claude code -> bash); without tini we leak zombies.
#   - iptables, ipset, dnsutils, iproute2: init-firewall.sh
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq openssh-client tini \
      iptables ipset dnsutils iproute2 \
 && rm -rf /var/lib/apt/lists/*

# Persistent state root. The host bridge client mounts named volumes
# under /data (agents/, creds/, sessions/) when starting the runtime
# container for a backend. CLAUDE_CONFIG_DIR / CODEX_HOME redirect each
# agent CLI's creds into /data/creds/<kind> so the whole stateful
# surface lives in one place — and stays inside the container-scoped
# named volume, never touching the host operator's ~/.claude.
ENV VICOOP_DATA=/data
ENV VICOOP_HOME=/data
ENV CLAUDE_CONFIG_DIR=/data/creds/claude
ENV CODEX_HOME=/data/creds/codex
ENV PATH=/data/agents/claude/bin:/data/agents/codex/bin:/data/agents/claude/.npm-global/bin:/data/agents/codex/.npm-global/bin:$PATH

# Disable agent CLI self-updaters. The host bridge client drives
# upgrades explicitly via `docker exec <c> install-backend.sh <kind>`.
ENV DISABLE_AUTOUPDATER=1

# Image scripts. /usr/local/lib/vicoop-bridge matches install-backend.sh's
# $VICOOP_LIB default so `docker exec <c> install-backend.sh <kind>` works
# without env overrides.
COPY container/runtime/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY container/install-backend.sh    /usr/local/lib/vicoop-bridge/install-backend.sh
COPY container/init-firewall.sh      /usr/local/lib/vicoop-bridge/init-firewall.sh
COPY container/backends/             /usr/local/lib/vicoop-bridge/backends/
RUN chmod 755 /usr/local/bin/entrypoint.sh \
              /usr/local/lib/vicoop-bridge/install-backend.sh \
              /usr/local/lib/vicoop-bridge/init-firewall.sh \
              /usr/local/lib/vicoop-bridge/backends/*.sh

# Pre-seed /data with the directory tree install-backend.sh expects,
# owned by the unprivileged `node` user the runtime drops to. A volume
# mount on /data at runtime inherits these permissions.
RUN mkdir -p /data/agents /data/creds/claude /data/creds/codex /data/sessions \
 && chown -R node:node /data

USER node
WORKDIR /data

# tini as PID 1 → entrypoint.sh → sleep infinity. All meaningful work
# (install-backend, agent spawn, version probe) flows through
# `docker exec` from the host bridge client.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]

LABEL org.opencontainers.image.source="https://github.com/planetarium/vicoop-bridge"
LABEL org.opencontainers.image.description="vicoop-bridge external-runtime container (#249) — agent-agnostic sandbox for host-driven claude/codex spawn"
LABEL org.opencontainers.image.licenses="Apache-2.0"
