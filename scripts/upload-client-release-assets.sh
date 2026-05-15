#!/usr/bin/env bash
# Idempotent asset converger for the @vicoop-bridge/client release.
# Runs after changesets/action; reads the current client version from
# package.json, looks up the matching `@vicoop-bridge/client@<version>`
# release, and converges to one of three states:
#
#   - complete: release has every expected per-platform binary + .sha256
#               attached → exit 0
#   - partial:  release exists but one or more expected asset filenames
#               are missing → rebuild all and `gh release upload --clobber`
#               (content drift isn't checked — we trust that what was
#                uploaded under the right name is the right binary)
#   - missing:  release doesn't exist yet (no publish this run, or a
#               different package was published) → exit 0
#
# The release object is created by changesets/action (createGithubReleases),
# so this script only ever attaches assets — it never creates the
# release. The convergence shape exists so a workflow rerun (e.g. manual
# workflow_dispatch after an upload-step failure) can finish the job even
# though `changeset tag` will have nothing to print on rerun.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./packages/client/package.json').version")"
TAG="@vicoop-bridge/client@${VERSION}"
OUT_DIR="dist-release"

# Asset filenames expected on the release. Must stay aligned with
# scripts/package-client-release.sh and packages/client/src/upgrade.ts.
EXPECTED_ASSETS=(
  "vicoop-client-${VERSION}-macos-arm64"
  "vicoop-client-${VERSION}-macos-x64"
  "vicoop-client-${VERSION}-linux-arm64"
  "vicoop-client-${VERSION}-linux-x64"
  "vicoop-client-${VERSION}-windows-x64.exe"
)

# Distinguish "release genuinely doesn't exist" (cheap-exit case) from
# transport / auth failures (must fail loudly). `gh release view` exits
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

missing=0
for asset in "${EXPECTED_ASSETS[@]}"; do
  if ! grep -Fqx "${asset}" <<<"${existing_assets}"; then
    missing=1; break
  fi
  if ! grep -Fqx "${asset}.sha256" <<<"${existing_assets}"; then
    missing=1; break
  fi
done

if [[ $missing -eq 0 ]]; then
  echo "release ${TAG} already has all ${#EXPECTED_ASSETS[@]} binaries + checksums — nothing to do"
  exit 0
fi

echo "release ${TAG} missing one or more expected assets — building and uploading"
./scripts/package-client-release.sh "${TAG}"

# Upload every binary + sidecar in one call so partial-failure leaves a
# diagnosable state (gh tells us which assets failed). --clobber is safe
# because the convergence model treats "right name = right bundle".
upload_args=()
for asset in "${EXPECTED_ASSETS[@]}"; do
  upload_args+=( "${OUT_DIR}/${asset}" "${OUT_DIR}/${asset}.sha256" )
done
gh release upload "${TAG}" --clobber "${upload_args[@]}"
