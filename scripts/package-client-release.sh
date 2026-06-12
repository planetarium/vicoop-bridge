#!/usr/bin/env bash
set -euo pipefail

# Cross-compile per-platform vicoop-client binaries + sha256 sidecars into
# dist-release/. Idempotent: re-running rebuilds everything.
#
# Usage: scripts/package-client-release.sh <tag>
#
# The asset filename convention must stay in lock-step with
# packages/client/src/upgrade.ts (resolvePlatformAsset + assetName) and
# install.sh — both rely on `vicoop-client-<version>-<slug>[.exe]` and a
# sibling `.sha256` whose first whitespace-separated token is the hash.

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <tag>" >&2
  exit 1
fi

TAG="$1"
TAG_PREFIX="@vicoop-bridge/client@"

case "$TAG" in
  "$TAG_PREFIX"*) ;;
  *) echo "error: TAG must start with $TAG_PREFIX (got: $TAG)" >&2; exit 1 ;;
esac
VERSION="${TAG#$TAG_PREFIX}"
# Mirrors packages/client/src/upgrade.ts's TAG_RE: first char alphanumeric,
# remaining chars [A-Za-z0-9.+-], no `..`. The version portion gets
# interpolated into the output filename, so reject anything that could
# path-traverse before it reaches the filesystem.
case "$VERSION" in
  ''|[!A-Za-z0-9]*|*[!A-Za-z0-9.+-]*|*..*)
    echo "error: version portion contains unsafe characters: $VERSION" >&2
    exit 1
    ;;
esac

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist-release"

# Bun resolves `@vicoop-bridge/protocol` via the workspace package's
# `exports.import` (dist/index.js), so the protocol package must be built
# before we compile the client. Tsc-building the client itself is no
# longer required — `bun build --compile` reads src/cli.ts directly.
pnpm --dir "$ROOT_DIR" --filter @vicoop-bridge/protocol build

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

CLIENT_DIR="$ROOT_DIR/packages/client"

# Build-time injection of the opt-in crash-telemetry Sentry DSN. The client is
# a distributed binary, so it can't read a runtime secret on the operator's
# host — the DSN has to be baked into the binary at compile time. When
# $VICOOP_CLIENT_SENTRY_DSN is set (release.yml passes it from a GitHub
# secret), Bun's `--define` rewrites the `process.env.VICOOP_CLIENT_SENTRY_DSN`
# lookup in src/instrument.ts to this string literal. When it's unset (local
# builds, forks, CI smoke compiles), no define is added and the daemon falls
# back to the empty BAKED_IN_DSN — i.e. telemetry stays disabled. A DSN is a
# submit-only credential, so baking it into the public binary is expected and
# safe (see docs/install-client.md → Telemetry).
BUILD_DEFINES=()
if [[ -n "${VICOOP_CLIENT_SENTRY_DSN:-}" ]]; then
  BUILD_DEFINES+=( --define "process.env.VICOOP_CLIENT_SENTRY_DSN=\"${VICOOP_CLIENT_SENTRY_DSN}\"" )
  echo "==> telemetry: injecting Sentry DSN at build time"
else
  echo "==> telemetry: no VICOOP_CLIENT_SENTRY_DSN set; building with telemetry disabled"
fi

# (bun-target, asset-slug, file-extension) — keep this table identical to
# resolvePlatformAsset() in upgrade.ts. Anything added here also needs a
# matching branch there, otherwise `vicoop-client upgrade` will fail to
# look up the asset on that platform.
TARGETS=(
  "bun-darwin-arm64 macos-arm64 "
  "bun-darwin-x64   macos-x64   "
  "bun-linux-arm64  linux-arm64 "
  "bun-linux-x64    linux-x64   "
  "bun-windows-x64  windows-x64 .exe"
)

# sha256 tool selection mirrors install.sh's logic so a build host without
# GNU coreutils (e.g. a Mac dev box) still produces the same checksum file
# shape (<hash>  <filename>).
if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
else
  echo "error: need sha256sum or shasum on PATH" >&2
  exit 1
fi

for entry in "${TARGETS[@]}"; do
  # shellcheck disable=SC2206  # split on whitespace intentionally
  parts=( $entry )
  target="${parts[0]}"
  slug="${parts[1]}"
  ext="${parts[2]:-}"
  asset="vicoop-client-${VERSION}-${slug}${ext}"

  echo "==> building $target -> $asset"
  # `${BUILD_DEFINES[@]+...}` guards the empty-array expansion under `set -u`
  # on bash 3.2 (macOS dev hosts); on the CI runner the array carries the
  # --define pair built above.
  ( cd "$CLIENT_DIR" && bun build --compile --target="$target" \
      ${BUILD_DEFINES[@]+"${BUILD_DEFINES[@]}"} \
      src/cli.ts --outfile "$OUT_DIR/$asset" )
  chmod +x "$OUT_DIR/$asset"

  # Write the checksum file with a *bare filename*, not the absolute build
  # path, so `sha256sum -c` works in install.sh's $TMP_DIR without
  # rewriting. The cd-before-shasum keeps the path bare.
  ( cd "$OUT_DIR" && $SHA_CMD "$asset" > "$asset.sha256" )

  echo "    $(ls -lh "$OUT_DIR/$asset" | awk '{print $5}')  $(cat "$OUT_DIR/$asset.sha256")"
done

echo
echo "built $(ls "$OUT_DIR" | wc -l | tr -d ' ') files in $OUT_DIR"
