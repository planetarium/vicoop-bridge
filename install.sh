#!/usr/bin/env sh
# install.sh — vicoop-bridge-client one-line installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/planetarium/vicoop-bridge/main/install.sh | sh
#
# Environment overrides:
#   INSTALL_DIR  Target directory (default: /data/vicoop-bridge-client)
#   VERSION      Specific tag, e.g. @vicoop-bridge/client@0.16.0
#                (default: latest @vicoop-bridge/client@* release)
#   FORCE        If "1", overwrite a non-empty INSTALL_DIR
#
# What it does:
#   1. Verifies prerequisites (curl, sha256 tool, jq when auto-resolving).
#   2. Detects OS/arch and resolves the matching release asset.
#   3. Downloads the binary + .sha256, verifies integrity, chmod +x.
#   4. Drops macOS quarantine xattr so first launch isn't Gatekeeper-blocked.
#   5. Prints next-step instructions for login and a foreground first run.

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

# ---- 1. Prereqs + platform detect ------------------------------------------
need curl

if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
else
  die "missing required command: sha256sum or shasum"
fi

# Asset slug + extension mapping. Must stay aligned with
# resolvePlatformAsset() in packages/client/src/upgrade.ts and the build
# matrix in scripts/package-client-release.sh.
OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"
case "$OS_NAME/$ARCH_NAME" in
  Darwin/arm64)         ASSET_SLUG="macos-arm64"; ASSET_EXT="" ;;
  Darwin/x86_64)        ASSET_SLUG="macos-x64";   ASSET_EXT="" ;;
  Linux/aarch64|Linux/arm64)
                        ASSET_SLUG="linux-arm64"; ASSET_EXT="" ;;
  Linux/x86_64|Linux/amd64)
                        ASSET_SLUG="linux-x64";   ASSET_EXT="" ;;
  *)
    die "unsupported platform/arch combination: $OS_NAME/$ARCH_NAME (Windows users: see docs/install-client.md for the install.ps1 path)"
    ;;
esac

# ---- 2. Resolve release tag -------------------------------------------------
TAG_PREFIX="@vicoop-bridge/client@"

if [ -z "$VERSION" ]; then
  # Auto-resolution needs JSON parsing to filter out draft/prerelease
  # entries. When VERSION is pinned explicitly, jq isn't required.
  need jq
  log "resolving latest $TAG_PREFIX* release from GitHub"
  # `set -e` doesn't catch failures inside a POSIX-sh pipeline, so the
  # curl step runs first — otherwise a network / rate-limit error would
  # let jq read empty input, exit 0, and surface as a misleading
  # "no published release found" later.
  api_json="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30")" \
    || die "GitHub release API request failed"
  # `--exit-status` makes jq exit non-zero when the filter yields null /
  # nothing, so missing-release cases surface explicitly instead of as an
  # empty VERSION string.
  VERSION="$(
    printf '%s' "$api_json" \
      | jq -r --arg prefix "$TAG_PREFIX" --exit-status '
          if type != "array" then
            error("GitHub API returned a non-array payload: " + (.message // tostring))
          else
            (map(select(
              .tag_name != null
              and (.tag_name | startswith($prefix))
              and (.draft != true)
              and (.prerelease != true)
            )) | first | .tag_name)
          end
        ' 2>&1
  )" || die "no published (non-draft, non-prerelease) $TAG_PREFIX* release found in $REPO (jq said: $VERSION)"
fi

# Defense in depth: even when the operator pins VERSION via env, refuse to
# proceed if it doesn't carry the expected prefix.
case "$VERSION" in
  "$TAG_PREFIX"*) ;;
  *) die "VERSION must start with $TAG_PREFIX (got: $VERSION)" ;;
esac

log "installing $VERSION ($ASSET_SLUG)"

VERSION_NUM="${VERSION#"$TAG_PREFIX"}"
# After stripping the prefix, the bare version still has to be safe to
# interpolate into a filename and URL. Mirrors
# packages/client/src/upgrade.ts's TAG_RE.
case "$VERSION_NUM" in
  ''|[!A-Za-z0-9]*|*[!A-Za-z0-9.+-]*|*..*)
    die "version contains unsafe characters: $VERSION_NUM"
    ;;
esac

ASSET_NAME="vicoop-client-${VERSION_NUM}-${ASSET_SLUG}${ASSET_EXT}"
CHECKSUM_NAME="${ASSET_NAME}.sha256"
BINARY_NAME="vicoop-client${ASSET_EXT}"
# GitHub's release-download endpoint takes the tag as one path segment;
# the tag contains `/` and `@`, percent-encode both so the URL doesn't split.
ENCODED_TAG="$(printf '%s' "$VERSION" | sed -e 's#@#%40#g' -e 's#/#%2F#g')"
BASE_URL="https://github.com/$REPO/releases/download/$ENCODED_TAG"

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

# ---- 4. Download + verify + install ----------------------------------------
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

log "downloading $ASSET_NAME"
curl -fsSL "$BASE_URL/$ASSET_NAME"     -o "$TMP_DIR/$ASSET_NAME"
curl -fsSL "$BASE_URL/$CHECKSUM_NAME"  -o "$TMP_DIR/$CHECKSUM_NAME"

log "verifying checksum"
# The .sha256 sidecar produced by package-client-release.sh already has
# `<hash>  <bare-filename>` shape (cd-into-OUT_DIR before shasum), so no
# rewrite is needed here.
( cd "$TMP_DIR" && $SHA_CMD -c "$CHECKSUM_NAME" >/dev/null ) || die "checksum verification failed"

log "installing into $INSTALL_DIR/$BINARY_NAME"
mv "$TMP_DIR/$ASSET_NAME" "$INSTALL_DIR/$BINARY_NAME"
chmod +x "$INSTALL_DIR/$BINARY_NAME"

# Under sudo: normalize ownership so the binary doesn't end up owned by
# whoever happened to build the release / whoever ran install.sh.
if [ "$(id -u)" = "0" ]; then
  chown 0:0 "$INSTALL_DIR/$BINARY_NAME" \
    || die "chown 0:0 $INSTALL_DIR/$BINARY_NAME failed — refusing to leave root-installed file with non-root ownership"
  # Defense-in-depth: strip suid/sgid in case a future build accidentally
  # ships them. After chown, any such bit would yield a root-owned suid
  # binary inside $INSTALL_DIR.
  current_mode="$(stat -c '%a' "$INSTALL_DIR/$BINARY_NAME" 2>/dev/null \
                  || stat -f '%Lp' "$INSTALL_DIR/$BINARY_NAME")"
  case "$current_mode" in
    [4-7]???) chmod u-s,g-s "$INSTALL_DIR/$BINARY_NAME" ;;
  esac
fi

# macOS quarantine attribute attaches to anything `curl` downloaded; first
# launch would otherwise be Gatekeeper-blocked with "Apple cannot verify
# this software". Stripping it here keeps `install.sh | sh` a true one-liner
# until proper Developer ID signing + notarization land (issue #188
# follow-up). xattr is part of the macOS base system; the check guards
# against the rare Linux case where it isn't.
if [ "$OS_NAME" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$INSTALL_DIR/$BINARY_NAME" 2>/dev/null || true
fi

# ---- 5. Next steps ----------------------------------------------------------
cat <<EOF

==> installed $VERSION to $INSTALL_DIR/$BINARY_NAME

Next steps (the agent that owns this client should perform these):

  1. Verify and sign in (device flow). The owner-session bearer is saved
     to ~/.vicoop/owner-session.json; admin subcommands pick it up:

       "$INSTALL_DIR/$BINARY_NAME" --version
       "$INSTALL_DIR/$BINARY_NAME" login

  2. Register this client. \`setup\` writes the one-time CLIENT_TOKEN plus
     server_url / agent_id into the canonical ~/.vicoop/config.json
     (mode 600); the daemon picks those up on its next launch:

       "$INSTALL_DIR/$BINARY_NAME" setup \\
         --client-name "my client" --agent-ids "\$AGENT_ID"

  3. Run the daemon in the foreground. With config.json populated, only
     the backend choice (echo / openclaw / claude / codex) is left:

       "$INSTALL_DIR/$BINARY_NAME" --backend openclaw

     Or persist \`"backend": "openclaw"\` in config.json and run with no
     flags at all:

       "$INSTALL_DIR/$BINARY_NAME"

     An always-on supervisor (systemd unit, launchd plist, …) is not
     provided by this installer; the foreground run above is the
     supported entrypoint while the design is in flux (issue #190).

  Future updates: run \`"$INSTALL_DIR/$BINARY_NAME" upgrade\` — no need
  to re-run this installer. Pass --check to see if a newer release is
  available.

EOF
