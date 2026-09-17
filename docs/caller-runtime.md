# Dedicated caller containers (Claude and Codex)

PR #506 implements the caller-isolation portion of #497 R2 and R4 on
`codex/497-docker-runtimes`. Each directly authenticated principal gets a
reusable Docker container and dedicated workspace/session volumes under one
public agent identity and bridge connection. A new `contextId` from the same
principal uses the same container and workspace, with a separate conversation.

This is opt-in. OpenClaw, delegated scopes, OpenAI compatibility, caller tools,
MCP integration, outgoing file delivery and automatic idle reclamation are not
supported in this mode. Host and single-container modes remain available.

## Prepare an image and configuration

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
      "runtime": "caller-container",
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

## Scope, lifetime and persistence

The server derives scope from agent identity and authenticated principal. The
client checks that scope against caller identity and execution generation before
allocation. Missing identity, forged scope, missing capability negotiation and
delegation never fall back to a shared runtime. Public agents still require
caller authentication when they advertise caller-container execution. Shared
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
and choose host or single-container mode explicitly. Old #499 snapshot archives
are incompatible with this storage schema and are not automatically imported.

The source includes three separate acceptance entrypoints:

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
