#!/usr/bin/env sh
# install.sh — vicoop-bridge-client one-line installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/planetarium/vicoop-bridge/main/install.sh | sh
#
# Environment overrides:
#   INSTALL_DIR           Target directory (default: /data/vicoop-bridge-client)
#   VERSION               Specific tag to install, e.g. @vicoop-bridge/client@0.1.0
#                         (default: latest @vicoop-bridge/client@* release)
#   FORCE                 If "1", overwrite a non-empty INSTALL_DIR
#
# What it does:
#   1. Verifies prerequisites (Linux warning, Node.js >= 20, curl, tar, sha256 tool).
#   2. Resolves the latest (or pinned) @vicoop-bridge/client@* GitHub release.
#   3. Downloads the .tgz + .sha256 and verifies integrity.
#   4. Extracts the bundle into INSTALL_DIR.
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
TAG_PREFIX="@vicoop-bridge/client@"

if [ -z "$VERSION" ]; then
  log "resolving latest $TAG_PREFIX* release from GitHub"
  # Pull recent releases (default 30) and pick the newest non-draft,
  # non-prerelease release whose tag matches the changesets monorepo
  # prefix. Avoid /releases/latest because it may point at a non-client
  # release. Parse with node (already a hard prereq above) rather than
  # grepping tag_name, so the draft/prerelease flags are honored the same
  # way `vicoop-client upgrade` honors them.
  #
  # `set -e` doesn't catch failures on the upstream end of a POSIX-sh
  # pipeline, so curl is run on its own first — otherwise a network /
  # rate-limit error would let node read empty input, exit 0, and surface
  # as a misleading "no published release found" later.
  api_json="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30")" \
    || die "GitHub release API request failed"
  # node exits non-zero on a malformed or non-array payload (rate-limit
  # error object, abuse-detection response, etc.) so those failures don't
  # masquerade as "no release found"; an empty stdout with exit 0 is the
  # genuine no-match case.
  VERSION="$(
    printf '%s' "$api_json" \
      | TAG_PREFIX="$TAG_PREFIX" node -e '
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { data += c; });
process.stdin.on("end", () => {
  let releases;
  try {
    releases = JSON.parse(data);
  } catch (e) {
    process.stderr.write(`error: GitHub API response was not valid JSON: ${e.message}\n`);
    process.exit(1);
  }
  if (!Array.isArray(releases)) {
    const msg = releases && typeof releases.message === "string"
      ? releases.message
      : JSON.stringify(releases).slice(0, 200);
    process.stderr.write(`error: GitHub API returned a non-array payload: ${msg}\n`);
    process.exit(1);
  }
  const prefix = process.env.TAG_PREFIX;
  if (!prefix) {
    process.stderr.write("error: TAG_PREFIX env var missing\n");
    process.exit(1);
  }
  for (const r of releases) {
    if (!r || typeof r.tag_name !== "string") continue;
    if (!r.tag_name.startsWith(prefix)) continue;
    if (r.draft || r.prerelease) continue;
    process.stdout.write(r.tag_name);
    return;
  }
});
'
  )" || die "failed to parse GitHub release list (see error above)"
  [ -n "$VERSION" ] || die "no published (non-draft, non-prerelease) $TAG_PREFIX* release found in $REPO"
fi

# Defense in depth: even when the operator pins VERSION via env, refuse to
# proceed if it doesn't carry the expected prefix. Otherwise the
# `${VERSION#$TAG_PREFIX}` expansion below leaves arbitrary characters in
# VERSION_NUM, which then lands in the archive filename and URL.
case "$VERSION" in
  "$TAG_PREFIX"*) ;;
  *) die "VERSION must start with $TAG_PREFIX (got: $VERSION)" ;;
esac

log "installing $VERSION"

VERSION_NUM="${VERSION#$TAG_PREFIX}"
# After stripping the prefix, the bare version still has to be safe to
# interpolate into a local filename and a URL — the prefix check alone
# wouldn't catch e.g. `@vicoop-bridge/client@0.3.0/../../etc`. Mirrors
# packages/client/src/upgrade.ts's TAG_RE: first char must be alphanumeric
# (rejects ".0.3.0", "-1", and other option-like names), remaining chars
# limited to [A-Za-z0-9.+-], and no consecutive dots.
case "$VERSION_NUM" in
  ''|[!A-Za-z0-9]*|*[!A-Za-z0-9.+-]*|*..*)
    die "version contains unsafe characters: $VERSION_NUM"
    ;;
esac
ARCHIVE="vicoop-bridge-client-$VERSION_NUM.tgz"
CHECKSUM="$ARCHIVE.sha256"
# GitHub's release-download endpoint takes the tag as one path segment. The
# tag contains `/` and `@`; percent-encode both so the URL doesn't split.
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

# Portable ownership normalization. We can't rely on `tar --no-same-owner`
# everywhere (busybox tar lacks the long option), so we chown after the
# fact. Only actually matters under `sudo`: otherwise tar extracts as the
# current uid/gid already. When root *is* extracting, the archive's stored
# uid (typically ~1000, whoever built the release) would otherwise end up
# owning a root-run service's files — that's a privilege-escalation vector.
# After chown-to-root, also strip any setuid/setgid bits tar may have
# restored — those'd now be *root-owned* suid files, which is far worse
# than the build-uid case. Archive has no setuid bits today; this is a
# defense-in-depth invariant.
if [ "$(id -u)" = "0" ]; then
  chown -R 0:0 "$INSTALL_DIR" || die "chown -R 0:0 $INSTALL_DIR failed — refusing to leave root-extracted files with non-root ownership"
  # POSIX `-exec ... {} \;` (one-per-file) rather than `{} +` so this works
  # on older busybox find too. Our archive ships no setuid files, so the
  # per-file fork overhead is effectively zero in practice.
  find "$INSTALL_DIR" -type f \( -perm -4000 -o -perm -2000 \) -exec chmod u-s,g-s {} \; \
    || die "failed to strip setuid/setgid bits under $INSTALL_DIR after root extraction"
fi

chmod +x "$INSTALL_DIR/bin/vicoop-client" 2>/dev/null || true

# ---- 5. Next steps ----------------------------------------------------------
cat <<EOF

==> installed $VERSION to $INSTALL_DIR

Next steps (the agent that owns this client should perform these):

  1. Verify the installed bundle and register with device flow:

       "$INSTALL_DIR/bin/vicoop-client" -v
       "$INSTALL_DIR/bin/vicoop-client" login --help

     Then follow docs/install-client.md steps 3-6 to pick AGENT_ID, run
     login, choose a backend, and start the client.

  2. Run the client in the foreground (supply config via env or flags).
     Paths are quoted so the snippet works even when \$INSTALL_DIR contains
     whitespace:

       SERVER_URL=wss://your-server-host \\
       SERVER_TOKEN=... \\
       AGENT_ID=... \\
       BACKEND=openclaw \\
         "$INSTALL_DIR/bin/vicoop-client"

     An always-on supervisor story (systemd unit, launchd plist, etc.) is
     not currently provided by this installer; the foreground run above is
     the supported entrypoint while the design is in flux (issue #186).

  Future updates: run \`"$INSTALL_DIR/bin/vicoop-client" upgrade\` — no need
  to re-run this installer. Pass --check to see if a newer release is
  available. The quotes keep the command correct even if \$INSTALL_DIR
  contains whitespace.

EOF
