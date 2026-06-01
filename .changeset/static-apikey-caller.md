---
"@vicoop-bridge/client": minor
---

Add `vicoop-client agent apikey {generate,list,revoke}` for static API key callers. Operators can now mint a long-lived bearer key for an agent — for CI jobs and backend services that can't run the interactive Google/SIWE login — list a key's metadata, and revoke it. `generate` prints the secret exactly once and auto-authorizes its `apikey:<key-id>` principal on the agent; `--ttl-days` overrides the default 365-day lifetime.
