---
"@vicoop-bridge/client": minor
---

Add opt-in caller-container execution for Claude and Codex with reusable per-user Docker containers, dedicated persistent workspace/session volumes, host authentication brokers, execution cleanup, restart recovery and offline state administration. Requires a compatible bridge server, an immutable backend-installed image and explicit caller runtime configuration. Conversation bindings reset after daemon restart; persistent partial writes are retained on cancellation. Storage thresholds are monitored admission limits, not filesystem hard quotas.

Persist validated principal-to-scope mappings in private version-3 state records. Legacy hash-only records remain unknown until a matching validated request arrives; the upgraded manifest blocks older state readers. User lookup and environment initialization remain follow-up work.
