#!/usr/bin/env bash
# Install / upgrade an agent CLI backend into /data/agents/<kind>/.
#
# Usage:
#   install-backend.sh <kind>[@<version>]
#   install-backend.sh <kind> --version <version>
#
# The dispatch table simply maps <kind> -> backends/<kind>.sh; each recipe
# is sourced into this shell and provides `backend_install <version>`.
# After install we record the resolved version in /data/installed.json so
# the entrypoint can compare it against `vicoop-client info`'s
# supportedRange on subsequent boots.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  install-backend.sh <kind>[@<version>]
  install-backend.sh <kind> --version <version>

Backends covered by this image: claude, codex.
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 64
fi

SPEC="$1"; shift

VERSION=""
KIND=""
case "$SPEC" in
  *@*)
    KIND="${SPEC%@*}"
    VERSION="${SPEC#*@}"
    ;;
  *)
    KIND="$SPEC"
    ;;
esac

# `--version <X>` flag form survives copying from setup snippets that mix
# in extra arguments.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="${2-}"
      shift 2
      ;;
    *)
      echo "install-backend.sh: unexpected argument: $1" >&2
      usage
      exit 64
      ;;
  esac
done

if [[ -z "$KIND" ]]; then
  usage
  exit 64
fi

VICOOP_LIB="${VICOOP_LIB:-/usr/local/lib/vicoop-bridge}"
RECIPE="$VICOOP_LIB/backends/$KIND.sh"
if [[ ! -f "$RECIPE" ]]; then
  echo "install-backend.sh: no recipe for backend '$KIND' (looked at $RECIPE)" >&2
  echo "known backends: $(ls "$VICOOP_LIB/backends" 2>/dev/null | sed -e 's/\.sh$//' | tr '\n' ' ' || true)" >&2
  exit 1
fi

VICOOP_DATA="${VICOOP_DATA:-/data}"
AGENT_DIR="$VICOOP_DATA/agents/$KIND"
mkdir -p "$AGENT_DIR"

# Make $AGENT_DIR visible to the recipe so each one writes to the same
# canonical location without re-deriving it.
export AGENT_DIR

echo "==> installing $KIND${VERSION:+@$VERSION} into $AGENT_DIR" >&2
# shellcheck source=/dev/null
. "$RECIPE"
backend_install "$VERSION"

# Probe the installed binary for its actual version (claude's `stable`
# / `latest` aliases and npm@latest both leave us guessing otherwise).
# Empty result is acceptable for recipes that don't expose a binary.
INSTALLED_VERSION="$(backend_version)"
echo "==> installed: $KIND ${INSTALLED_VERSION:-(no version)}" >&2

# Update /data/installed.json. We rewrite it atomically so a partial write
# during a crash doesn't leave a half-record the entrypoint reads at next
# boot.
MANIFEST="$VICOOP_DATA/installed.json"
TMP="$(mktemp "${MANIFEST}.XXXXXX")"
# Preserve other backends' entries; only mutate the entry for $KIND.
if [[ -f "$MANIFEST" ]]; then
  jq --arg kind "$KIND" --arg ver "$INSTALLED_VERSION" --arg ts "$(date -u +%FT%TZ)" \
    '.[$kind] = {version: $ver, installedAt: $ts}' "$MANIFEST" > "$TMP"
else
  jq -n --arg kind "$KIND" --arg ver "$INSTALLED_VERSION" --arg ts "$(date -u +%FT%TZ)" \
    '{($kind): {version: $ver, installedAt: $ts}}' > "$TMP"
fi
mv "$TMP" "$MANIFEST"
echo "==> $MANIFEST updated" >&2
