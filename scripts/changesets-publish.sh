#!/usr/bin/env bash
# Invoked by `changesets/action` once a "Version Packages" PR has been merged
# (i.e. no pending .changeset/*.md remains). Builds the portable client
# bundle and publishes the corresponding `client-v<version>` GitHub release.
#
# Convergent: a re-run (workflow_dispatch retry, or after a previous run
# failed mid-upload) always rebuilds the bundle and pushes the assets with
# `--clobber`, so partial state on the release recovers without manual
# intervention. The release/tag itself is created on the first run only.

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

pnpm --filter @vicoop-bridge/protocol --filter @vicoop-bridge/client build
./scripts/package-client-release.sh "${TAG}"

if gh release view "${TAG}" >/dev/null 2>&1; then
  echo "release ${TAG} already exists — re-uploading assets to converge"
  gh release upload "${TAG}" --clobber "${ARCHIVE}" "${CHECKSUM}"
else
  # `gh release create` creates the underlying tag remotely when it doesn't
  # yet exist. Pin `--target` to the commit we actually built from so a
  # commit landing on main mid-job can't make the tag point somewhere else;
  # CI sets GITHUB_SHA, falling back to HEAD for local invocations.
  # `--generate-notes` pulls in the commit/PR summary since the previous
  # client-v* tag; the per-version CHANGELOG.md entry written by
  # changesets/action lives in packages/client/CHANGELOG.md for anyone who
  # wants the structured form.
  # Pass exact filenames — globbing dist-release/ would also pick up
  # artifacts left by previous local runs and upload them as extra assets.
  TARGET_SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"
  gh release create "${TAG}" \
    --target "${TARGET_SHA}" \
    --title "${TAG}" \
    --generate-notes \
    "${ARCHIVE}" \
    "${CHECKSUM}"
fi

# Marker line that changesets/action greps for to set its `published` output.
# Use the actual workspace package name so anything reading the action's
# `publishedPackages` output sees a real identifier; the GitHub release tag
# itself remains `client-v<version>`.
echo "🦋 New tag: @vicoop-bridge/client@${VERSION}"
