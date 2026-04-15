#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <tag>" >&2
  exit 1
fi

TAG="$1"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist-release"
WORK_DIR="$OUT_DIR/work"
BUNDLE_DIR="$WORK_DIR/vicoop-connector-$TAG"
ARCHIVE_PATH="$OUT_DIR/vicoop-connector-$TAG.tgz"
CHECKSUM_PATH="$ARCHIVE_PATH.sha256"

rm -rf "$WORK_DIR" "$ARCHIVE_PATH" "$CHECKSUM_PATH"
mkdir -p "$WORK_DIR"

pnpm --dir "$ROOT_DIR" --filter @vicoop-bridge/connector deploy --prod "$BUNDLE_DIR"

cat > "$BUNDLE_DIR/README.md" <<EOF
# vicoop-connector $TAG

Portable release bundle for the standalone connector daemon.

## Usage

\`\`\`bash
node dist/cli.js --relay <ws://...> --token <token> --agentId <id> --card ./cards/openclaw.json --backend openclaw
\`\`\`

## Notes

- This bundle is built from the Git tag \`$TAG\`.
- Node.js 20 or newer is required.
EOF

tar -C "$WORK_DIR" -czf "$ARCHIVE_PATH" "vicoop-connector-$TAG"
shasum -a 256 "$ARCHIVE_PATH" > "$CHECKSUM_PATH"

echo "created $ARCHIVE_PATH"
echo "created $CHECKSUM_PATH"
