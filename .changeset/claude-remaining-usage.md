---
"@vicoop-bridge/client": minor
---

claude backend now answers the bridge usage API with the operator's Claude subscription remaining quota. It reads the Claude Code OAuth token from the host (macOS Keychain, or `~/.claude/.credentials.json` on Linux/Windows) and returns the authenticated `api/oauth/usage` snapshot (5-hour, weekly, and extra-usage windows), cached ~5 min to respect the endpoint's self-rate-limit. When the token is missing/expired or the endpoint refuses, it falls back to the latest `rate_limit_event` window seen on the task stream.
