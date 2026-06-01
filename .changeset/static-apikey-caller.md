---
"@vicoop-bridge/client": minor
---

Add static API key callers, unified under the `agent callers` command group. `vicoop-client agent callers issue-api-key <agent>` mints a long-lived bearer key — for CI jobs and backend services that can't run the interactive Google/SIWE login — printing the secret exactly once and auto-authorizing its `apikey:<key-id>` principal on the agent (`--ttl-days` overrides the default 365-day lifetime). Keys are just callers: `agent callers list` shows them (TYPE=apikey) and `agent callers remove <agent> apikey:<key-id>` both de-authorizes the principal and revokes the underlying token.

`agent register` without `--caller` no longer leaves the agent publicly callable: it auto-mints a static API key, seeds `allowed_callers` with the key's principal, and prints the one-time secret (under `api_keys` in `--json`). If minting fails it falls back to the previous public-agent warning. The deprecated `setup` alias keeps its old warning behavior.
