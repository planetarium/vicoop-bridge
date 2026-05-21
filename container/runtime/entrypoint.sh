#!/usr/bin/env bash
# vicoop-runtime entrypoint — external-runtime profile (#249).
#
# Body: optional firewall init, then `sleep infinity`. The container is
# an idle sandbox; every real action (install-backend, agent spawn,
# version probe) is invoked from outside via `docker exec` by the host
# bridge client.
#
# Contrast with container/bundled/entrypoint.sh, which runs the bridge
# client daemon at the end. Here the bridge client is on the host.

set -euo pipefail

VICOOP_LIB="${VICOOP_LIB:-/usr/local/lib/vicoop-bridge}"

log() { printf '[runtime] %s\n' "$*" >&2; }

# Same graceful-degrade pattern as container/bundled/entrypoint.sh:
# missing CAP_NET_ADMIN logs a warning and skips the firewall rather
# than failing boot, so an operator can iterate locally without the
# cap while still seeing a clear hint about how to enable isolation.
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

maybe_init_firewall

log "sandbox ready — sleeping until docker stop"
exec sleep infinity
