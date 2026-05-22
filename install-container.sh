#!/usr/bin/env bash
# Host wrapper for the bundled-direct container profile (#244).
#
# A one-shot to launch `ghcr.io/planetarium/vicoop-bridge-client`
# with the right volumes attached and a TTY, so the entrypoint's
# wizard (the in-container first-time setup, #244 case B) can run.
# After the wizard finishes the daemon stays in the same container;
# the operator hits Ctrl-C to detach. Future starts use
# `docker run -d` (or systemd / compose / docker start) — the
# wrapper prints that command at the end so it doesn't have to be
# memorised.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/planetarium/vicoop-bridge/main/install-container.sh -o install-container.sh
#   bash install-container.sh
#
# (Don't curl-pipe-bash this — the script needs an attached TTY for
# the wizard's prompts and `curl | bash` redirects stdin to the
# pipe. We detect and refuse that case below with a clear message.)
#
# Tunables via env:
#   VICOOP_BRIDGE_IMAGE         (default ghcr.io/planetarium/vicoop-bridge-client:latest)
#   VICOOP_BRIDGE_CONTAINER     (default vicoop-bridge)
#   VICOOP_BRIDGE_STATE_VOLUME      (default vicoop-bridge-state)
#   VICOOP_BRIDGE_WORKSPACE_VOLUME  (default vicoop-bridge-workspace)

set -euo pipefail

IMAGE="${VICOOP_BRIDGE_IMAGE:-ghcr.io/planetarium/vicoop-bridge-client:latest}"
NAME="${VICOOP_BRIDGE_CONTAINER:-vicoop-bridge}"
STATE_VOLUME="${VICOOP_BRIDGE_STATE_VOLUME:-vicoop-bridge-state}"
WORKSPACE_VOLUME="${VICOOP_BRIDGE_WORKSPACE_VOLUME:-vicoop-bridge-workspace}"

log()  { printf '[install] %s\n' "$*" >&2; }
die()  { log "ERROR: $*"; exit 1; }

# ── Preflight ────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 \
    || die "\`docker\` not found in PATH. Install Docker Desktop / colima / podman-docker first."

if [[ ! -t 0 || ! -t 1 ]]; then
    log "ERROR: this script needs an attached TTY for the wizard's prompts."
    log "If you ran it via \`curl … | bash\` (which redirects stdin to the pipe),"
    log "download the script first and re-run it directly:"
    log ""
    log "  curl -fsSL https://raw.githubusercontent.com/planetarium/vicoop-bridge/main/install-container.sh -o install-container.sh"
    log "  bash install-container.sh"
    exit 1
fi

if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    die "docker daemon is not reachable. Start docker (or your context's daemon) and retry."
fi

# ── Image: pull, fall back to a local copy if the registry pull fails ──
log "fetching image: $IMAGE"
if ! docker pull "$IMAGE" >&2; then
    if docker image inspect "$IMAGE" >/dev/null 2>&1; then
        log "registry pull failed; using the local copy of $IMAGE"
    else
        die "registry pull failed and no local copy of $IMAGE is present."
    fi
fi

# ── Existing container? Refuse rather than silently overwrite ────
existing_id="$(docker ps -a --filter "name=^${NAME}$" --format '{{.ID}}')"
if [[ -n "$existing_id" ]]; then
    log "ERROR: a container named '$NAME' already exists ($existing_id)."
    log "If you're sure it's stale, remove it first:"
    log "  docker rm -f $NAME"
    log "Otherwise pass a different name via VICOOP_BRIDGE_CONTAINER=…"
    exit 1
fi

# ── Volumes: idempotent ──────────────────────────────────────────
docker volume create "$STATE_VOLUME" >/dev/null
docker volume create "$WORKSPACE_VOLUME" >/dev/null

# ── Run wizard ────────────────────────────────────────────────────
log ""
log "launching wizard ($NAME)…"
log "  State volume:     $STATE_VOLUME -> /data (config, credentials, installed CLIs)"
log "  Workspace volume: $WORKSPACE_VOLUME -> /home/node/work"
log ""
log "When setup finishes the daemon takes over in this same container."
log "Hit Ctrl-C to detach when you're done watching the boot."
log ""

set +e
docker run --rm -it --name "$NAME" \
    -v "$STATE_VOLUME:/data" \
    -v "$WORKSPACE_VOLUME:/home/node/work" \
    "$IMAGE"
exit_code=$?
set -e

log ""
log "Container exited (status $exit_code)."
log ""
log "To start the daemon again later (background, restart-on-host-reboot):"
log "  docker run -d --restart unless-stopped --name $NAME \\"
log "    -v $STATE_VOLUME:/data \\"
log "    -v $WORKSPACE_VOLUME:/home/node/work \\"
log "    $IMAGE"
log ""
log "Your config, credentials, and installed backend CLIs are on the"
log "'$STATE_VOLUME' volume; subsequent"
log "starts skip the wizard and go straight to daemon mode."

exit "$exit_code"
