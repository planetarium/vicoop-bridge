#!/usr/bin/env bash
# Invoked by `changesets/action` whenever it runs without pending changesets.
# That happens both right after a "Version Packages" PR merges (real release
# work) and on every other main push that has no changesets to consume
# (where there's nothing to do). The script reads the current
# `packages/client/package.json` version and converges the corresponding
# `@vicoop-bridge/client@<version>` GitHub release into one of three states:
#
#   - complete: release exists with both expected assets attached → exit 0
#   - partial:  release exists but assets are missing or out of date →
#               rebuild, then `gh release upload --clobber` to repair
#   - missing:  no release yet → guard against a stray pre-existing tag,
#               rebuild, then `gh release create` with --target pinned

set -euo pipefail

# Resolve the repo root from the script's own location so this works no
# matter where it's invoked from (CI sets cwd, but local reruns or future
# wrappers may not).
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./packages/client/package.json').version")"
TAG="@vicoop-bridge/client@${VERSION}"
ARCHIVE="dist-release/vicoop-bridge-client-${VERSION}.tgz"
CHECKSUM="${ARCHIVE}.sha256"
ARCHIVE_NAME="$(basename "${ARCHIVE}")"
CHECKSUM_NAME="$(basename "${CHECKSUM}")"

# Probe the existing release (if any) and decide what state we're in
# *before* spending build time. Skipping the rebuild on already-complete
# releases is what keeps idle main pushes (e.g. server-only merges) cheap.
release_state="missing"
if existing_assets="$(gh release view "${TAG}" --json assets --jq '.assets[].name' 2>/dev/null)"; then
  if grep -qx "${ARCHIVE_NAME}" <<<"${existing_assets}" \
      && grep -qx "${CHECKSUM_NAME}" <<<"${existing_assets}"; then
    release_state="complete"
  else
    release_state="partial"
  fi
fi

if [[ "${release_state}" == "complete" ]]; then
  echo "release ${TAG} already complete with ${ARCHIVE_NAME} + ${CHECKSUM_NAME} — nothing to do"
  exit 0
fi

TARGET_SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"

# Build only when we actually need to (partial repair or first publish).
pnpm --filter @vicoop-bridge/protocol --filter @vicoop-bridge/client build
./scripts/package-client-release.sh "${TAG}"

if [[ "${release_state}" == "partial" ]]; then
  echo "release ${TAG} missing one or both expected assets — re-uploading to converge"
  gh release upload "${TAG}" --clobber "${ARCHIVE}" "${CHECKSUM}"
else
  # release_state == "missing": the release object doesn't exist, but a
  # stray tag with the same name might (e.g. someone manually pushed it, or
  # a prior release was deleted without removing the tag). `gh release
  # create` would silently attach to that tag and ignore --target,
  # decoupling the assets from the commit they were built from. Bail with a
  # clear remediation step instead.
  remote_commit_sha="$(git ls-remote origin "refs/tags/${TAG}^{}" | awk 'NR==1{print $1}')"
  if [[ -z "${remote_commit_sha}" ]]; then
    remote_commit_sha="$(git ls-remote origin "refs/tags/${TAG}" | awk 'NR==1{print $1}')"
  fi
  if [[ -n "${remote_commit_sha}" && "${remote_commit_sha}" != "${TARGET_SHA}" ]]; then
    echo "error: tag ${TAG} already exists at ${remote_commit_sha} but expected ${TARGET_SHA}" >&2
    echo "delete the tag (e.g. 'gh api -X DELETE repos/<owner>/<repo>/git/refs/tags/${TAG}') and rerun." >&2
    exit 1
  fi

  # `gh release create` creates the underlying tag remotely when it doesn't
  # yet exist. `--target` pins the commit we actually built from so a
  # commit landing on main mid-job can't make the tag point somewhere else;
  # CI sets GITHUB_SHA, falling back to HEAD for local invocations.
  # `--generate-notes` pulls in the commit/PR summary since the previous
  # @vicoop-bridge/client@* tag; the per-version CHANGELOG.md entry written
  # by changesets/action lives in packages/client/CHANGELOG.md for anyone
  # who wants the structured form.
  # Pass exact filenames — globbing dist-release/ would also pick up
  # artifacts left by previous local runs and upload them as extra assets.
  gh release create "${TAG}" \
    --target "${TARGET_SHA}" \
    --title "${TAG}" \
    --generate-notes \
    "${ARCHIVE}" \
    "${CHECKSUM}"
fi

# Marker line that changesets/action greps for to set its `published` output.
# This now matches the actual release tag, so the action's tag-push step
# won't chase a non-existent local tag the way it did under the legacy
# client-v* scheme.
echo "🦋 New tag: ${TAG}"
