---
"@vicoop-bridge/client": minor
---

Add `vicoop-client agent apikey {generate,list,revoke}` for static API key callers. Operators can now mint a long-lived bearer key for an agent — for CI jobs and backend services that can't run the interactive Google/SIWE login — list a key's metadata, and revoke it. `generate` prints the secret exactly once and auto-authorizes its `apikey:<key-id>` principal on the agent; `--ttl-days` overrides the default 365-day lifetime.

`agent register` without `--caller` no longer leaves the agent publicly callable: it auto-mints a static API key, seeds `allowed_callers` with the key's principal, and prints the one-time secret (under `api_keys` in `--json`). If minting fails it falls back to the previous public-agent warning. The deprecated `setup` alias keeps its old warning behavior.
