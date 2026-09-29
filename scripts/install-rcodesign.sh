#!/usr/bin/env bash
# Install the pinned Linux x64 signer used by both Ubuntu CI workflows.
# Usage: scripts/install-rcodesign.sh <destination-directory>
set -euo pipefail
if [[ $# -ne 1 || -z "$1" ]]; then
  echo "usage: $0 <destination-directory>" >&2
  exit 1
fi
VERSION=0.29.0
ARCHIVE="apple-codesign-${VERSION}-x86_64-unknown-linux-musl"
SHA256=dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
curl --fail --location --retry 3 \
  "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/${VERSION}/${ARCHIVE}.tar.gz" \
  --output "$TEMP_DIR/$ARCHIVE.tar.gz"
# Verify a repository-pinned digest, not a checksum fetched alongside the binary.
(cd "$TEMP_DIR" && printf '%s  %s\n' "$SHA256" "$ARCHIVE.tar.gz" | sha256sum -c -)
tar -xzf "$TEMP_DIR/$ARCHIVE.tar.gz" -C "$TEMP_DIR"
mkdir -p "$1"
install -m 755 "$TEMP_DIR/$ARCHIVE/rcodesign" "$1/rcodesign"
