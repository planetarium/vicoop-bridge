#!/usr/bin/env bash
# Install / upgrade the codex CLI into /data/agents/codex/.
#
# Same contract as backends/claude.sh — defines backend_install and
# backend_version. codex ships as an npm package (@openai/codex) plus a
# native binary; we use the npm distribution for parity with the claude
# recipe (one install mechanism keeps the recipe set legible).

set -euo pipefail

backend_install() {
  local version="${1-}"
  local pkg="@openai/codex"
  local spec="$pkg"
  if [[ -n "$version" ]]; then
    spec="$pkg@$version"
  fi

  mkdir -p "$AGENT_DIR/.npm-global"
  npm_config_prefix="$AGENT_DIR/.npm-global" npm install -g --no-audit --no-fund "$spec" >&2

  mkdir -p "$AGENT_DIR/bin"
  cat > "$AGENT_DIR/bin/codex" <<'EOF'
#!/usr/bin/env bash
exec "$(dirname "$0")/../.npm-global/bin/codex" "$@"
EOF
  chmod +x "$AGENT_DIR/bin/codex"
}

backend_version() {
  local bin="$AGENT_DIR/bin/codex"
  if [[ ! -x "$bin" ]]; then
    return 0
  fi
  # codex prints "codex-cli X.Y.Z" — take the version token. Drop anything
  # that doesn't look like a semver-ish string.
  "$bin" --version 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i ~ /^[0-9]+\.[0-9]+/) {print $i; exit}}' || true
}
