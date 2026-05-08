#!/usr/bin/env bash
# Invoked by `changesets/action` once a "Version Packages" PR has been merged
# (i.e. no pending .changeset/*.md remains). Builds the portable client
# bundle and publishes the corresponding `client-v<version>` GitHub release.
#
# Idempotent: if the release for the current package version already exists,
# this is a no-op so that re-runs and workflow_dispatch invocations are safe.

set -euo pipefail

VERSION="$(node -p "require('./packages/client/package.json').version")"
TAG="client-v${VERSION}"

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
gh release create "${TAG}" \
  --title "${TAG}" \
  --generate-notes \
  dist-release/vicoop-bridge-client-*.tgz \
  dist-release/vicoop-bridge-client-*.tgz.sha256

# Marker line that changesets/action greps for to set its `published` output.
echo "🦋 New tag: client@${VERSION}"
