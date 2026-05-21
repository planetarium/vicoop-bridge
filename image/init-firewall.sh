#!/usr/bin/env bash
# Outbound-allowlist firewall for the vicoop-bridge container.
#
# Ported from Anthropic's claude-code reference devcontainer (their
# .devcontainer/init-firewall.sh). Adapted for vicoop-bridge's allowlist:
#
#   - bridge server (`$VICOOP_BRIDGE_URL`, default the official deployment)
#   - LLM provider APIs (Anthropic, OpenAI)
#   - npm registry + GitHub (agent CLI install/upgrade)
#
# Inbound: zero. The bridge client only ever speaks outbound (WS to the
# bridge server), so we don't allowlist any incoming ports. The container
# inherits the runtime's default-no-inbound-port behaviour; this script
# just locks the outbound side down.
#
# Operators who need to extend the allowlist (e.g. a self-hosted LLM
# endpoint, a private npm mirror) can append to `EXTRA_ALLOW_DOMAINS`
# via the `VICOOP_EXTRA_ALLOW_DOMAINS` env var (space-separated FQDNs).

set -euo pipefail
IFS=$'\n\t'

# Preserve Docker's embedded DNS NAT rules before we flush, so resolving
# `*.fly.dev` etc. still goes through 127.0.0.11.
DOCKER_DNS_RULES=$(iptables-save -t nat 2>/dev/null | grep "127\.0\.0\.11" || true)

# Flush everything else
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
ipset destroy vicoop-allowed 2>/dev/null || true

# Restore Docker DNS
if [ -n "$DOCKER_DNS_RULES" ]; then
    echo "[firewall] restoring docker DNS rules"
    iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
    iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
    echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
fi

# DNS (UDP), loopback, established responses — needed before we lock the
# default OUTPUT policy.
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A INPUT  -p udp --sport 53 -j ACCEPT
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# Allowlist as a single ipset — easier to extend than per-rule entries.
ipset create vicoop-allowed hash:net

# GitHub IP ranges (web + api + git) — needed for `npm install` of any
# package hosted via codeload and for `gh` API calls in install recipes.
echo "[firewall] fetching github IP ranges"
GH_RANGES=$(curl -fsSL https://api.github.com/meta) || {
    echo "[firewall] ERROR: failed to fetch github meta" >&2
    exit 1
}
if ! echo "$GH_RANGES" | jq -e '.web and .api and .git' >/dev/null; then
    echo "[firewall] ERROR: github meta missing fields" >&2
    exit 1
fi
while read -r cidr; do
    if [[ ! "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]]; then
        echo "[firewall] WARN: skipping non-IPv4 CIDR from github: $cidr" >&2
        continue
    fi
    ipset add vicoop-allowed "$cidr" 2>/dev/null || true
done < <(echo "$GH_RANGES" | jq -r '(.web + .api + .git)[]')

# Resolve and add FQDN allowlist. `dig` may return multiple A records;
# add them all.
add_domain() {
    local domain="$1"
    local ips
    ips=$(dig +noall +answer +short A "$domain" 2>/dev/null || true)
    if [ -z "$ips" ]; then
        echo "[firewall] ERROR: could not resolve $domain" >&2
        return 1
    fi
    while read -r ip; do
        [[ -z "$ip" ]] && continue
        if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
            continue
        fi
        ipset add vicoop-allowed "$ip" 2>/dev/null || true
    done <<< "$ips"
}

# Default allowlist. Bridge server is parsed out of $VICOOP_BRIDGE_URL
# (set by the operator or defaulted by entrypoint.sh).
BRIDGE_HOST=""
if [ -n "${VICOOP_BRIDGE_URL:-}" ]; then
    # Strip scheme and any path/query so we get a bare hostname for `dig`.
    BRIDGE_HOST=$(echo "$VICOOP_BRIDGE_URL" | sed -E 's#^[a-z]+://##; s#/.*$##; s#:.*$##')
fi

# Required allowlist. If any of these don't resolve, refuse to start — the
# daemon would just fail later with a less-actionable error.
DEFAULT_ALLOW_DOMAINS=(
    "registry.npmjs.org"
    "api.anthropic.com"
    "api.openai.com"
    "github.com"
    "objects.githubusercontent.com"
    "codeload.github.com"
)
if [ -n "$BRIDGE_HOST" ]; then
    DEFAULT_ALLOW_DOMAINS+=("$BRIDGE_HOST")
fi

# Operator-supplied extensions (space-separated env var). Used for
# self-hosted LLM endpoints, private mirrors, etc.
EXTRA_ALLOW_DOMAINS=()
if [ -n "${VICOOP_EXTRA_ALLOW_DOMAINS:-}" ]; then
    # shellcheck disable=SC2206
    EXTRA_ALLOW_DOMAINS=($VICOOP_EXTRA_ALLOW_DOMAINS)
fi

for d in "${DEFAULT_ALLOW_DOMAINS[@]}" "${EXTRA_ALLOW_DOMAINS[@]}"; do
    echo "[firewall] resolving $d"
    add_domain "$d"
done

# Allow the docker host network (e.g. `host.docker.internal`). This is
# what lets the operator run the bridge server locally and point the
# client at it. Detected from the default route.
HOST_IP=$(ip route 2>/dev/null | awk '/default/ {print $3; exit}' || true)
if [ -n "$HOST_IP" ]; then
    HOST_NET=$(echo "$HOST_IP" | sed -E 's#\.[0-9]+$#.0/24#')
    iptables -A INPUT  -s "$HOST_NET" -j ACCEPT
    iptables -A OUTPUT -d "$HOST_NET" -j ACCEPT
fi

# Default-DROP everything else, then re-ACCEPT established responses and
# matches against the allowlist set.
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

iptables -A INPUT  -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

iptables -A OUTPUT -m set --match-set vicoop-allowed dst -j ACCEPT
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

echo "[firewall] configuration complete"

# Cheap smoke check: an unrelated hostname must fail, github must succeed.
if curl --connect-timeout 5 -sf https://example.com >/dev/null 2>&1; then
    echo "[firewall] ERROR: rule check failed — was able to reach example.com" >&2
    exit 1
fi
if ! curl --connect-timeout 5 -sf https://api.github.com/zen >/dev/null 2>&1; then
    echo "[firewall] ERROR: rule check failed — could not reach api.github.com" >&2
    exit 1
fi
echo "[firewall] smoke check passed"
