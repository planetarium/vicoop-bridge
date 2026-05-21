#!/usr/bin/env bash
# Install / upgrade the claude code CLI into /data/agents/claude/.
#
# This script is sourced (or called) by container/install-backend.sh. It must
# define two functions and nothing else side-effecting at load time:
#
#   backend_install   <version|""> -> installs into $AGENT_DIR
#   backend_version                 -> prints currently installed version, or empty
#
# Anthropic recommends the native binary installer (the npm package was
# demoted to "advanced" — it ships the same native binary wrapped in a
# postinstall). We download the per-platform binary straight from
# downloads.claude.ai, verify its sha256 against the published manifest,
# and place it at $AGENT_DIR/bin/claude. No node runtime dependency on
# claude's behalf, no $HOME pollution, no `claude install` shell-PATH
# setup (we manage PATH ourselves via the image's ENV).

set -euo pipefail

CLAUDE_RELEASES_BASE="https://downloads.claude.ai/claude-code-releases"

backend_install() {
  # Default to `latest` rather than `stable` — Anthropic's own install.sh
  # downloads from the `latest` channel ("which has the most up-to-date
  # installer"), and container builds disable claude's auto-updater so a
  # `stable`-default would lag behind operator expectations. Operators
  # who want the conservative track can pass `claude@stable` explicitly.
  local requested="${1:-latest}"
  local version

  # Channel aliases ("stable", "latest") get resolved by fetching the
  # channel pointer first; concrete semvers (`X.Y.Z` or with pre-release
  # tag) are used as-is.
  case "$requested" in
    stable|latest)
      version="$(curl -fsSL "$CLAUDE_RELEASES_BASE/$requested")"
      if [[ -z "$version" ]]; then
        echo "claude.sh: could not resolve channel '$requested'" >&2
        return 1
      fi
      ;;
    *)
      version="$requested"
      ;;
  esac

  local arch
  case "$(uname -m)" in
    x86_64|amd64)  arch="x64"   ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      echo "claude.sh: unsupported arch $(uname -m)" >&2
      return 1
      ;;
  esac

  # The runtime image is debian-slim → glibc. Anthropic publishes both
  # `linux-<arch>` and `linux-<arch>-musl` variants; detect which one
  # this image needs so a future alpine-based variant still works.
  local platform="linux-${arch}"
  if ldd /bin/ls 2>&1 | grep -q musl; then
    platform="${platform}-musl"
  fi

  echo "claude.sh: installing version=$version platform=$platform" >&2

  local manifest checksum
  manifest="$(curl -fsSL "$CLAUDE_RELEASES_BASE/$version/manifest.json")"
  checksum="$(echo "$manifest" | jq -r --arg p "$platform" '.platforms[$p].checksum // empty')"
  if [[ -z "$checksum" ]] || [[ ! "$checksum" =~ ^[a-f0-9]{64}$ ]]; then
    echo "claude.sh: no checksum for platform $platform in manifest" >&2
    return 1
  fi

  mkdir -p "$AGENT_DIR/bin"
  local target="$AGENT_DIR/bin/claude"
  local tmp="${target}.new"

  curl -fsSL "$CLAUDE_RELEASES_BASE/$version/$platform/claude" -o "$tmp"

  local actual
  actual="$(sha256sum "$tmp" | awk '{print $1}')"
  if [[ "$actual" != "$checksum" ]]; then
    rm -f "$tmp"
    echo "claude.sh: sha256 mismatch (expected $checksum, got $actual)" >&2
    return 1
  fi

  chmod +x "$tmp"
  mv "$tmp" "$target"
}

backend_version() {
  local bin="$AGENT_DIR/bin/claude"
  if [[ ! -x "$bin" ]]; then
    return 0
  fi
  # claude --version prints "X.Y.Z (Claude Code)"; take the first token.
  "$bin" --version 2>/dev/null | awk '{print $1; exit}' || true
}
