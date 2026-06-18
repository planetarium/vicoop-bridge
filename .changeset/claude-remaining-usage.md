---
"@vicoop-bridge/client": minor
---

The bridge usage API now reports a canonical, backend-agnostic shape (`BridgeUsage`) for both backends, so a single consumer can read remaining quota regardless of backend:

- **claude** (new): reports the operator's Claude subscription quota. Reads the Claude Code OAuth token from the host (macOS Keychain, or `~/.claude/.credentials.json` on Linux/Windows), calls the authenticated `api/oauth/usage` endpoint (5-hour / weekly / Sonnet windows + monetary extra-usage), cached ~5 min to respect the endpoint's self-rate-limit. Falls back to the latest `rate_limit_event` window when the token is missing/expired or the endpoint refuses.
- **vicoop-codex**: its serve `/usage` payload is now normalised into the same shape (was forwarded verbatim).

Canonical shape: `{ backend, source, fetchedAt, accounts: [{ id, label?, plan?, windows: [{ id, label, usedPercent, resetsAt, severity }], spend? }], note?, raw }`. Conventions are fixed — `usedPercent` is 0–100 percent used (remaining = 100 − usedPercent), `resetsAt` is ISO 8601 — and the verbatim upstream payload is preserved under `raw`.
