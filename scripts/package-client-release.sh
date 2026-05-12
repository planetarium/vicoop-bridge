#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <tag>" >&2
  exit 1
fi

TAG="$1"
TAG_PREFIX="@vicoop-bridge/client@"

# Caller passes the full tag (upload-client-release-assets.sh does this)
# so the README and archive name agree on the version. Fail fast if it doesn't
# carry the expected prefix or if the stripped version has anything that
# could path-traverse / inject shell metacharacters into BUNDLE_DIR or
# ARCHIVE_PATH below.
case "$TAG" in
  "$TAG_PREFIX"*) ;;
  *) echo "error: TAG must start with $TAG_PREFIX (got: $TAG)" >&2; exit 1 ;;
esac
VERSION="${TAG#$TAG_PREFIX}"
# Mirrors packages/client/src/upgrade.ts's TAG_RE: first char must be
# alphanumeric (no ".x" or "-x"), remaining chars limited to
# [A-Za-z0-9.+-], and no consecutive dots.
case "$VERSION" in
  ''|[!A-Za-z0-9]*|*[!A-Za-z0-9.+-]*|*..*)
    echo "error: version portion contains unsafe characters: $VERSION" >&2
    exit 1
    ;;
esac
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist-release"
WORK_DIR="$OUT_DIR/work"
BUNDLE_DIR="$WORK_DIR/vicoop-bridge-client-$VERSION"
ARCHIVE_PATH="$OUT_DIR/vicoop-bridge-client-$VERSION.tgz"
CHECKSUM_PATH="$ARCHIVE_PATH.sha256"

if [[ ! -f "$ROOT_DIR/packages/client/dist/cli.js" ]]; then
  echo "error: packages/client/dist/cli.js missing — run 'pnpm --filter @vicoop-bridge/protocol --filter @vicoop-bridge/client build' first" >&2
  exit 1
fi

rm -rf "$WORK_DIR" "$ARCHIVE_PATH" "$CHECKSUM_PATH"
mkdir -p "$WORK_DIR"

pnpm --dir "$ROOT_DIR" --filter @vicoop-bridge/client deploy --prod "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/bin"

cat > "$BUNDLE_DIR/bin/vicoop-client" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node -- "$SCRIPT_DIR/../dist/cli.js" "$@"
EOF

chmod +x "$BUNDLE_DIR/bin/vicoop-client"

cat > "$BUNDLE_DIR/README.md" <<EOF
# vicoop-bridge-client $VERSION

Portable release bundle for the standalone client daemon.

## Quick start

\`\`\`bash
export BRIDGE_URL=https://vicoop-bridge-server.fly.dev
export AGENT_ID=my-agent

# 1. Sign in as the client owner (saves an owner-session bearer to
#    ~/.vicoop/owner-session.json; admin subcommands pick it up).
./bin/vicoop-client login --bridge "\$BRIDGE_URL"

# 2. Register a bridge client and write its one-time CLIENT_TOKEN into a
#    daemon env file (mode 600, export'd + single-quoted, safe to source).
./bin/vicoop-client setup \\
  --client-name "my client" \\
  --agent-ids "\$AGENT_ID" \\
  --write-env-file ./vicoop-client.env
\`\`\`

Then start the client with env vars from \`./vicoop-client.env\` and a backend card
such as \`./cards/openclaw.json\` or \`./cards/claude.json\`.

## Notes

- This bundle is built from the Git tag \`$TAG\`.
- Node.js 20 or newer is required.
- The \`bin/vicoop-client\` wrapper runs \`node dist/cli.js\` for convenience.
EOF

tar -C "$WORK_DIR" -czf "$ARCHIVE_PATH" "vicoop-bridge-client-$VERSION"
shasum -a 256 "$ARCHIVE_PATH" > "$CHECKSUM_PATH"

echo "created $ARCHIVE_PATH"
echo "created $CHECKSUM_PATH"
