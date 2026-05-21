#!/usr/bin/env bash
# vicoop-bridge container entrypoint.
#
# Two paths exist in this image:
#
#   - **headless setup** (PR 1, this script): no /data/config.json on disk
#     yet, but the operator has supplied the bootstrap env vars
#     (VICOOP_BRIDGE_TOKEN / VICOOP_AGENT_ID / VICOOP_BACKEND / ...). We
#     generate config.json, install the requested backend, then start the
#     daemon. No TTY needed.
#
#   - **daemon** (every subsequent boot): config.json is present. We
#     compare /data/installed.json against the supportedRange the bridge
#     client advertises via `vicoop-client info`; mismatch -> exit with
#     explicit install-backend.sh instructions. Otherwise: firewall +
#     exec vicoop-client.
#
# Interactive wizard mode (no config + TTY available) lands in PR 2.
#
# This script is the PID-1 process under tini. It must `exec` the daemon
# at the end so signals reach the bridge client correctly.

set -euo pipefail

VICOOP_LIB="${VICOOP_LIB:-/usr/local/lib/vicoop-bridge}"
VICOOP_DATA="${VICOOP_DATA:-/data}"
VICOOP_HOME="${VICOOP_HOME:-$VICOOP_DATA}"
export VICOOP_HOME

# Bridge default URL — same value the bridge client hardcodes when no
# --server / config / env override is present. Kept duplicated here so
# the entrypoint can stub a config without booting the binary first.
DEFAULT_BRIDGE_URL="${VICOOP_BRIDGE_URL:-wss://vicoop-bridge-server.fly.dev}"

CONFIG="$VICOOP_DATA/config.json"

log()  { printf '[entrypoint] %s\n' "$*" >&2; }
die()  { log "ERROR: $*"; exit 1; }
die64(){ log "ERROR: $*"; exit 64; }

# --------------------------------------------------------------------------
# Headless setup: write config.json + install backend from env vars.
# Returns 0 on success, non-zero with a friendly message on missing input.
# --------------------------------------------------------------------------
bootstrap_from_env() {
    local missing=()
    [[ -n "${VICOOP_BRIDGE_TOKEN:-}" ]] || missing+=("VICOOP_BRIDGE_TOKEN")
    [[ -n "${VICOOP_AGENT_ID:-}"     ]] || missing+=("VICOOP_AGENT_ID")
    [[ -n "${VICOOP_BACKEND:-}"      ]] || missing+=("VICOOP_BACKEND")
    if [[ ${#missing[@]} -gt 0 ]]; then
        log "no /data/config.json and no TTY for an interactive setup."
        log "supply the headless bootstrap env vars (missing: ${missing[*]}) or"
        log "re-run with -it so the interactive wizard can take over (PR 2)."
        log ""
        log "minimum env set for headless bootstrap:"
        log "  -e VICOOP_BRIDGE_TOKEN=<your client token>"
        log "  -e VICOOP_AGENT_ID=<your agent id>"
        log "  -e VICOOP_BACKEND=<echo|claude|codex|openclaw>"
        log "  -e VICOOP_BRIDGE_URL=<wss://...>     (optional, default $DEFAULT_BRIDGE_URL)"
        log "backend-specific:"
        log "  -e CLAUDE_CODE_OAUTH_TOKEN=...        (when backend=claude)"
        log "  -e OPENAI_API_KEY=...                 (when backend=codex)"
        return 64
    fi

    case "$VICOOP_BACKEND" in
        echo|claude|codex|openclaw|vicoop-codex) ;;
        *) die64 "VICOOP_BACKEND=$VICOOP_BACKEND is not one of: echo claude codex openclaw vicoop-codex" ;;
    esac

    log "no config found — generating $CONFIG from env"
    mkdir -p "$VICOOP_DATA"
    local tmp
    tmp="$(mktemp "${CONFIG}.XXXXXX")"
    jq -n \
        --arg url   "$DEFAULT_BRIDGE_URL" \
        --arg token "$VICOOP_BRIDGE_TOKEN" \
        --arg id    "$VICOOP_AGENT_ID" \
        --arg bk    "$VICOOP_BACKEND" \
        '{server_url: $url, server_token: $token, agent_id: $id, backend: $bk}' \
        > "$tmp"
    mv "$tmp" "$CONFIG"
    chmod 600 "$CONFIG"

    # Install the backend if it's one we have a recipe for and isn't
    # already installed. This is the one place the entrypoint mutates
    # /data/agents — first-time bootstrap only. After config.json exists
    # the daemon-mode branch refuses to install (operator must invoke
    # install-backend.sh by hand).
    if backend_is_installable "$VICOOP_BACKEND"; then
        if ! backend_already_installed "$VICOOP_BACKEND"; then
            log "installing backend: $VICOOP_BACKEND"
            "$VICOOP_LIB/install-backend.sh" "$VICOOP_BACKEND"
        else
            log "backend $VICOOP_BACKEND already installed; skipping install"
        fi
    fi
}

backend_is_installable() {
    # Manifest membership is the contract — backends listed under
    # `.backends` have an install-backend.sh recipe; everything else is a
    # valid daemon choice with no install step (echo runs in-process,
    # openclaw's gateway runs out-of-process).
    local kind="$1"
    vicoop-client info \
      | jq -e --arg kind "$kind" '.backends | has($kind)' >/dev/null
}

backend_already_installed() {
    # Probe the recipe's expected binary directly — no installed.json
    # cache. Recipes that don't produce a binary (e.g. echo-style) are
    # always "installed" in the trivial sense.
    local kind="$1"
    local bin="$VICOOP_DATA/agents/$kind/bin/$kind"
    [[ -x "$bin" ]]
}

# --------------------------------------------------------------------------
# Daemon-mode compatibility check.
# Probes each installable backend's binary for its version and compares
# against the supportedRange `vicoop-client info` advertises. Empty
# probes / unbounded ranges are skipped.
# --------------------------------------------------------------------------
compat_check() {
    local info
    info="$(vicoop-client info)"

    local kinds kind range bin actual
    kinds="$(jq -r '.backends | keys[]' <<< "$info")"
    while IFS= read -r kind; do
        [[ -z "$kind" ]] && continue
        bin="$VICOOP_DATA/agents/$kind/bin/$kind"
        [[ -x "$bin" ]] || continue  # not installed -> nothing to check

        range="$(jq -r --arg k "$kind" '.backends[$k].supportedRange // empty' <<< "$info")"
        [[ -z "$range" || "$range" == "*" ]] && continue

        # Take the first whitespace-separated token from `<bin> --version`
        # as the semver. Recipes that don't print a semver get skipped.
        actual="$("$bin" --version 2>/dev/null | awk '{print $1; exit}' || true)"
        [[ -z "$actual" ]] && continue

        if ! node -e "
            const semver = require('semver');
            if (!semver.satisfies('$actual', '$range')) {
                process.exit(2);
            }
        " 2>/dev/null; then
            die64 "backend '$kind' version $actual is outside this image's supported range '$range'. To fix:
    docker exec <container> $VICOOP_LIB/install-backend.sh $kind@<version-in-range>
or pull a newer / older image whose supportedRange covers the installed version."
        fi
    done <<< "$kinds"
}

# --------------------------------------------------------------------------
# Optional firewall init. Requires NET_ADMIN; skipped (with a warning) if
# the container wasn't started with the right cap.
# --------------------------------------------------------------------------
maybe_init_firewall() {
    if [[ "${VICOOP_SKIP_FIREWALL:-0}" == "1" ]]; then
        log "VICOOP_SKIP_FIREWALL=1 — skipping init-firewall.sh"
        return 0
    fi
    if ! command -v iptables >/dev/null 2>&1; then
        log "WARN: iptables not present in PATH; skipping firewall"
        return 0
    fi
    if ! iptables -L >/dev/null 2>&1; then
        log "WARN: cannot read iptables (missing CAP_NET_ADMIN?); skipping firewall."
        log "      add '--cap-add NET_ADMIN --cap-add NET_RAW' to your run command"
        log "      to enable outbound-allowlist isolation."
        return 0
    fi
    log "applying init-firewall.sh"
    "$VICOOP_LIB/init-firewall.sh"
}

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
# Daemon mode is the bare invocation or flags-only. Subcommands like
# `info`, `upgrade`, `auth login` are passed through unchanged — operators
# need them to work whether or not config has been bootstrapped yet (e.g.
# `docker run ... vicoop-client info` for compat checks from outside).
is_daemon_invocation() {
    [[ $# -eq 0 ]] && return 0
    case "$1" in
        --*) return 0 ;;
        *)   return 1 ;;
    esac
}

if is_daemon_invocation "$@"; then
    if [[ ! -f "$CONFIG" ]]; then
        if [[ -t 0 && -t 1 ]]; then
            log "TTY detected but interactive wizard isn't shipped yet (PR 2)."
            log "use the headless env-bootstrap path for now — see below."
        fi
        bootstrap_from_env || exit $?
    else
        compat_check
    fi
    maybe_init_firewall
fi

# Hand off to the bridge client. exec replaces this shell so signals from
# tini reach vicoop-client directly (no double-process orphaning of agent
# CLI children).
exec vicoop-client "$@"
