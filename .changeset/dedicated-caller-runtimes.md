---
"@vicoop-bridge/client": minor
---

Make Claude and Codex container execution caller-isolated, with reusable containers, private networks and persistent workspace/session storage per authenticated principal. `container init claude|codex` validates host authentication, builds or validates the backend image, prepares the bundled fixed-storage helper and shared pool, initializes private SQLite state and saves the configuration. Initialization requires no repository checkout or manual JSON editing; failures preserve the previous configuration.

Normal initialization enables fixed ext4 storage with synchronous block/inode limits. Workspace and sessions share the configured filesystem capacity, including filesystem overhead. Pool admission preserves a free-space reserve within the Docker backing filesystem; it does not reserve physical space outside thin VM/block devices. Retained storage identities and data survive recreation, and incompatible capacity/pool changes are rejected.

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


Manage caller environments through `container list`, `validate`, `recreate` and `remove`; old shared-runtime administration is under `container legacy`. Ownership and mount validation reject foreign, missing or incompatible resources. Interrupted allocations and uncertain cleanup retain recovery records rather than silently adopting or deleting data.

Execution leases serialize same-caller work. Cancellation waits for process cleanup while preserving partial file writes. Workspace/session files survive daemon restarts and container recreation, but live conversation bindings reset with an explicit conversation-reset signal. Provider credentials remain on the host, and caller workloads do not receive the Docker socket, backing storage pool or host devices.

This release supports directly authenticated Claude/Codex callers with text outputs. Delegated scopes, isolated OpenClaw, unsupported MCP/caller-tool combinations, and automatic conversation restoration remain unavailable. Host execution remains the default.
