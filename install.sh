#!/usr/bin/env sh
# install.sh — vicoop-bridge-client one-line installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/planetarium/vicoop-bridge/main/install.sh | sh
#
# Environment overrides:
#   INSTALL_DIR   Target directory (default: /data/vicoop-bridge-client)
#   VERSION       Specific tag to install, e.g. client-v0.1.0 (default: latest client-v* release)
#   FORCE         If "1", overwrite a non-empty INSTALL_DIR
#   GITHUB_TOKEN  Required while the repo is private; PAT with `repo` read scope
#
# What it does:
#   1. Verifies prerequisites (Linux warning, Node.js >= 20, curl, tar, sha256 tool).
#   2. Resolves the latest (or pinned) client-v* GitHub release.
#   3. Downloads the .tgz + .sha256 and verifies integrity.
#   4. Extracts the bundle into INSTALL_DIR.
#   5. Prints next-step instructions. Does NOT start the process or write a card.json
#      (the agent that owns this client is expected to generate and place card.json).

set -eu

REPO="planetarium/vicoop-bridge"
INSTALL_DIR="${INSTALL_DIR:-/data/vicoop-bridge-client}"
VERSION="${VERSION:-}"
FORCE="${FORCE:-0}"

log() { printf '==> %s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

# ---- 1. Prerequisites -------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Linux) ;;
  *) log "warning: this installer targets Linux (Fly.io containers); detected $OS — proceeding anyway" ;;
esac

need curl
need tar
need node

NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node.js >= 20 required (found $(node -v))"
fi

if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
else
  die "missing required command: sha256sum or shasum"
fi

# curl wrapper that injects the GitHub PAT when present. curl strips the
# Authorization header on cross-host redirects (default since 7.58), which is
# what we want for asset downloads that redirect to objects.githubusercontent.com.
gh_curl() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$@"
  else
    curl -fsSL "$@"
  fi
}

# ---- 2. Resolve release tag -------------------------------------------------
if [ -z "$VERSION" ]; then
  log "resolving latest client-v* release from GitHub"
  # Pull recent releases (default 30) and pick the first tag matching client-v*.
  # Avoid /releases/latest because it may point at a non-client release.
  VERSION="$(
    gh_curl "https://api.github.com/repos/$REPO/releases?per_page=30" \
      | grep -o '"tag_name":[[:space:]]*"client-v[^"]*"' \
      | head -n1 \
      | sed -E 's/.*"(client-v[^"]+)".*/\1/'
  )"
  [ -n "$VERSION" ] || die "no client-v* release found in $REPO (set GITHUB_TOKEN if the repo is private)"
fi

log "installing $VERSION"

VERSION_NUM="${VERSION#client-v}"
ARCHIVE="vicoop-bridge-client-$VERSION_NUM.tgz"
CHECKSUM="$ARCHIVE.sha256"
BASE_URL="https://github.com/$REPO/releases/download/$VERSION"

# ---- 3. Prepare install dir -------------------------------------------------
PARENT_DIR="$(dirname "$INSTALL_DIR")"
[ -d "$PARENT_DIR" ] || die "parent directory does not exist: $PARENT_DIR (create the volume mount first)"

if [ -e "$INSTALL_DIR" ]; then
  if [ "$FORCE" = "1" ]; then
    log "FORCE=1 — removing existing $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
  elif [ -d "$INSTALL_DIR" ] && [ -z "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    : # empty directory — fine
  else
    die "$INSTALL_DIR already exists and is not empty (rerun with FORCE=1 to overwrite)"
  fi
fi

mkdir -p "$INSTALL_DIR"

# ---- 4. Download + verify + extract ----------------------------------------
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

log "downloading $ARCHIVE"
gh_curl "$BASE_URL/$ARCHIVE" -o "$TMP_DIR/$ARCHIVE"
gh_curl "$BASE_URL/$CHECKSUM" -o "$TMP_DIR/$CHECKSUM"

log "verifying checksum"
# The .sha256 file from package-client-release.sh contains an absolute path from
# the build host. Rewrite it to reference the local archive name before checking.
EXPECTED_HASH="$(awk '{print $1}' "$TMP_DIR/$CHECKSUM")"
[ -n "$EXPECTED_HASH" ] || die "could not parse expected hash from $CHECKSUM"
printf '%s  %s\n' "$EXPECTED_HASH" "$ARCHIVE" > "$TMP_DIR/$CHECKSUM"
( cd "$TMP_DIR" && $SHA_CMD -c "$CHECKSUM" >/dev/null ) || die "checksum verification failed"

log "extracting into $INSTALL_DIR"
# Bundle root inside the archive is vicoop-bridge-client-<version>/; strip it
# so files land directly in INSTALL_DIR.
tar -xzf "$TMP_DIR/$ARCHIVE" -C "$INSTALL_DIR" --strip-components=1

chmod +x "$INSTALL_DIR/bin/vicoop-client" 2>/dev/null || true

# ---- 5. Next steps ----------------------------------------------------------
cat <<EOF

==> installed $VERSION to $INSTALL_DIR

Next steps (the agent that owns this client should perform these):

  1. Write an agent card to $INSTALL_DIR/card.json
  2. Obtain a token from the vicoop-bridge-server admin agent (register_client tool)
  3. Run:

       $INSTALL_DIR/bin/vicoop-client \\
         --server <wss://your-server-host> \\
         --token <YOUR_TOKEN> \\
         --agentId <your-agent-id> \\
         --card $INSTALL_DIR/card.json \\
         --backend openclaw

EOF
