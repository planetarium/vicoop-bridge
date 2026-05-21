#!/usr/bin/env bash
# Install / upgrade the openclaw gateway into /data/agents/openclaw/.
#
# openclaw isn't an LLM CLI per se — the client speaks to a separate
# `openclaw-gateway` process via WS. For containerized operation the
# operator typically runs the gateway alongside (sidecar / separate
# compose service) and the bridge client just connects to its URL via
# `--openclaw-gateway`. So this recipe is a no-op placeholder: there is
# nothing to install on the bridge-client side.
#
# Kept as a file so install-backend.sh's dispatch table doesn't have to
# special-case openclaw; the contract (backend_install / backend_version)
# is honored, just with empty bodies.

set -euo pipefail

backend_install() {
  # Nothing to install — the gateway runs out-of-process.
  return 0
}

backend_version() {
  # No installed binary to version-probe; entrypoint compat-check treats
  # an empty string as "not installed" and openclaw's supportedRange is
  # "*" so the mismatch path won't fire.
  return 0
}
