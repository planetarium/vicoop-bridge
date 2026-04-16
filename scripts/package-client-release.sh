#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <tag>" >&2
  exit 1
fi

TAG="$1"
VERSION="${TAG#client-v}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist-release"
WORK_DIR="$OUT_DIR/work"
BUNDLE_DIR="$WORK_DIR/vicoop-bridge-client-$VERSION"
ARCHIVE_PATH="$OUT_DIR/vicoop-bridge-client-$VERSION.tgz"
CHECKSUM_PATH="$ARCHIVE_PATH.sha256"

rm -rf "$WORK_DIR" "$ARCHIVE_PATH" "$CHECKSUM_PATH"
mkdir -p "$WORK_DIR"

pnpm --dir "$ROOT_DIR" --filter @vicoop-bridge/client deploy --prod "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/bin"

cat > "$BUNDLE_DIR/bin/vicoop-client" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/../dist/cli.js" "$@"
EOF

chmod +x "$BUNDLE_DIR/bin/vicoop-client"

cat > "$BUNDLE_DIR/README.md" <<EOF
# vicoop-bridge-client $VERSION

Portable release bundle for the standalone client daemon.

## Usage

\`\`\`bash
./bin/vicoop-client --server <ws://...> --token <token> --agentId <id> --card ./cards/openclaw.json --backend openclaw
\`\`\`

## Notes

- This bundle is built from the Git tag \`$TAG\`.
- Node.js 20 or newer is required.
- The \`bin/vicoop-client\` wrapper runs \`node dist/cli.js\` for convenience.
EOF

tar -C "$WORK_DIR" -czf "$ARCHIVE_PATH" "vicoop-bridge-client-$VERSION"
shasum -a 256 "$ARCHIVE_PATH" > "$CHECKSUM_PATH"

echo "created $ARCHIVE_PATH"
echo "created $CHECKSUM_PATH"
