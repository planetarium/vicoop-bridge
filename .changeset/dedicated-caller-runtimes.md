---
"@vicoop-bridge/client": minor
---

Make container execution caller-isolated for Claude and Codex with reusable per-user Docker containers, dedicated persistent workspace/session volumes, host authentication brokers, execution cleanup, restart recovery and offline state administration. This replaces shared-container daemon execution: configure caller_runtime image/stateDirectory and remove cwd/runtime_name. The draft caller-container spelling is retired; host remains the default. Requires a compatible bridge server, an immutable backend-installed image and explicit caller runtime configuration. Conversation bindings reset after daemon restart; persistent partial writes are retained on cancellation. Storage thresholds are monitored admission limits, not filesystem hard quotas.

Persist validated principal-to-scope mappings in a private SQLite database with transactional migration from version-2/3 JSON stores. Legacy hash-only records remain unknown until a matching validated request arrives; the version-4 manifest blocks older JSON state readers. User lookup and environment initialization remain follow-up work.
