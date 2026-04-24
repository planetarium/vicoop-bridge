#!/usr/bin/env sh
# install.sh — vicoop-bridge-client one-line installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/planetarium/vicoop-bridge/main/install.sh | sh
#
# Environment overrides:
#   INSTALL_DIR           Target directory (default: /data/vicoop-bridge-client)
#   VERSION               Specific tag to install, e.g. client-v0.1.0 (default: latest client-v* release)
#   FORCE                 If "1", overwrite a non-empty INSTALL_DIR
#   INSTALL_SKIP_SERVICE  If "1", skip systemd unit registration
#   INSTALL_SERVICE_SCOPE Override detection: "auto" | "user" | "system" | "none" (default: auto)
#
# What it does:
#   1. Verifies prerequisites (Linux warning, Node.js >= 20, curl, tar, sha256 tool).
#   2. Resolves the latest (or pinned) client-v* GitHub release.
#   3. Downloads the .tgz + .sha256 and verifies integrity.
#   4. Extracts the bundle into INSTALL_DIR.
#   5. On systemd hosts, drops a vicoop-client.service unit + env template
#      (does NOT enable/start — the owner must populate env first).
#   6. Prints next-step instructions. Does NOT write a card.json
#      (the agent that owns this client is expected to generate and place card.json).

set -eu

REPO="planetarium/vicoop-bridge"
INSTALL_DIR="${INSTALL_DIR:-/data/vicoop-bridge-client}"
VERSION="${VERSION:-}"
FORCE="${FORCE:-0}"
INSTALL_SKIP_SERVICE="${INSTALL_SKIP_SERVICE:-0}"
INSTALL_SERVICE_SCOPE="${INSTALL_SERVICE_SCOPE:-auto}"

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

# ---- 2. Resolve release tag -------------------------------------------------
if [ -z "$VERSION" ]; then
  log "resolving latest client-v* release from GitHub"
  # Pull recent releases (default 30) and pick the first tag matching client-v*.
  # Avoid /releases/latest because it may point at a non-client release.
  VERSION="$(
    curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30" \
      | grep -o '"tag_name":[[:space:]]*"client-v[^"]*"' \
      | head -n1 \
      | sed -E 's/.*"(client-v[^"]+)".*/\1/'
  )"
  [ -n "$VERSION" ] || die "no client-v* release found in $REPO"
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
curl -fsSL "$BASE_URL/$ARCHIVE" -o "$TMP_DIR/$ARCHIVE"
curl -fsSL "$BASE_URL/$CHECKSUM" -o "$TMP_DIR/$CHECKSUM"

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

# ---- 5. Optional systemd service registration -------------------------------
# The unit reads config from an EnvironmentFile (k3s-style) so the operator can
# populate secrets after install without editing the unit itself. We never
# overwrite an existing env file — the unit file is regenerated on every run.
SERVICE_INSTALLED=""
SERVICE_ENABLE_CMD=""
SERVICE_ENV_FILE=""

resolve_service_scope() {
  if [ "$INSTALL_SKIP_SERVICE" = "1" ] || [ "$INSTALL_SERVICE_SCOPE" = "none" ]; then
    echo none
    return
  fi

  case "$INSTALL_SERVICE_SCOPE" in
    user|system) echo "$INSTALL_SERVICE_SCOPE"; return ;;
    auto) ;;
    *) log "warning: unknown INSTALL_SERVICE_SCOPE='$INSTALL_SERVICE_SCOPE', falling back to auto" ;;
  esac

  # systemd must be the init (PID 1) — otherwise systemctl may exist but the
  # unit will never actually run (common in Docker, WSL1, macOS with homebrew).
  command -v systemctl >/dev/null 2>&1 || { echo none; return; }
  [ -d /run/systemd/system ] || { echo none; return; }

  if [ "$(id -u)" = "0" ]; then
    echo system
  else
    echo user
  fi
}

install_service() {
  scope="$1"
  bin_path="$INSTALL_DIR/bin/vicoop-client"

  case "$scope" in
    system)
      unit_dir="/etc/systemd/system"
      env_file="/etc/vicoop-client.env"
      env_ref="$env_file"
      want="multi-user.target"
      SERVICE_ENABLE_CMD="sudo systemctl enable --now vicoop-client"
      ;;
    user)
      [ -n "${HOME:-}" ] || { log "warning: HOME unset — skipping service registration"; return; }
      unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
      env_file="${XDG_CONFIG_HOME:-$HOME/.config}/vicoop-client.env"
      env_ref="$env_file"
      want="default.target"
      SERVICE_ENABLE_CMD="systemctl --user enable --now vicoop-client"
      ;;
    *) return ;;
  esac

  mkdir -p "$unit_dir"
  unit_path="$unit_dir/vicoop-client.service"

  cat > "$unit_path" <<UNIT
# Generated by vicoop-bridge install.sh for $VERSION.
# Edit $env_file to configure the client before enabling.
[Unit]
Description=vicoop-bridge-client ($scope scope)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$env_ref
ExecStart=$bin_path
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=$want
UNIT

  if [ ! -e "$env_file" ]; then
    mkdir -p "$(dirname "$env_file")"
    # Write the env template with restrictive perms *before* content lands,
    # in case the file survives a later failure.
    ( umask 077 && : > "$env_file" )
    cat > "$env_file" <<ENVF
# vicoop-client environment — populated by the agent/operator after install.
# Restrict perms (chmod 600) if this file is ever copied elsewhere.

# Bare WS(S) origin of the bridge server (the client appends /connect).
SERVER_URL=wss://vicoop-bridge-server.fly.dev

# Raw client token from registerClient GraphQL mutation (unrecoverable).
SERVER_TOKEN=

# One of the agent IDs allowed for this client token.
AGENT_ID=

# Absolute path to the agent card JSON (template ships at
# $INSTALL_DIR/cards/openclaw.json).
AGENT_CARD=$INSTALL_DIR/cards/openclaw.json

# One of: echo, openclaw (more backends pending, see docs/design.md §5).
BACKEND=openclaw

# --- OpenClaw-only (uncomment if overriding defaults) ---
#OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
#OPENCLAW_GATEWAY_TOKEN=
#OPENCLAW_AGENT=main
#OPENCLAW_TASK_TIMEOUT_MS=
ENVF
    env_created="new"
  else
    env_created="kept"
  fi

  SERVICE_INSTALLED="$scope"
  SERVICE_ENV_FILE="$env_file"
  log "wrote systemd unit $unit_path ($env_created env: $env_file)"
}

SERVICE_SCOPE="$(resolve_service_scope)"
case "$SERVICE_SCOPE" in
  user|system) install_service "$SERVICE_SCOPE" ;;
  none)
    if [ "$INSTALL_SKIP_SERVICE" = "1" ]; then
      log "INSTALL_SKIP_SERVICE=1 — skipping service registration"
    else
      log "systemd not detected — skipping service registration (set up a supervisor manually; see docs/install-client.md §6)"
    fi
    ;;
esac

# ---- 6. Next steps ----------------------------------------------------------
cat <<EOF

==> installed $VERSION to $INSTALL_DIR

Next steps (the agent that owns this client should perform these):

  1. Obtain SERVER_TOKEN, AGENT_ID, and an agent card — see
     docs/install-client.md steps 2-4 for the SIWE + registerClient flow.
EOF

if [ -n "$SERVICE_INSTALLED" ]; then
  cat <<EOF
  2. Fill in $SERVICE_ENV_FILE with SERVER_URL / SERVER_TOKEN / AGENT_ID / AGENT_CARD / BACKEND.
  3. Enable + start the service:

       $SERVICE_ENABLE_CMD

EOF
else
  cat <<EOF
  2. Run the client (supply config via env or flags):

       SERVER_URL=wss://your-server-host \\
       SERVER_TOKEN=... \\
       AGENT_ID=... \\
       AGENT_CARD=$INSTALL_DIR/cards/openclaw.json \\
       BACKEND=openclaw \\
         $INSTALL_DIR/bin/vicoop-client

     For persistent operation, see docs/install-client.md §6
     (launchd on macOS, systemd user unit, tmux).

EOF
fi
