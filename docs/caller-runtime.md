# Dedicated caller containers (Claude and Codex)

PR #506 implements the caller-isolation portion of #497 R2 and R4 on
`codex/497-docker-runtimes`. Each directly authenticated principal gets a
reusable Docker container and dedicated workspace/session volumes under one
public agent identity and bridge connection. A new `contextId` from the same
principal uses the same container and workspace, with a separate conversation.

This is opt-in. OpenClaw, delegated scopes, OpenAI compatibility, caller tools,
MCP integration, outgoing file delivery and automatic idle reclamation are not
supported in this mode. The two execution modes are `host` (default) and
`container` (dedicated per caller); shared-container execution is no longer
available through the daemon.

## Initial setup

Use Linux or macOS with a running Docker engine. Register the agent with
`vicoop-client auth login` and `vicoop-client agent register` first, and prepare
Claude/Codex authentication on the host. Then run:

```sh
vicoop-client container init claude
vicoop-client start --detach
```

Use `codex` instead of `claude` for Codex. `container init` selects that backend
in the canonical config, checks that host credentials are available, builds the
bundled Claude/Codex image and checks the selected CLI version in a temporary,
networkless container. It writes the immutable image ID and a private
agent/backend-specific `caller_runtime.stateDirectory` beside config.json,
initializes SQLite state, and sets `runtime: "container"`. No repository checkout
or manual config editing is required. Provider credentials are not copied or
passed into the image build/probe; availability checks do not make model calls.
Caller containers are allocated only when their first authenticated task arrives.

The first build downloads packages and backend binaries. Later initialization
reuses the configured image and preserves state paths, resource limits, other
backend settings and agent credentials. Legacy `cwd`/`runtime_name` settings are
removed only after validation succeeds. Build/authentication/probe failures leave
the config unchanged; concurrent config edits abort the save. Stop the daemon and
caller containers before reinitializing. A different image requires removing
retained containers via `caller-state --recreate-scope` first (volumes and mappings
are retained). Initialization never changes an existing state-directory path.

```sh
# A separate registered-agent config and an existing/custom image:
vicoop-client container init codex --config /path/to/config.json --image my-caller:tag
vicoop-client start --detach --config /path/to/config.json
# Choose a state path on first initialization:
vicoop-client container init claude --state-directory /private/claude-callers
# Rebuild the bundled recipe rather than reuse the configured image:
vicoop-client container init claude --rebuild
```

`--image` accepts a tag or digest, pulls it if missing, and persists its immutable
local image ID. Images must include the backend, Node, tini and firewall tools,
and must not declare anonymous volumes or provider credential environment.
`--from-host` remains a compatibility flag; authentication always stays on the
host. Shared-container `--name`, `--workspace`, `--reuse-state` and `--bridge`
options are rejected with a migration hint.

## Advanced image and configuration control

The bundled recipe is also available in the repository for custom builds:

On Linux or macOS with Docker, build the backend-installed image from the repo:

```sh
docker build -t vicoop-caller:local -f packages/client/docker/caller-runtime/Dockerfile .
docker image inspect vicoop-caller:local --format '{{.Id}}'
```

The recipe pins Claude 2.1.267 and Codex 0.153.4; build arguments can select
compatible versions. Claude uses the repository's checksum-verified native
installer. Codex requires version 0.153.4 or later. Use the resulting immutable
`sha256:...` image ID (or a registry digest), not a mutable tag, in config.json:

```json
{
  "server_url": "https://your-bridge.example",
  "server_token": "YOUR_AGENT_TOKEN",
  "agent_id": "YOUR_AGENT_ID",
  "backend": "claude",
  "backends": {
    "claude": {
      "runtime": "container",
      "caller_runtime": {
        "image": "sha256:REPLACE_WITH_64_HEX_DIGEST",
        "stateDirectory": "/absolute/private/path/claude-callers",
        "maxScopes": 8,
        "queueLimit": 16,
        "maxContexts": 256,
        "taskTimeoutMs": 600000,
        "memoryMiB": 2048,
        "cpus": 1,
        "pids": 256,
        "storageMiB": 1024
      }
    }
  }
}
```

For Codex, set `backend` to `codex` and place the same runtime configuration
under `backends.codex`. Use a separate state directory per agent/backend.
`stateDirectory` must be private (0700); it is created automatically if absent.
Do not configure `cwd` or `runtime_name`: the manager owns workspace and runtime
selection. Invalid runtime configuration fails closed.

```sh
vicoop-client start --config /path/to/config.json
# or
vicoop-client start --detach --config /path/to/config.json
vicoop-client stop
```

Authentication uses the existing Claude/Codex host broker readers. Provider
credentials remain on the host; workloads receive short-lived execution grants.
Host credential rotation/expiry follows [Claude broker](claude-auth-broker.md)
and [Codex broker](codex-auth-broker.md) rules. Refresh remains operator-managed.
The default host Codex model selection is forwarded without copying its config,
credentials, operator conversations or harness into caller storage.

## Migrating runtime selection

`runtime: "container"` now always means per-caller isolation. The earlier
`caller-container` name is rejected with a migration hint; change it to
`container` and retain the existing `caller_runtime` configuration/state path.
There is no shared-container option or automatic host fallback.

For a legacy shared `container` configuration, stop the daemon, preserve its
existing volumes, and configure a pinned backend-installed image plus private
`caller_runtime.stateDirectory` as shown above. Remove `cwd`, `runtime_name`
and `--runtime-name`: the manager allocates workspace volumes and container
names from the verified caller scope. The daemon rejects incomplete legacy
configuration before accepting tasks. Legacy shared workspaces/sessions are not
automatically assigned or copied to any caller.

`container init` now prepares per-caller execution and can migrate the selected
backend configuration automatically. `container list/remove/validate` remain
available for managing legacy per-backend resources; they do not select caller
containers. Use `caller-state` for per-caller resource administration.
Host execution (including a client already inside a bundled-direct container)
keeps its existing behavior.

## Scope, lifetime and persistence

The server derives scope from agent identity and authenticated principal. The
client checks that scope against caller identity and execution generation before
allocation. Missing identity, forged scope, missing capability negotiation and
delegation never fall back to a shared runtime. Public agents still require
caller authentication when they advertise container execution. Shared
API keys identify the same principal and therefore share the same environment.

Each scope owns a private Docker network and two named volumes: `/workspace`
and `/data/sessions/<backend>`. The root filesystem is read-only; writable HOME
and temporary directories are bounded tmpfs. There are no host filesystem or
Docker socket mounts. Real provider secrets are not copied into the image,
volumes, CLI arguments or workload environment. The broker firewall blocks
private/host services; its provider relay is bound to container loopback.

Container lifetime is distinct from execution lifetime. Requests are serialized
within a scope, including allocation and confirmed cleanup. Different scopes
can execute concurrently. Successful tasks keep the container running. Claude
reuses its live session binding; Codex launches a supervised app-server per
execution and resumes its scope/context-specific thread on the next request.

Cancellation revokes the execution grant, terminates the execution, and stops
only the affected scope's container before returning a failure. Unconfirmed
cleanup quarantines that scope until offline recovery. Canceling a queued
waiter does not stop its predecessor or another caller. The next request after
a stopped/failed execution restarts that user's container and reports an explicit
conversation reset. Generation-scoped server cancellation may suppress terminal
frames according to the existing replay protocol.

Workspace and backend conversation **files** survive container stop/recreation
and daemon restart. The scope-to-conversation binding is currently in memory:
a daemon restart starts a fresh conversation and emits
`metadata["vicoop.runtime"].conversationReset = true` with
`workspaceRestored = true`. It does not claim to resume old conversations.
Cancellation/failure retains partial filesystem writes; there is no transactional
rollback or exactly-once execution guarantee after a lost response.

Startup takes an exclusive host owner lock and reconciles previously managed
containers before accepting requests. Labels, image, mounts, resource settings
and runtime boundaries are checked before reuse. An unknown or mismatched
resource fails closed. Do not manually edit scope records or share a state
directory between daemons. A crash during owner-record mutation can leave
`.guard`; inspect owner/process state before manually removing that guard.

## Capacity and storage limits

Scope count includes retained stopped scopes; it does not automatically evict
users. Queue length, conversations per scope, task duration, container CPU,
memory and PIDs are bounded. Full-capacity requests fail explicitly.

`storageMiB` is the combined workspace/session **monitored threshold**. Usage is
checked on acquisition, once per second during execution, and before successful
completion. A violation stops the affected scope; its files remain for offline
inspection/deletion. This is **not a filesystem hard quota**: a fast writer can
overshoot between checks, and a full Docker disk can affect all containers. Use
host/Docker storage capacity controls for hostile workloads requiring a strict
disk boundary. The initial implementation does not claim that acceptance gate.

## Offline administration

Stop the daemon first. Administration takes the same exclusive ownership lock
and refuses to operate while a live owner or running managed container exists.
Stopped containers can be recreated or deleted after changing CPU, memory, PID
or scope-count limits. Ownership and isolation checks still apply; execution
requires the container to match the new limits.

```sh
vicoop-client caller-state --config /path/to/config.json
# Remove one stopped container/network; keep its volumes for next allocation:
vicoop-client caller-state --config /path/to/config.json --recreate-scope SCOPE_DIGEST
# Explicitly delete that user's container, network, volumes and scope record:
vicoop-client caller-state --config /path/to/config.json --delete-scope SCOPE_DIGEST
```

Scope digests and Docker names are opaque; callers cannot select them. Stop,
restart and recreation do not implicitly delete user data. If Docker access or
ownership validation fails, inspect the named resources before retrying; never
clear another caller's storage to recover an unrelated scope.

## Rollout and validation

Deploy the compatible server before enabling the client. The client requires
`caller-runtime-v1`, `execution-scope-v1` and replay acknowledgement; an older
server makes it refuse work. Rollback: stop caller mode, keep its volumes/state,
and choose host mode explicitly. Old #499 snapshot archives
are incompatible with this storage schema and are not automatically imported.

The source includes these acceptance entrypoints:

- `scripts/caller-init-smoke.mjs`: standalone compiled CLI initialization outside
  the repository, embedded image build, backend probes, private state creation,
  config preservation and repeat initialization; no provider calls.
- `scripts/caller-runtime-smoke.ts`: real Docker lifecycle, A/B/A storage,
  stop/recreate/restart, owner lock, input transfer and threshold admission.
- `scripts/caller-client-smoke.mjs`: the Bun-compiled CLI, a local WebSocket
  fixture, and deterministic Claude/Codex processes in real Docker. It exercises
  conversation routing, container identity, cancellation, reconnect, crash
  recovery and offline recreation; it does not call a model.
- `scripts/caller-provider-smoke.ts`: actual host authentication and model calls,
  including A/B/A conversation/workspace behavior, observed-tool cancellation
  and restart/reset. Requires
  available credentials, provider access and sufficient Docker disk space.

See the PR for exact completed runs and remaining validation. Unit tests and
fixture smokes are not a substitute for real-provider acceptance.

## Identity storage format (foundation for #507)

The private state directory stores scope mappings in `state.sqlite` (SQLite
schema version 4, exposed as `PRAGMA user_version`). The `scopes` table contains
`id` (scope digest), `kind` (backend), `namespace`, `agentId` and nullable
`principalId`, with an index on `(agentId, principalId, kind)`. The `metadata`
table binds the database to its agent, host and namespace. Only a principal from
an already validated direct execution scope is recorded; the store independently
checks its digest against the scope. No credentials, tokens, caller display names
or request metadata are stored. The directory remains 0700 and the database is
0600. Principal IDs are not added to Docker names/labels or `caller-state` output.

Mapping writes and migration use SQLite transactions. The standalone Bun client
uses built-in SQLite; Node/tsx development uses `better-sqlite3` (Node 20 or later
supported by the pinned dependency). Docker ownership still uses the exclusive
host lock: a database transaction cannot make Docker resource changes atomic.
The small `manifest.json` compatibility marker and `owner.json` process lock
remain JSON; scope mappings are stored only in SQLite after migration.

Version 2/3 JSON stores migrate on startup under the exclusive owner lock. All
records are validated and imported in one transaction. Hash-only records retain
`principalId: null` (unknown); a later validated request for that exact scope
fills the mapping. Startup/offline reconciliation never guesses an identity or
clears a known mapping. Corrupt, mismatched and unsupported records fail closed.
Container names and volumes do not change.

The manifest advances to version 4 with a pending migration marker before import,
so old JSON readers refuse the store. An interrupted import can be retried; an
already committed import is never replayed. Original scope JSON files remain as
inert migration backups and are not read after migration, including after scope
deletion. Deleting a scope also removes its matching JSON backup. Other backups
can be removed after verifying the migration; they may contain principal IDs.
A missing committed database is an error, not an invitation to rebuild it from
stale backups. Stop the daemon before copying the state directory
for backup. Do not lower the manifest version to downgrade; restore a complete
pre-upgrade backup instead.

User lookup, live inspection and environment initialization/reapplication remain
in #507; this change only establishes the persisted identity mapping.


The standalone image assets are generated by
`node packages/client/scripts/generate-caller-image.mjs` from the reviewed
Dockerfile and Claude installer. Regenerate them after changing either source;
CI verifies their contents match.
