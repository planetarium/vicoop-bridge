#!/usr/bin/env bash
# Runs after changesets/action has pushed the tag and created the
# GitHub release object. Builds the portable client bundle and attaches
# `vicoop-bridge-client-<version>.tgz` plus its `.sha256` to that
# release. The action sets PUBLISHED_PACKAGES to its JSON output; we
# pick the client entry out of it, so a release that only bumps other
# packages becomes a no-op here.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PACKAGE_NAME="@vicoop-bridge/client"

VERSION="$(jq -r --arg name "$PACKAGE_NAME" \
  'map(select(.name == $name)) | .[0].version // empty' \
  <<<"${PUBLISHED_PACKAGES:-[]}")"

if [[ -z "${VERSION}" ]]; then
  echo "${PACKAGE_NAME} not in this publish batch — nothing to upload"
  exit 0
fi

TAG="${PACKAGE_NAME}@${VERSION}"
ARCHIVE="dist-release/vicoop-bridge-client-${VERSION}.tgz"
CHECKSUM="${ARCHIVE}.sha256"

pnpm --filter @vicoop-bridge/protocol --filter "${PACKAGE_NAME}" build
./scripts/package-client-release.sh "${TAG}"

# --clobber so reruns of this step (manual workflow_dispatch, retried
# job) converge instead of erroring on already-uploaded asset names.
gh release upload "${TAG}" --clobber "${ARCHIVE}" "${CHECKSUM}"
