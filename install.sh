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
#      (does NOT enable/start — the owner must populate env first). The
#      shipped bundle already contains cards/openclaw.json, so the env
#      template points AGENT_CARD at that file by default.
#   6. Prints next-step instructions (populate env, reload, enable).

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

register_service() {
  # Picks the scope, logs exactly one reason when skipping, and delegates to
  # install_service when it can. Set SERVICE_INSTALLED on success.
  if [ "$INSTALL_SKIP_SERVICE" = "1" ]; then
    log "INSTALL_SKIP_SERVICE=1 — skipping service registration"
    return
  fi

  case "$INSTALL_SERVICE_SCOPE" in
    none)
      log "INSTALL_SERVICE_SCOPE=none — skipping service registration"
      return
      ;;
    user)
      install_service user
      return
      ;;
    system)
      # Explicit system scope requires root — refuse early with a clear message
      # rather than letting the later `cat > /etc/...` fail under `set -e`.
      if [ "$(id -u)" != "0" ]; then
        log "warning: INSTALL_SERVICE_SCOPE=system requires root; skipping service registration (rerun with sudo, or set INSTALL_SERVICE_SCOPE=user)"
        return
      fi
      install_service system
      return
      ;;
    auto) ;;
    *)
      log "warning: unknown INSTALL_SERVICE_SCOPE='$INSTALL_SERVICE_SCOPE', treating as auto"
      ;;
  esac

  # systemd must be the init (PID 1) — otherwise systemctl may exist but the
  # unit will never actually run (common in Docker, WSL1, macOS with homebrew).
  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
    log "systemd not detected — skipping service registration (set up a supervisor manually; see docs/install-client.md §6)"
    return
  fi

  if [ "$(id -u)" = "0" ]; then
    install_service system
  else
    install_service user
  fi
}

install_service() {
  scope="$1"

  # Resolve node's absolute path at install time. Invoking node directly (not
  # via bin/vicoop-client) means the unit works under nvm/asdf/Volta layouts
  # where systemd's default PATH wouldn't find node.
  node_bin="$(command -v node 2>/dev/null || true)"
  [ -n "$node_bin" ] || { log "warning: node not on PATH — skipping service registration"; return; }
  cli_entry="$INSTALL_DIR/dist/cli.js"

  case "$scope" in
    system)
      unit_dir="/etc/systemd/system"
      env_file="/etc/vicoop-client.env"
      env_ref="$env_file"
      want="multi-user.target"
      # network-online.target is a system-instance unit; keep the ordering
      # dependency only for system scope.
      net_deps='After=network-online.target
Wants=network-online.target'
      # The client has no privileged operations, so drop root for system
      # scope. DynamicUser allocates a transient UID; EnvironmentFile is
      # read before the user switch so /etc/vicoop-client.env can stay
      # root-owned 0600. NoNewPrivileges/ProtectSystem/ProtectHome/PrivateTmp
      # are cheap defense-in-depth. User-scope units inherit the caller's
      # identity and don't need (or accept) these knobs.
      #
      # Refuse to generate a system-scope unit when node or the bundle
      # lives under /home or /root. Falling back to a root-run unit from a
      # user-writable directory (e.g. nvm under /home, or `sudo sh
      # install.sh` pulling node from /root/.nvm) turns this into
      # "root executes code from a potentially user-controlled path at
      # boot" — a real privilege-escalation vector. Skip service
      # registration and tell the operator how to recover; extraction
      # already succeeded, so the install is still usable manually.
      case "$node_bin $cli_entry" in
        */home/*|*/root/*)
          log "warning: refusing to install a system-scope service because node or the bundle lives under /home or /root (node=$node_bin, cli=$cli_entry)."
          log "  reason: a root-owned unit executing code from a user-writable or home-owned path is unsafe."
          log "  options: reinstall with INSTALL_DIR under a root-only system path (e.g. /opt/vicoop-bridge-client) and a system-path node, or re-run with INSTALL_SERVICE_SCOPE=user."
          return
          ;;
      esac
      unit_hardening='DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes'
      # Root running the installer (the auto-detected system path) gets an
      # un-prefixed command; sudo is only suggested for later reinvocations by
      # a non-root operator. Minimal images often lack sudo entirely.
      if [ "$(id -u)" = "0" ]; then
        SERVICE_RELOAD_CMD="systemctl daemon-reload"
        SERVICE_ENABLE_CMD="systemctl enable --now vicoop-client"
      else
        SERVICE_RELOAD_CMD="sudo systemctl daemon-reload"
        SERVICE_ENABLE_CMD="sudo systemctl enable --now vicoop-client"
      fi
      ;;
    user)
      [ -n "${HOME:-}" ] || { log "warning: HOME unset — skipping service registration"; return; }
      unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
      env_file="${XDG_CONFIG_HOME:-$HOME/.config}/vicoop-client.env"
      env_ref="$env_file"
      want="default.target"
      # User-instance systemd doesn't know about network-online.target;
      # declaring it produces "unit not found" noise and buys nothing.
      net_deps=''
      # NoNewPrivileges is safe to apply in --user scope; the heavier
      # ProtectSystem / DynamicUser family is system-scope only.
      unit_hardening='NoNewPrivileges=yes'
      SERVICE_RELOAD_CMD="systemctl --user daemon-reload"
      SERVICE_ENABLE_CMD="systemctl --user enable --now vicoop-client"
      ;;
    *) return ;;
  esac

  # systemd's ExecStart tokenises on whitespace and EnvironmentFile doesn't
  # cleanly round-trip paths with spaces either. Rather than hand-roll the
  # quoting rules, refuse to register and let the operator pick a clean path.
  for p in "$node_bin" "$cli_entry" "$unit_dir" "$env_file"; do
    case "$p" in
      *[[:space:]]*)
        log "warning: path contains whitespace ('$p') — skipping service registration, run the client manually or reinstall under a space-free path"
        return
        ;;
    esac
  done

  mkdir -p "$unit_dir"
  unit_path="$unit_dir/vicoop-client.service"

  # Assemble the [Unit] body so the net_deps block drops out cleanly for user
  # scope without leaving a stray blank line.
  unit_unit_section="Description=vicoop-bridge-client ($scope scope)"
  if [ -n "$net_deps" ]; then
    unit_unit_section="$unit_unit_section
$net_deps"
  fi

  cat > "$unit_path" <<UNIT
# Generated by vicoop-bridge install.sh for $VERSION.
# Edit $env_file to configure the client before enabling.
[Unit]
$unit_unit_section

[Service]
Type=simple
EnvironmentFile=$env_ref
ExecStart=$node_bin $cli_entry
Restart=on-failure
RestartSec=5s
$unit_hardening

[Install]
WantedBy=$want
UNIT

  if [ ! -e "$env_file" ]; then
    mkdir -p "$(dirname "$env_file")"
    # Write the env template with restrictive perms *before* content lands,
    # in case the file survives a later failure.
    ( umask 077 && : > "$env_file" )
    env_fresh=1
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
# \$INSTALL_DIR/cards/openclaw.json). Double-quoted so systemd's
# EnvironmentFile parser accepts the literal value if the path is ever
# edited to contain spaces.
AGENT_CARD="$INSTALL_DIR/cards/openclaw.json"

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
    env_fresh=0
    env_created="kept"
  fi

  # Always enforce 0600 — an existing env file may have been copied in with
  # permissive perms, and SERVER_TOKEN being world-readable is the worst
  # failure mode we could leave behind.
  chmod 600 "$env_file" 2>/dev/null || log "warning: could not chmod 600 $env_file"

  # Warn if a kept env file's AGENT_CARD still points at a different
  # install root than the one we just extracted into. We don't rewrite —
  # the operator may have intentionally pointed at a different card — but
  # an invisible stale pointer after \`INSTALL_DIR=\` reinstalls is worse
  # than a noisy log line.
  if [ "$env_fresh" = "0" ]; then
    prev_card="$(sed -n 's/^[[:space:]]*AGENT_CARD=\(.*\)/\1/p' "$env_file" | tail -n1 | sed -E 's/^"//; s/"$//')"
    new_card="$INSTALL_DIR/cards/openclaw.json"
    if [ -n "$prev_card" ] && [ "$prev_card" != "$new_card" ]; then
      case "$prev_card" in
        */cards/openclaw.json)
          log "warning: $env_file has AGENT_CARD=$prev_card but INSTALL_DIR is now $INSTALL_DIR — update the env file if that pointer is stale"
          ;;
      esac
    fi
  fi

  SERVICE_INSTALLED="$scope"
  SERVICE_ENV_FILE="$env_file"
  log "wrote systemd unit $unit_path ($env_created env: $env_file)"
}

register_service

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
  3. Reload systemd and enable + start the service:

       $SERVICE_RELOAD_CMD
       $SERVICE_ENABLE_CMD

  Future updates: run \`$INSTALL_DIR/bin/vicoop-client upgrade\` — no need to
  re-run this installer. Pass --check to see if a newer release is available.

EOF
  if [ "$SERVICE_INSTALLED" = "user" ]; then
    cat <<'EOF'
     For 24/7 operation on a headless host, also run (once):

       sudo loginctl enable-linger "$USER"

     Otherwise the user's systemd manager stops when the last login session
     closes, taking the client with it.

EOF
  fi
else
  cat <<EOF
  2. Run the client (supply config via env or flags). Paths are quoted so
     the snippet works even when \$INSTALL_DIR contains whitespace:

       SERVER_URL=wss://your-server-host \\
       SERVER_TOKEN=... \\
       AGENT_ID=... \\
       AGENT_CARD="$INSTALL_DIR/cards/openclaw.json" \\
       BACKEND=openclaw \\
         "$INSTALL_DIR/bin/vicoop-client"

     For persistent operation, see docs/install-client.md §6
     (launchd on macOS, systemd user unit, tmux).

  Future updates: run \`$INSTALL_DIR/bin/vicoop-client upgrade\` — no need to
  re-run this installer. Pass --check to see if a newer release is available.

EOF
fi
