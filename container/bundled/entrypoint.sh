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

        # Pull the first semver-shaped token out of `<bin> --version`.
        # Naive "first whitespace token" gets fooled by codex, which
        # prints `codex-cli 0.132.0` (program-name first, semver
        # second); claude prints `2.1.146 (Claude Code)` (semver
        # leads) and works either way. The pattern also tolerates
        # pre-release / build suffixes (`X.Y.Z-rc.1`, `X.Y.Z+sha`).
        # Recipes that don't print a semver-shaped token at all get
        # skipped.
        actual="$("$bin" --version 2>/dev/null \
            | grep -oE '[0-9]+\.[0-9]+\.[0-9]+([-+][[:alnum:].-]+)?' \
            | head -n1 \
            || true)"
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
# Interactive wizard: TTY-only first-time setup.
#
# Triggered when:
#   - no /data/config.json
#   - no headless env-token (VICOOP_BRIDGE_TOKEN etc. unset — we don't
#     want to surprise an operator who *meant* to do env-bootstrap and
#     only fat-fingered one variable)
#   - stdin AND stdout are both TTY
#
# Composition:
#   1. `vicoop-client auth login` — Google device-flow OAuth against
#      the bridge. URL + code print to the operator's terminal; the
#      client polls until they finish.
#   2. Prompt for backend kind + agent id (default agent id =
#      `hostname` so an operator who just hits enter still gets a
#      valid registration).
#   3. `vicoop-client agent register --agent-id <id>` — mints the
#      one-time AGENT_TOKEN and writes server_url/server_token/agent_id
#      into config.json. We then patch the `backend` field with the
#      prompt result (agent register doesn't take a backend arg).
#   4. For installable backends (claude / codex), run install-backend.sh
#      and then invoke the native OAuth (`claude auth login --claudeai` /
#      `codex login --device-auth`) inline. Operator's TTY is inherited
#      by the child, so the URL+code flow lands on their terminal
#      directly.
#   5. Return to main, which proceeds into the daemon `exec` below —
#      same image, same `docker run`, just with config.json + creds
#      written by the wizard.
# --------------------------------------------------------------------------
wizard() {
    log ""
    log "=== vicoop-bridge first-time setup ==="
    log "No config detected and a TTY is attached, so I'll walk you through it."

    log ""
    log "--- Step 1/3: bridge owner sign-in ---"
    vicoop-client auth login || die "auth login failed"

    log ""
    log "--- Step 2/3: pick a backend + agent id ---"
    log ""
    log "The agent id is the routing key external A2A callers will use"
    log "to reach this daemon. Pick something memorable (alphanumeric +"
    log "dashes are safe)."
    log ""
    local agent_id=""
    while [[ -z "${agent_id// }" ]]; do
        read -rp "  Agent ID: " agent_id
        if [[ -z "${agent_id// }" ]]; then
            log "  Agent ID cannot be empty."
        fi
    done

    log ""
    log "Available backends:"
    # We render two parallel arrays — `options` is what operators see,
    # `kinds` is what we feed to install-backend.sh and write into
    # config.json. Hand-rolled rather than `select` because bash's
    # builtin reflows long labels into multiple columns, which mangles
    # the alignment we want here.
    local options=(
        "claude       - Anthropic Claude Code CLI"
        "codex        - OpenAI Codex CLI"
        "echo         - in-process echo (testing only; no LLM)"
        "openclaw     - external OpenClaw gateway"
        "vicoop-codex - codex via vicoop's traceability bridge"
    )
    local kinds=(claude codex echo openclaw vicoop-codex)
    local i
    for i in "${!options[@]}"; do
        printf '  %d) %s\n' "$((i + 1))" "${options[$i]}" >&2
    done
    printf '\n' >&2

    local backend="" reply
    while true; do
        read -rp "  Pick a backend [1-${#options[@]}]: " reply
        if [[ "$reply" =~ ^[0-9]+$ ]] && (( reply >= 1 && reply <= ${#options[@]} )); then
            backend="${kinds[$((reply - 1))]}"
            break
        fi
        log "  Invalid; enter a number from 1 to ${#options[@]}."
    done

    log ""
    vicoop-client agent register --agent-id "$agent_id" \
        || die "agent register failed"

    # `agent register` writes server_url / server_token / agent_id;
    # the `backend` field is ours to set from the prompt. jq edit
    # in-place via tmp + rename to preserve mode 600.
    local tmp
    tmp="$(mktemp "${CONFIG}.XXXXXX")"
    jq --arg b "$backend" '. + {backend: $b}' "$CONFIG" > "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$CONFIG"

    log ""
    log "--- Step 3/3: backend install + sign-in ---"
    if backend_is_installable "$backend"; then
        "$VICOOP_LIB/install-backend.sh" "$backend"
        local bin="$VICOOP_DATA/agents/$backend/bin/$backend"
        case "$backend" in
            claude)
                log "Running \`claude auth login --claudeai\` — follow the URL it prints"
                log "  and complete the Claude subscription login flow:"
                "$bin" auth login --claudeai \
                    || die "claude auth login failed"
                ;;
            codex)
                log "Running \`codex login --device-auth\` — open the URL it prints"
                log "  and complete the device-flow code:"
                "$bin" login --device-auth \
                    || die "codex login --device-auth failed"
                ;;
        esac
    else
        log "Backend '$backend' has no install step; skipping."
    fi

    log ""
    log "Setup complete. Starting daemon..."
    log "(Future starts skip the wizard since config.json is now on the data volume."
    log " Re-run with the volume mounted to keep your sign-in.)"
    log ""
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

# Only fall into the wizard when the operator clearly hasn't tried
# headless yet. If they set even one of the env-token vars we assume
# headless intent and let bootstrap_from_env emit its usual error
# with the missing-var list, rather than launching a wizard that
# might overwrite their setup mid-flow.
has_any_env_token() {
    [[ -n "${VICOOP_BRIDGE_TOKEN:-}" ]] \
        || [[ -n "${VICOOP_AGENT_ID:-}" ]] \
        || [[ -n "${VICOOP_BACKEND:-}" ]]
}

if is_daemon_invocation "$@"; then
    if [[ ! -f "$CONFIG" ]]; then
        if [[ -t 0 && -t 1 ]] && ! has_any_env_token; then
            wizard
        else
            bootstrap_from_env || exit $?
        fi
    else
        compat_check
    fi
    maybe_init_firewall
fi

# Hand off to the bridge client. exec replaces this shell so signals from
# tini reach vicoop-client directly (no double-process orphaning of agent
# CLI children).
exec vicoop-client "$@"
