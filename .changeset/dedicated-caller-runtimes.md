---
"@vicoop-bridge/client": minor
---

Make container execution caller-isolated for Claude and Codex with reusable per-user Docker containers, dedicated persistent workspace/session volumes, host authentication brokers, execution cleanup, restart recovery and offline state administration. This replaces shared-container daemon execution: configure caller_runtime image/stateDirectory and remove cwd/runtime_name. The draft caller-container spelling is retired; host remains the default. Requires a compatible bridge server, an immutable backend-installed image and explicit caller runtime configuration. Conversation bindings reset after daemon restart; persistent partial writes are retained on cancellation. Storage thresholds are monitored admission limits, not filesystem hard quotas.

Persist validated principal-to-scope mappings in a private SQLite database with transactional migration from version-2/3 JSON stores. Legacy hash-only records remain unknown until a matching validated request arrives; the version-4 manifest blocks older JSON state readers. User lookup and environment initialization remain follow-up work.

Make `container init claude|codex` prepare per-caller execution end to end: check host authentication, build an embedded backend image without a repository checkout or validate `--image`, initialize private SQLite state and save the immutable image/configuration. Preserve registration and unrelated settings, reject active state and unsafe image replacement, and leave config unchanged on failure. Legacy shared-container init flags now report migration guidance.

Allow offline recreation/deletion after resource-limit changes, release unused caller capacity when requests cancel before allocation, and preserve caller runtime configuration when execution mode is selected via CLI.

Reject invalid runtime selectors and relative state paths. Unify caller administration under container list/validate/recreate/remove (canonical config by default), move old shared-container tools under container legacy, and retain caller-state as a compatibility alias. Offline cleanup no longer requires the execution image. Initialization verifies writable workspace/session volumes as the workload user; update migration guidance and legacy harness tooling accordingly.

Validate actual per-caller network membership, network ownership/options and exact tmpfs bounds on reuse. Propagate initialization cancellation, distinguish storage inspection failures from quota violations, emit recovery status once, reject retired runtime-name flags, check required image helpers, and serialize CLI configuration writes with snapshot checks.

Fail closed and quarantine retained callers when persistent volumes disappear. Validate init state paths before normalization, reject empty retired options, and make legacy harness output explicitly non-executable by the current daemon.

Reject explicit empty image references, propagate task cancellation through Docker allocation, share supported-version checks between init and daemon, and coalesce Codex catalog requests across scopes with credential/version invalidation and independent caller cancellation.

Report missing retained volumes during explicit offline validation, release caller capacity when allocation ends before SQLite reservation, and require caller-context-v2 in isolated capability negotiation.

Cancel inline-image transfers and in-flight storage inspections promptly, preserve conversations when acquisition is canceled before Docker mutation, and align caller-context-v2 acknowledgement across client/server negotiation and lifecycle fixtures.

Reject retained containers with automatic port publishing and validate backend-specific inline-file MIME/size before reserving caller capacity.

Reject orphan Docker resources for newly reserved callers without adopting them on restart. Allowlist and copy Claude caller settings so arbitrary operator environment, hooks and helpers never enter caller workloads.

Validate all administration scope selectors, permit ownership-checked offline cleanup of missing/drifted networks, and rebuild workers with explicit conversation reset after externally stopped containers restart.

Preflight all retained resource ownership before removal, reset workers after retained-container recreation, and retain the daemon pidfile with a nonzero exit on unconfirmed shutdown.

Validate complete network membership during removal while accepting a stopped container’s own endpoint. Align container cards with inline-input admission, accept Claude [1m] model tiers, and verify generated embedded images in CI.

Reject cross-backend state-directory aliases during initialization, report conversation recovery per context, preserve failed caller-daemon shutdown records in `stop`, and document lazy Codex catalog loading.

Share one bounded shutdown operation across fatal disconnects and signals, removing the detached pidfile only after confirmed cleanup and retaining fatal exit status.

Reject invalid sibling-backend state paths before initialization side effects and advertise text-only caller outputs.
