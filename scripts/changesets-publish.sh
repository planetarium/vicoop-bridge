#!/usr/bin/env bash
# Invoked by `changesets/action` once a "Version Packages" PR has been merged
# (i.e. no pending .changeset/*.md remains). Builds the portable client
# bundle and publishes the corresponding `client-v<version>` GitHub release.
#
# Idempotent: if the release for the current package version already exists,
# this is a no-op so that re-runs and workflow_dispatch invocations are safe.

set -euo pipefail

# Resolve the repo root from the script's own location so this works no
# matter where it's invoked from (CI sets cwd, but local reruns or future
# wrappers may not).
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./packages/client/package.json').version")"
TAG="client-v${VERSION}"
ARCHIVE="dist-release/vicoop-bridge-client-${VERSION}.tgz"
CHECKSUM="${ARCHIVE}.sha256"

if gh release view "${TAG}" >/dev/null 2>&1; then
  echo "release ${TAG} already exists — nothing to do"
  exit 0
fi

pnpm --filter @vicoop-bridge/protocol --filter @vicoop-bridge/client build
./scripts/package-client-release.sh "${TAG}"

# `gh release create` creates the underlying tag remotely (pointing at the
# default branch HEAD) when it doesn't yet exist. `--generate-notes` pulls in
# the commit/PR summary since the previous client-v* tag; the per-version
# CHANGELOG.md entry written by changesets/action lives in
# packages/client/CHANGELOG.md for anyone who wants the structured form.
# Pass exact filenames — globbing dist-release/ would also pick up artifacts
# left by previous local runs and upload them as extra release assets.
gh release create "${TAG}" \
  --title "${TAG}" \
  --generate-notes \
  "${ARCHIVE}" \
  "${CHECKSUM}"

# Marker line that changesets/action greps for to set its `published` output.
echo "🦋 New tag: client@${VERSION}"
