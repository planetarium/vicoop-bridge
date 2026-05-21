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
INSTALLED="$VICOOP_DATA/installed.json"

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
        log "re-run with -it so the interactive wizard can take over."
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
    local kind="$1"
    [[ -f "$INSTALLED" ]] || return 1
    jq -e --arg kind "$kind" '.[$kind].version // empty' "$INSTALLED" >/dev/null
}

# --------------------------------------------------------------------------
# Daemon-mode compatibility check.
# Compares /data/installed.json against `vicoop-client info` for every
# backend that has both a recorded version and a supportedRange.
# --------------------------------------------------------------------------
compat_check() {
    [[ -f "$INSTALLED" ]] || return 0  # nothing recorded yet — nothing to check
    local info installed
    info="$(vicoop-client info)"
    installed="$(cat "$INSTALLED")"

    # For every <kind> in installed.json: read its version, look up its
    # supportedRange in info, and ask node's semver to compare. We shell
    # out to node because the alpine-style `semver` CLI isn't installed
    # by default; node is in this image regardless of whether bun is.
    local kinds kind version range
    kinds="$(jq -r 'keys[]' <<< "$installed")"
    while IFS= read -r kind; do
        [[ -z "$kind" ]] && continue
        version="$(jq -r --arg k "$kind" '.[$k].version // empty' <<< "$installed")"
        range="$(jq   -r --arg k "$kind" '.backends[$k].supportedRange // empty' <<< "$info")"
        if [[ -z "$version" || -z "$range" || "$range" == "*" ]]; then
            continue
        fi
        if ! node -e "
            const semver = require('semver');
            if (!semver.satisfies('$version', '$range')) {
                process.exit(2);
            }
        " 2>/dev/null; then
            die64 "backend '$kind' version $version is outside this image's supported range '$range'. To fix:
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
# Interactive wizard. Triggered when no config exists AND stdin/stdout are
# both TTYs (i.e. operator launched with `docker run -it`).
#
# Walks through:
#   1. bridge sign-in (vicoop-client auth login — Google OAuth device flow)
#   2. agent identity prompts (name / id / backend) + agent register
#   3. backend install (if a recipe exists) + backend OAuth (if no env
#      token already covers it).
#
# Wizard EXITS 0 on success. It does NOT transition into daemon mode —
# the operator (or install-container.sh wrapper) starts the daemon
# separately with `docker run -d ...`. Splitting the two phases keeps
# the wrapper simple and lets manual invokers do their own thing after
# setup completes.
# --------------------------------------------------------------------------
wizard() {
    printf '\n'
    log '====================================================='
    log '  vicoop-bridge — first-time setup'
    log '====================================================='
    printf '\n'

    log 'step 1 of 3 — bridge sign-in (Google OAuth device flow)'
    log 'a URL + user code will print below; open the URL in any browser.'
    printf '\n'
    if ! vicoop-client auth login; then
        die "auth login failed"
    fi

    printf '\n'
    log 'step 2 of 3 — agent registration'
    local agent_name agent_id backend_kind
    read -r -p '  Agent name (e.g. my-claude): ' agent_name
    read -r -p '  Agent id  (lowercase, hyphen-allowed): ' agent_id
    log    '  Backends:'
    log    '    echo       — smoke test, no LLM'
    log    '    claude     — Anthropic Claude Code'
    log    '    codex      — OpenAI Codex'
    log    '    openclaw   — connects to an external openclaw gateway'
    read -r -p '  Backend: ' backend_kind

    if [[ -z "$agent_name" || -z "$agent_id" || -z "$backend_kind" ]]; then
        die "all three prompts are required; re-run when ready"
    fi
    case "$backend_kind" in
        echo|claude|codex|openclaw|vicoop-codex) ;;
        *) die64 "backend '$backend_kind' is not one of: echo claude codex openclaw vicoop-codex" ;;
    esac

    if ! vicoop-client agent register --name "$agent_name" --agent-id "$agent_id"; then
        die "agent register failed"
    fi
    # `agent register` writes server_url + server_token + agent_id into
    # config.json. Inject the operator's backend choice — daemon flag /
    # config field that `agent register` doesn't set.
    local tmp
    tmp="$(mktemp "${CONFIG}.XXXXXX")"
    jq --arg bk "$backend_kind" '.backend = $bk' "$CONFIG" > "$tmp"
    mv "$tmp" "$CONFIG"
    chmod 600 "$CONFIG"

    printf '\n'
    log "step 3 of 3 — backend setup ($backend_kind)"
    if backend_is_installable "$backend_kind"; then
        "$VICOOP_LIB/install-backend.sh" "$backend_kind"
        printf '\n'

        case "$backend_kind" in
            claude)
                if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
                    log 'claude auth: CLAUDE_CODE_OAUTH_TOKEN provided via env; skipping interactive login.'
                elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
                    log 'claude auth: ANTHROPIC_API_KEY provided via env; skipping interactive login.'
                else
                    log 'claude auth login — a URL will print; open it, then paste the code back here.'
                    if ! "$VICOOP_DATA/agents/claude/bin/claude" auth login --claudeai; then
                        die "claude auth login failed; re-run wizard or run it manually via docker exec"
                    fi
                fi
                ;;
            codex)
                if [[ -n "${OPENAI_API_KEY:-}" ]]; then
                    log 'codex auth: OPENAI_API_KEY provided via env; skipping interactive login.'
                else
                    log 'codex login — a URL will print; open it, then paste the code back here.'
                    if ! "$VICOOP_DATA/agents/codex/bin/codex" login; then
                        die "codex login failed; re-run wizard or run it manually via docker exec"
                    fi
                fi
                ;;
        esac
    else
        log "no image-side install step for '$backend_kind' (gateway / built-in / non-installable)."
        log "  echo / openclaw / vicoop-codex are valid daemon backends but skip the install step."
    fi

    printf '\n'
    log '====================================================='
    log '  setup complete'
    log '====================================================='
    log ''
    log 'config written to /data/config.json; tokens + creds in /data.'
    log 'start the daemon container:'
    log ''
    log "    docker run -d --restart unless-stopped \\"
    log "      --name vicoop-bridge \\"
    log "      -v vicoop-data:/data \\"
    log "      -v vicoop-work:/home/node/work \\"
    log "      --cap-add NET_ADMIN --cap-add NET_RAW \\"
    log "      ghcr.io/planetarium/vicoop-bridge-client"
    log ''
    log '(or just re-run install-container.sh — it picks up from here.)'
    printf '\n'
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
            # Interactive wizard. Exits 0 on success and we exit too —
            # daemon-mode is a separate `docker run -d ...` (or the
            # install-container.sh wrapper handles it).
            wizard
            exit 0
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
