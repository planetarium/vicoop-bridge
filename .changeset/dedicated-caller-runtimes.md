---
"@vicoop-bridge/client": minor
---

Make container execution caller-isolated for Claude and Codex with reusable per-user Docker containers, dedicated persistent workspace/session volumes, host authentication brokers, execution cleanup, restart recovery and offline state administration. This replaces shared-container daemon execution: configure caller_runtime image/stateDirectory and remove cwd/runtime_name. The draft caller-container spelling is retired; host remains the default. Requires a compatible bridge server, an immutable backend-installed image and explicit caller runtime configuration. Conversation bindings reset after daemon restart; persistent partial writes are retained on cancellation. Storage thresholds are monitored admission limits, not filesystem hard quotas.

Persist validated principal-to-scope mappings in a private SQLite database with transactional migration from version-2/3 JSON stores. Legacy hash-only records remain unknown until a matching validated request arrives; the version-4 manifest blocks older JSON state readers. User lookup and environment initialization remain follow-up work.

Make `container init claude|codex` prepare per-caller execution end to end: check host authentication, build an embedded backend image without a repository checkout or validate `--image`, initialize private SQLite state and save the immutable image/configuration. Preserve registration and unrelated settings, reject active state and unsafe image replacement, and leave config unchanged on failure. Legacy shared-container init flags now report migration guidance.

Allow offline recreation/deletion after resource-limit changes, release unused caller capacity when requests cancel before allocation, and preserve caller runtime configuration when execution mode is selected via CLI.

Reject invalid runtime selectors and relative state paths. Unify caller administration under container list/validate/recreate/remove (canonical config by default), move old shared-container tools under container legacy, and retain caller-state as a compatibility alias. Offline cleanup no longer requires the execution image. Initialization verifies writable workspace/session volumes as the workload user; update migration guidance and legacy harness tooling accordingly.
