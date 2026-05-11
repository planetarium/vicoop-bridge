#!/usr/bin/env bash
# Idempotent asset converger for the @vicoop-bridge/client release.
# Runs after changesets/action; reads the current client version from
# package.json, looks up the matching `@vicoop-bridge/client@<version>`
# release, and converges to one of three states:
#
#   - complete: release has both expected asset filenames attached → exit 0
#   - partial:  release exists but one or both expected asset filenames
#               are missing → rebuild and `gh release upload --clobber`
#               (content drift isn't checked — we trust that what was
#                uploaded under the right name is the right bundle)
#   - missing:  release doesn't exist yet (no publish this run, or a
#               different package was published) → exit 0
#
# The release object is created by changesets/action (createGithubReleases),
# so this script only ever attaches assets — it never creates the
# release. The convergence shape exists so a workflow rerun (e.g.
# manual workflow_dispatch after an upload-step failure) can finish the
# job even though `changeset tag` will have nothing to print on rerun.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./packages/client/package.json').version")"
TAG="@vicoop-bridge/client@${VERSION}"
ARCHIVE="dist-release/vicoop-bridge-client-${VERSION}.tgz"
CHECKSUM="${ARCHIVE}.sha256"
ARCHIVE_NAME="$(basename "${ARCHIVE}")"
CHECKSUM_NAME="$(basename "${CHECKSUM}")"

# Distinguish "release genuinely doesn't exist" (cheap-exit case) from
# transport / auth failures (must fail loudly). gh release view exits
# nonzero with stderr "release not found" only for the missing-release
# case; auth, network, and API errors carry different stderr.
gh_err="$(mktemp)"
trap 'rm -f "$gh_err"' EXIT
if existing_assets="$(gh release view "${TAG}" --json assets \
    --jq '.assets[].name' 2>"$gh_err")"; then
  :
else
  rc=$?
  if grep -qx 'release not found' "$gh_err"; then
    echo "release ${TAG} does not exist — nothing to upload (yet)"
    exit 0
  fi
  echo "gh release view for ${TAG} failed (exit ${rc}):" >&2
  cat "$gh_err" >&2
  exit "$rc"
fi

if grep -qx "${ARCHIVE_NAME}" <<<"${existing_assets}" \
    && grep -qx "${CHECKSUM_NAME}" <<<"${existing_assets}"; then
  echo "release ${TAG} already has ${ARCHIVE_NAME} + ${CHECKSUM_NAME} — nothing to do"
  exit 0
fi

echo "release ${TAG} missing one or both expected assets — building and uploading"
pnpm --filter @vicoop-bridge/protocol --filter @vicoop-bridge/client build
./scripts/package-client-release.sh "${TAG}"
gh release upload "${TAG}" --clobber "${ARCHIVE}" "${CHECKSUM}"
