#!/usr/bin/env bash
# vicoop-bridge container installer.
#
# Drives the container distribution end to end:
#
#   1. docker pull the published image (tag is configurable)
#   2. detect whether this host already has a wizard-completed setup
#      (i.e. /data/config.json exists in the data volume)
#   3. if not, launch the wizard container interactively
#   4. stop+remove any prior daemon container, then start a fresh
#      detached daemon with --restart unless-stopped
#
# Idempotent — operators can re-run after editing config or pulling a
# new image; the wizard step is skipped when the volume already carries
# a config.
#
# Pairs with the headless / case-A path documented in docs/container.md;
# this is the case-B (interactive) entrypoint and the recommended path
# for first-time operators on a host where they have a TTY available.

set -euo pipefail

IMAGE="${VICOOP_IMAGE:-ghcr.io/planetarium/vicoop-bridge-client:latest}"
CONTAINER="${VICOOP_CONTAINER:-vicoop-bridge}"
DATA_VOLUME="${VICOOP_DATA_VOLUME:-vicoop-data}"
WORK_VOLUME="${VICOOP_WORK_VOLUME:-vicoop-work}"

# ANSI colour for log lines. Skip when stdout isn't a TTY (curl|bash
# captured into a pipe shouldn't leak escape codes).
if [[ -t 1 ]]; then
    C_CYAN=$'\033[1;36m'
    C_RED=$'\033[1;31m'
    C_RESET=$'\033[0m'
else
    C_CYAN=""
    C_RED=""
    C_RESET=""
fi

log() { printf '%s==>%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
die() {
    printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2
    exit 1
}

# --- 0. Sanity ------------------------------------------------------------
command -v docker >/dev/null 2>&1 \
    || die "docker not found on PATH"

if ! docker info >/dev/null 2>&1; then
    die "docker is installed but the daemon isn't reachable (try: open Docker Desktop, or 'systemctl start docker')"
fi

# --- 1. Pull --------------------------------------------------------------
log "pulling $IMAGE"
docker pull "$IMAGE" >/dev/null \
    || die "docker pull $IMAGE failed"

# --- 2. Detect existing setup --------------------------------------------
needs_wizard=false
if ! docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1; then
    needs_wizard=true
else
    # The image has /usr/bin/test. Override the entrypoint so we run
    # the bare test instead of falling into wizard / daemon logic.
    if ! docker run --rm --entrypoint /usr/bin/test \
            -v "$DATA_VOLUME:/data" "$IMAGE" -f /data/config.json \
            2>/dev/null; then
        needs_wizard=true
    fi
fi

# --- 3. Wizard (interactive, one-shot) -----------------------------------
if [[ "$needs_wizard" == "true" ]]; then
    log "no config detected in volume '$DATA_VOLUME' — running interactive setup wizard"
    log "(the wizard will prompt for agent name / id / backend and walk OAuth flows)"
    if ! docker run --rm -it \
            -v "$DATA_VOLUME:/data" \
            -v "$WORK_VOLUME:/home/node/work" \
            --cap-add NET_ADMIN --cap-add NET_RAW \
            "$IMAGE"; then
        die "wizard exited non-zero; no daemon started"
    fi
else
    log "existing setup detected in volume '$DATA_VOLUME' — skipping wizard"
fi

# --- 4. Daemon ------------------------------------------------------------
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
    log "stopping prior container '$CONTAINER'"
    docker stop "$CONTAINER" >/dev/null
    docker rm "$CONTAINER" >/dev/null
fi

log "starting daemon container '$CONTAINER'"
docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    -v "$DATA_VOLUME:/data" \
    -v "$WORK_VOLUME:/home/node/work" \
    --cap-add NET_ADMIN --cap-add NET_RAW \
    "$IMAGE" >/dev/null

log "vicoop-bridge is running."
cat <<EOF

  logs:    docker logs -f $CONTAINER
  stop:    docker stop $CONTAINER
  status:  docker exec $CONTAINER vicoop-client whoami
  info:    docker exec $CONTAINER vicoop-client info
  shell:   docker exec -it $CONTAINER bash

EOF
