---
"@vicoop-bridge/client": minor
---

Make container execution caller-isolated for Claude and Codex with reusable per-user Docker containers, dedicated persistent workspace/session volumes, host authentication brokers, execution cleanup, restart recovery and offline state administration. This replaces shared-container daemon execution: configure caller_runtime image/stateDirectory and remove cwd/runtime_name. The draft caller-container spelling is retired; host remains the default. Requires a compatible bridge server, an immutable backend-installed image and explicit caller runtime configuration. Conversation bindings reset after daemon restart; persistent partial writes are retained on cancellation. Storage thresholds are monitored admission limits, not filesystem hard quotas.


For users upgrading from a released client:

- **Host execution:** no runtime configuration change is required. Host remains
  the default, including bundled-direct deployments that run the client itself
  inside a container. Caller isolation is an explicit opt-in.
- **Existing shared Docker execution:** `runtime: "container"` now selects
  caller-isolated execution. Stop the old daemon before upgrading with
  `vicoop-client stop --config /path/to/config.json` and keep a backup of its configuration and existing volumes. Prepare Claude/Codex
  authentication on the host, then initialize the selected backend with the same
  agent configuration:

  ```sh
  vicoop-client container init claude --config /path/to/config.json
  vicoop-client start --detach --config /path/to/config.json
  ```

  Use `codex` instead of `claude` for Codex; omit `--config` for the canonical
  configuration. Initialization preserves agent registration and unrelated
  settings, and replaces the selected backend's legacy `cwd`/`runtime_name`
  configuration only after validation succeeds. Remove `--runtime-name` and
  legacy `--cwd` overrides from your container launch scripts too.
- **Existing files and sessions:** initialization does not delete or automatically
  copy shared Docker workspaces, credentials or sessions into caller storage.
  Each authenticated caller starts with a new environment on its first request;
  retain the old volumes separately if their contents are needed. Legacy resource
  inspection is available through `container legacy list`.
- **Server compatibility:** caller isolation requires a compatible bridge server
  advertising execution-scope support; update the server before activating it.
  An incompatible server is rejected rather than falling back to shared execution.

Caller-scoped runtime storage has not appeared in a released client, so upgrading
released versions does not require migration of an earlier caller-scoped volume
format. See the [caller runtime setup and transition guide](https://github.com/planetarium/vicoop-bridge/blob/main/docs/caller-runtime.md)
for initialization requirements and supported features.

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

Reject removal/recreation when another container mounts caller volumes before dismantling resources, and disable traceability negotiation in text-output-only caller runtimes.

Keep canceled waiter barriers counted against queue capacity until predecessors settle, and make offline-only retained-volume validation explicit.

Persist completed caller allocations in SQLite so interrupted initial allocation cannot become automatic recreation, rebuild workers on Docker ID changes, and filter traceability from server-synthesized caller cards.

Keep pending reservation evidence across rollback failures and restarts to prevent orphan adoption, and record completion when reconciliation validates older containers.
