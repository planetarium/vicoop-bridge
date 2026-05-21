#!/usr/bin/env bash
# Install / upgrade the claude code CLI into /data/agents/claude/.
#
# This script is sourced (or called) by image/install-backend.sh. It must
# define two functions and nothing else side-effecting at load time:
#
#   backend_install   <version|""> -> installs into $AGENT_DIR
#   backend_version                 -> prints currently installed version, or empty
#
# The agent CLI is installed under a self-contained npm prefix
# (`/data/agents/claude/.npm-global`) so an `npm install -g` lands inside
# /data, not the system. The compiled binary is exposed via the wrapper
# `$AGENT_DIR/bin/claude`.

set -euo pipefail

backend_install() {
  local version="${1-}"
  local pkg="@anthropic-ai/claude-code"
  local spec="$pkg"
  if [[ -n "$version" ]]; then
    spec="$pkg@$version"
  fi

  mkdir -p "$AGENT_DIR/.npm-global"
  npm_config_prefix="$AGENT_DIR/.npm-global" npm install -g --no-audit --no-fund "$spec" >&2

  # Wrapper indirection: `npm install -g` plants `claude` under
  # $prefix/bin/claude. We expose it at $AGENT_DIR/bin/claude so the
  # entrypoint's PATH (which lists /data/agents/<kind>/bin) finds a stable
  # path regardless of npm's internal layout changes.
  mkdir -p "$AGENT_DIR/bin"
  cat > "$AGENT_DIR/bin/claude" <<'EOF'
#!/usr/bin/env bash
exec "$(dirname "$0")/../.npm-global/bin/claude" "$@"
EOF
  chmod +x "$AGENT_DIR/bin/claude"
}

backend_version() {
  local bin="$AGENT_DIR/bin/claude"
  if [[ ! -x "$bin" ]]; then
    return 0
  fi
  # claude prints "X.Y.Z (Claude Code)" — first whitespace-separated token
  # is the semver. Drop anything we don't recognize so callers can pipe
  # this through semver checks without further parsing.
  "$bin" --version 2>/dev/null | awk '{print $1; exit}' || true
}
