---
"@vicoop-bridge/client": minor
---

The bridge usage API now reports a canonical, backend-agnostic shape (`BridgeUsage`) for both backends, so a single consumer can read remaining quota regardless of backend:

- **claude** (new): reports the operator's Claude subscription quota. Reads the Claude Code OAuth token from the host (macOS Keychain, or `~/.claude/.credentials.json` on Linux/Windows), calls the authenticated `api/oauth/usage` endpoint (5-hour / weekly / Sonnet windows + monetary extra-usage), cached ~5 min to respect the endpoint's self-rate-limit. When the read fails it serves the last successful snapshot (stale, annotated) or an explicit `source: 'none'`.
- **vicoop-codex**: its serve `/usage` payload is now normalised into the same shape (was forwarded verbatim).

Canonical shape: `{ backend, source, fetchedAt, accounts: [{ id, label?, plan?, windows: [{ id, label, usedPercent, resetsAt, severity }], spend? }], note?, raw }`. Conventions are fixed — `usedPercent` is 0–100 percent used (remaining = 100 − usedPercent), `resetsAt` is ISO 8601 — and the verbatim upstream payload is preserved under `raw`.

The claude OAuth read path also gained, to match the reference monitor's robustness: `$CLAUDE_CONFIG_DIR` support for the credentials file; an official-client `User-Agent: claude-code/<version>` (discovered from the CLI) + `Content-Type`; `Retry-After`-aware backoff on 429; serving the last successful snapshot (stale, annotated) on a transient failure; best-effort CLI-delegated token refresh on auth expiry/401; and a retry-storm guard that won't re-send a known-dead token until it rotates.

The stream's `rate_limit_event` is captured only to enrich `spend.resetsAt` (the monthly overage reset the oauth `extra_usage` block omits); it is deliberately NOT used as a usage fallback, because it reports only the single most-constrained window (e.g. a near-cap overage meter) and would misrepresent the subscription quota.
