# Dedicated caller containers (Claude and Codex)

PR #506 implements the caller-isolation portion of #497 R2 and R4 on
`codex/497-docker-runtimes`. Each directly authenticated principal or verified federated user gets a
reusable Docker container and dedicated workspace/session volumes under one
public agent identity and bridge connection. A new `contextId` from the same
principal uses the same container and workspace, with a separate conversation.

This is opt-in. OpenClaw, unsupported delegation profiles, OpenAI compatibility, caller tools,
general MCP integration and automatic idle reclamation are not supported in
this mode. Claude supports opt-in outgoing file delivery through the bridge-owned
`send_file` helper described below; Codex output remains text-only. The two execution modes are `host` (default) and
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
builds the bundled storage helper, provisions and probes fixed ext4 storage,
initializes SQLite state, and sets `runtime: "container"`. See the
[storage guide](caller-fixed-storage.md) for pool sharing, capacity flags and recovery. No repository checkout
or manual config editing is required. Provider credentials are not copied or
passed into the image build/probe; availability checks do not make model calls.
Caller containers are allocated only when their first authenticated task arrives.

The first build downloads packages and backend binaries. Later initialization
reuses the configured image and preserves state paths, resource limits, other
backend settings and agent credentials. Legacy `cwd`/`runtime_name` settings are
removed only after validation succeeds. Build/authentication/probe failures leave
the config unchanged. CLI config writes use an exclusive lock; initialization
checks its original snapshot under that lock and aborts if preparation-time
edits are detected. External editors do not participate in this lock, so finish
manual edits before initialization. A crashed writer can leave `config.json.lock`;
inspect the writer/process before removing that lock directory. Stop the daemon and
caller containers before reinitializing. A different image requires removing
retained containers via `container recreate SCOPE` first (volumes and mappings
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
The image must provide `/workspace` and `/data/sessions/<kind>/config` writable
by UID/GID 1000:1000. Initialization tests writes as that user in disposable
anonymous volumes; they are removed along with the networkless probe.
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
`sha256:...` image ID (or a registry digest) with `container init --image IMAGE`.
Init fills in both pinned images and the validated pool policy; the resulting config
with the standard defaults looks like this (digests are placeholders):

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
        "idleTimeoutMs": 0,
        "memoryMiB": 2048,
        "cpus": 1,
        "pids": 256,
        "storageMiB": 1024,
        "fixedImageStorage": {
          "image": "sha256:REPLACE_WITH_STORAGE_HELPER_64_HEX_DIGEST",
          "poolVolume": "vicoop-caller-storage",
          "capacityMiB": 8192,
          "reserveMiB": 1024,
          "reservationBoundary": "docker-filesystem"
        }
      }
    }
  }
}
```

For Codex, set `backend` to `codex` and place the same runtime configuration
under `backends.codex`. Use a separate state directory per agent/backend.
`stateDirectory` must be an absolute path and private (0700); it is created
automatically if absent. Relative paths are rejected to keep state independent
of the directory from which the CLI is launched.
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
backend configuration automatically. `container list/validate/recreate/remove`
manage per-caller resources. Old shared-container tools are explicitly under
`container legacy list/remove/validate`.
Host execution (including a client already inside a bundled-direct container)
keeps its existing behavior.

## Scope, lifetime and persistence

The server derives scope from agent identity and authenticated principal. The
client checks that scope against caller identity and execution generation before
allocation. Missing identity, forged scope, missing capability negotiation and
unsupported delegation never falls back to a shared runtime. Public agents still require
caller authentication when they advertise container execution. Shared
API keys identify the same principal and therefore share the same environment.

Mentionable OAuth federation (including Slack callers) uses the existing exact
`federated:v1:...` issuer/method/subject grant as the environment principal. The
connector actor alone and a bare `slack:WORKSPACE/USER` subject are **not** the
environment key. Different issuers, methods or subjects get different volumes;
new tokens and task continuations for the same tuple reuse the same environment.
Only authenticated token-exchange identity selects this scope; presented identity
attestations and request metadata cannot select or override it. Other delegation
profiles remain unsupported.

Both server and client must support `federated-execution-scope-v1`, in addition to
the existing caller-runtime capabilities. Old clients are rejected before task
binding/allocation; new clients connected to old servers can still run direct
callers but cannot run federated callers. Direct scope hashes do not change.

Existing grant/token expiry, revocation, task ownership and continuation checks
remain at the HTTP authorization boundary. Revoking a grant does not erase its
workspace or create a new identity. Restore access only intentionally: re-granting
the same tuple reuses its retained files, while revoked old tasks stay revoked.
Use `container remove` separately when retained data must be deleted.

Input admission runs before allocating caller storage: Claude accepts inline
PNG/JPEG/WebP/GIF images and PDF documents, while Codex accepts those images only.
Each file is limited to 5 MiB decoded; unsupported MIME types, oversized files,
URI inputs and data parts are rejected before reserving a caller scope.

Each scope owns a private Docker network and two named volumes: `/workspace`
and `/data/sessions/<backend>`. The root filesystem is read-only; writable HOME
and temporary directories are bounded tmpfs. There are no host filesystem or
Docker socket mounts. Real provider secrets are not copied into the image,
volumes, CLI arguments or workload environment. The broker firewall blocks
private/host services; its provider relay is bound to container loopback.

Container lifetime is distinct from execution lifetime. Requests are serialized
within a scope, including allocation and confirmed cleanup. Different scopes
can execute concurrently. By default, successful tasks keep the container running. Claude
reuses its live session binding; Codex launches a supervised app-server per
execution and resumes its scope/context-specific thread on the next request.

Cancellation revokes the execution grant, terminates the execution, and stops
only the affected scope's container before returning a failure. Unconfirmed
cleanup quarantines that scope until offline recovery. Canceling a queued
waiter does not stop its predecessor or another caller. Cancellation during
read-only acquisition, before any Docker mutation or execution, also preserves
the existing container and conversation. The next request after
a stopped/failed execution restarts that user's container and reports an explicit
conversation reset. If Docker stops or removes a container while the daemon remains alive,
the next request restarts it with a fresh worker and an explicit conversation
reset. Generation-scoped server cancellation may suppress terminal
frames according to the existing replay protocol.

Workspace and backend conversation **files** survive container stop/recreation
and daemon restart. The scope-to-conversation binding is currently in memory:
a daemon restart starts a fresh conversation and emits
`metadata["vicoop.runtime"].conversationReset = true` with
`workspaceRestored = true`. It does not claim to resume old conversations.
Cancellation/failure retains partial filesystem writes; there is no transactional
rollback or exactly-once execution guarantee after a lost response.

Startup takes an exclusive host owner lock and reconciles previously managed
containers before accepting requests. Labels, image, mounts, exact tmpfs bounds and resource settings are checked
before reuse. The actual network attachment must be the one owned per-scope
bridge network, with no foreign container endpoints or custom network options. An unknown or mismatched
resource fails closed. Do not manually edit scope records or share a state
directory between daemons. A crash during owner-record mutation can leave
`.guard`; inspect owner/process state before manually removing that guard.

## Idle stop and resume

Set `caller_runtime.idleTimeoutMs` to a positive integer to stop unused caller
containers automatically (for example, `300000` for five minutes). The default
and explicit disabled value is `0`; the maximum is `2147483647` milliseconds.
The idle interval starts after the last admitted request and all of its cleanup
have settled, including backend processes, file delivery and storage checks.
Model/tool calls, approval waits and queued requests are busy even when they
produce no output. A new admitted request cancels the timer. If idle cleanup
has already begun, the request waits for confirmed stop before acquiring a
fresh worker. Idle cleanup uses the same per-scope queue as execution.

Idle stop closes the worker/broker, reconciles storage helpers and confirms
container termination. It retains the scope and caller identity, workspace and
session volumes, fixed-storage reservation, preparation version/readiness and
shared mounts. The next authorized request validates the retained container's
boundary and starts it again. Both Claude and Codex currently lose their
in-memory conversation bindings when the worker is released: **session files
remain, but conversation continuity is not restored**. The first request for
each context after recovery emits `metadata["vicoop.runtime"]` with
`workspaceRestored: true` and `conversationReset: true` before backend output.
Subsequent requests in that worker can reuse their new conversations normally.

Shorter timeouts reclaim runtime memory and processes sooner, at the cost of
more container/worker startup latency and more frequent conversation resets.
This does not reclaim disk space or admit additional retained callers:
`maxScopes` still counts stopped scopes, and storage reservations remain charged.
There is no LRU eviction or automatic scope deletion.

Lifecycle logs use `Caller runtime lifecycle:` and an opaque scope digest,
without principal IDs, prompts, credentials or backend error text. Offline
`container list` / `container inspect --principal ID` include `lifecycle`:

- `lastIdleStop`: timestamp, `reason: "idle-timeout"`, and `outcome: "stopped"`
  or `"quarantined"`. A stop is reported only after Docker confirms termination
  and worker/helper cleanup completes.
- `lastResume`: timestamp and `outcome: "conversation-reset"` after a fresh
  worker is initialized, or `"failed"` if recovery cannot initialize it. This
  describes runtime recovery, not the eventual task/model result.

These last-event records survive daemon restart; the ordinary `state` field
still reflects Docker's current state. Failed or unconfirmed cleanup quarantines
only the affected scope under the existing offline recovery rules. Daemon
shutdown invalidates pending timers and waits for idle cleanup already in
progress before pool shutdown can release ownership. Startup reconciles retained
resources normally and never reuses a previous daemon's timers.

### Docker verification

`caller-idle.integration.test.ts` runs the production workers, brokers,
supervisors and Claude file reader against deterministic CLI protocol fixtures
inside real Docker containers. It verifies warm conversation reuse, idle reset,
repeated restart, file routing, preparation/identity persistence, independent
callers and daemon ownership transfer without making provider calls.

```sh
VICOOP_IDLE_TEST_IMAGE=your-local-caller-image \
  pnpm --filter @vicoop-bridge/client exec tsx --test src/caller-idle.integration.test.ts
```

The image must contain supported Claude/Codex versions, Node, tini and firewall
tools, with UID 1000 writable workspace/session directories. Optionally set
`VICOOP_IDLE_TEST_STORAGE_IMAGE=sha256:...` to an installed storage-helper image
to verify retained fixed-storage reservations as well (uses privileged storage
helpers with a disposable test pool). The test reports warm/stopped Docker
memory and PID observations and elapsed request time after idle stop. These are
local lifecycle observations with synthetic CLI replies, not model latency or
a throughput benchmark.

A local run on 2026-11-05 with Docker 27.4.0, the fixed-storage helper and a
caller image containing Claude 2.1.267 / Codex 0.153.4 passed both backend
fixtures, including two idle resumes and a daemon restart. Claude's two resume
requests took 676/678 ms; Codex's took 668/661 ms. After warm task cleanup,
Docker reported 22.01 MiB / 2 PIDs for Claude and 16.77 MiB / 2 PIDs for Codex;
stopped containers reported 0 B / 0 PIDs. Persistent disk reservations remained
unchanged. Memory figures are Docker container accounting, not whole-daemon or
host memory savings, and the replies used the synthetic protocols above.

## Capacity and storage limits

Scope count includes retained stopped scopes; it does not automatically evict
users. Queue length, conversations per scope, task duration, container CPU,
memory and PIDs are bounded. Full-capacity requests fail explicitly.

Normal `container init` enables fixed ext4 storage: `storageMiB` is the total
filesystem size shared by workspace/sessions, including metadata. Blocks and
inodes are limited synchronously; full scopes remain accessible for deleting files.
The daemon-wide pool shares an immutable budget/reserve across agents/backends.
See [fixed storage initialization](caller-fixed-storage.md) for defaults and options.

The reservation boundary is the Docker backing filesystem, not physical capacity
outside thin VM/block devices. Physical reservation and the complete release gate
remain open. Intermediate development configs without `fixedImageStorage` still
use monitored volumes; retained ordinary-volume scopes cannot be adopted by init.
No migration of that unpublished format is provided.

## Offline administration

Stop the daemon first. Administration takes the same exclusive ownership lock
and refuses to operate while a live owner or running managed container exists.
Stopped containers can be recreated or deleted after changing CPU, memory, PID
or scope-count limits. Ownership checks still apply. Offline cleanup can remove an owned, stopped
container with a missing or drifted network; it never removes a network with
foreign ownership or endpoints. Execution and explicit validation still require
the full network boundary and configured limits.

```sh
vicoop-client container list --config /path/to/config.json
# Remove one stopped container/network; keep its volumes for next allocation:
vicoop-client container recreate SCOPE_DIGEST --config /path/to/config.json
# Explicitly delete that user's container, network, volumes and scope record:
vicoop-client container remove SCOPE_DIGEST --config /path/to/config.json
```

Omit `--config` to use the canonical config.json. Use `--backend claude|codex`
to manage a backend other than the one currently selected in that config.
`container list` prints JSON scope digests and container names. `container validate` checks the configured image, retained container limits, and both retained volumes even when a container has been removed, without
starting workloads; it also requires a stopped daemon. A fresh configuration
can validate with no caller containers because allocation is lazy. Listing,
recreation and deletion remain available even if the configured image has been
removed. The old `caller-state --delete-scope/--recreate-scope` commands remain
compatibility aliases.

Scope digests and Docker names are opaque; callers cannot select them. Stop,
restart and recreation do not implicitly delete user data. If Docker access or
ownership validation fails, inspect the named resources before retrying; never
clear another caller's storage to recover an unrelated scope.

## Rollout and validation

Deploy the compatible server before enabling the client. The client requires
`caller-runtime-v1`, `execution-scope-v1`, `caller-context-v2` and replay acknowledgement; an older
server makes it refuse work. Rollback: stop caller mode, keep its volumes/state,
and choose host mode explicitly. Old #499 snapshot archives
are incompatible with this storage schema and are not automatically imported.

The source includes these acceptance entrypoints:

- `scripts/caller-init-smoke.mjs`: standalone compiled CLI initialization outside
  the repository, embedded image build, backend probes, private state creation,
  config preservation and repeat initialization; no provider calls.
- `scripts/caller-init-image-smoke.ts`: real Docker image write probes for both
  backends; rejects root-owned workspace/session directories without saving config.
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
an already validated execution scope is recorded; the store independently
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


If a retained scope loses either its workspace or session volume, execution fails
with `runtime_storage_missing` and quarantines that caller. Empty replacement
volumes are never created automatically. Stop the daemon and restore the original
volumes (including their ownership labels), or explicitly use `container remove
SCOPE_DIGEST` to discard the retained scope and its remaining data before starting
over. `container recreate` preserves state and does not repair missing volumes.
This also applies when initial allocation was interrupted after reserving the
scope but before creating both volumes; inspect retained data before removing it.

The daemon applies the same backend-version compatibility checks as initialization.
Codex model catalogs are shared across scopes within one daemon, revalidated
against the host login on access, and refreshed when credentials or the installed
version change. Concurrent callers share a lookup; canceling one does not cancel
the others, and canceling the last waiter aborts the lookup.


A newly reserved caller cannot adopt an existing container, network, or volume.
Orphan detection performs no Docker mutations and rolls back that reservation;
restarting the daemon does not make the orphan data eligible for reuse. Stop the
daemon and inspect the Docker resources, then restore their original state
database or explicitly remove the orphan resources. Orphans are not managed by
`container remove` because they have no committed scope record.

Claude caller settings use an allowlist: `model` (Claude model IDs or
sonnet/opus/haiku, optionally suffixed with `[1m]`), `effortLevel` (low/medium/high/max), `alwaysThinkingEnabled`
(boolean), `sandbox.enabled`/`sandbox.failIfUnavailable` (booleans), and
`env.ENABLE_PROMPT_CACHING_1H` ("0"/"1"). `permissions.deny` is also accepted as
a list of up to 64 nonblank rules, each at most 1,024 characters with no control
characters. The entire settings object must serialize to at most 96 KiB of UTF-8
JSON, leaving room below Linux's per-argument limit for backend-added settings.
Oversized settings fail validation before tasks start. Other settings, environment variables,
hooks and authentication helpers fail initialization and daemon startup. Allowed
settings are copied before constructing caller workers; host-only settings must
be removed from the container-mode backend configuration.

Deny rules belong in the operator's `backends.claude.settings` and apply to every
caller environment for that agent. For example, this configuration fragment
blocks the tested `Read` paths and `Bash(cat:*)` command pattern:

```json
{
  "backends": {
    "claude": {
      "settings": {
        "sandbox": { "enabled": true, "failIfUnavailable": true },
        "permissions": {
          "deny": ["Read(./secret.txt)", "Read(**/secret.txt)", "Bash(cat:*)"]
        }
      }
    }
  }
}
```

The runtime starts in `/workspace`. Claude interprets the rule syntax; bridge
validation only checks the list's shape and size. Check your rules with the
installed Claude version and the actual paths and tools you use. This example
was verified with Claude 2.1.304; it is not a general credential-exfiltration
policy (other commands or tools may still read a file). Rules remain effective
with the runtime's `--dangerously-skip-permissions` flag. `permissions.allow`,
`ask`, `defaultMode`, and other permission keys remain unsupported. Workspace
setup does not load caller-provided Claude settings: `--setting-sources ''` and
the strict MCP configuration remain in effect (only the bridge-owned `send_file` helper is added when configured). Deny rules supplement the
existing environment isolation; task credentials must still be scoped to the
intended user's authority.

On shutdown timeout or cleanup failure, the daemon exits nonzero and retains its
pidfile instead of reporting a clean shutdown. Inspect the retained runtime
resources before restart; the next owner must still reconcile Docker state.
Offline removal preflights the container, network and both volumes before any
Docker removal, so ownership rejection leaves the remaining resources intact.

Container agent cards advertise only the supported text/inline-file input modes;
bundled descriptions omit host JSON-data support. Custom card descriptions are
preserved with the container input contract appended, and a custom card with no
supported input mode is rejected before daemon startup.

Caller cards advertise text-only output unless Claude file delivery is explicitly enabled. Traceability extensions are not advertised, and requests opting into traceability are rejected before allocation because trace artifacts may contain files or structured data. Offline removal/recreation also rejects volumes mounted by another container (including stopped containers) before deleting any resources; detach those consumers before retrying.

Canceled queued requests return promptly, but their queue slots remain occupied until the preceding request settles. Repeated cancellation cannot bypass the queue bound; new requests may receive `runtime_capacity` while those barriers remain.

SQLite also records completed allocations. If both data volumes remain but the container is absent and no completion record exists, execution reports `runtime_allocation_incomplete` and quarantines that caller. Restore the original state/resources or explicitly remove the scope before retrying. Older records can establish completion from a validated existing container; offline recreation records that evidence before removing it. A same-name replacement container has a different Docker ID and causes a fresh worker and conversation reset.

New reservations carry a SQLite pending-preflight marker until all orphan checks succeed. If rollback fails, the original error is retained and requests fail with `runtime_reservation_unconfirmed`; restart does not adopt or stop those unconfirmed resources. Stop the daemon and inspect/remove the affected scope through offline administration before retrying.

## Shared read-only materials

To give every caller the same reference documents or repository snapshot, add
`sharedVolumes` to the selected backend's `caller_runtime` configuration:

```json
"sharedVolumes": [
  { "name": "docs", "volume": "company-docs-v1" }
]
```

This exposes the existing Docker named volume at `/shared/docs` in every caller
container. Names are simple identifiers (letters, digits, `_`, `-`); destinations
are always under `/shared`, separate from private workspace/session storage and
broker control paths. Up to 16 volumes are supported. The default is no shared
volumes. This does not add user roles or change caller access control.

Create and populate the volume before starting the bridge. For example, using
your already trusted caller image ID as `CALLER_IMAGE` and a local `materials`
directory containing only documents intended for every caller:

```sh
CALLER_IMAGE=sha256:REPLACE_WITH_YOUR_CALLER_IMAGE_ID
docker volume create company-docs-v1
tar -C ./materials -cf - . | docker run --rm -i --network none --user 0 \
  --mount type=volume,source=company-docs-v1,target=/materials,volume-nocopy \
  --entrypoint /bin/sh "$CALLER_IMAGE" -c \
  'tar -xf - -C /materials && chmod -R a+rX /materials'
```

The bridge accepts only existing plain local Docker volumes, without driver
options or `vicoop.*` ownership labels. Bridge-managed names starting with `vb-` or `vicoop-`
and the configured fixed-storage pool are rejected. `sharedVolumes` does not
accept host paths, NFS/local driver bind options, or caller/provider credential
volumes. Use `sharedBinds` below for supported read-only host directories.
Shared volumes must contain no secrets or private caller data: all callers can
read and copy their contents. Read-only mounts prevent callers from modifying
the shared copy; they do not make documents trusted instructions.

Mounts use `readonly` and `volume-nocopy`. The bridge checks the volume before
startup/acquisition and checks mount identity, destination and read-only mode on
container creation, recovery and reuse. Shared data does not count toward each
caller's writable storage limit. Scope recreation and removal never delete these
operator-owned volumes, even when another caller is using them.

For initial configuration or a refresh, stop the daemon and use `container list`
and `container recreate SCOPE_DIGEST` for **every retained scope, with the old
configuration still in place**. Recreation removes containers but preserves
private workspace/session data. Then edit `sharedVolumes` and restart; containers
are created with the new mounts on acquisition. Changing mounts on retained
containers fails validation rather than silently using stale configuration.

Prefer a new versioned volume (for example `company-docs-v2`) for every refresh.
Read-only applies to caller mounts, not to other Docker clients: an external
writer can change a volume while callers read it. If updating in place, stop
**all** consumers, including other agents sharing that volume, before writing.
Keep old versions until no containers use them, then remove them explicitly with
`docker volume rm company-docs-v1`. Offline scope removal remains available even
if a shared volume is missing; restore or replace it before resuming execution.

Maintainers can repeat the Docker isolation/lifecycle smoke with an installed
caller image (no provider credentials or model invocation required):

```sh
VICOOP_SHARED_TEST_IMAGE=sha256:YOUR_CALLER_IMAGE_ID \
  pnpm --filter @vicoop-bridge/client exec tsx --test src/caller-shared-volumes.integration.test.ts
```


## Outgoing files from Claude caller containers

Enable `fileDelivery` under `backends.claude.caller_runtime`:

```json
"fileDelivery": {
  "allowedRoots": ["/workspace/output"],
  "maxBytes": 6291456,
  "maxTotalBytes": 25165824,
  "maxFiles": 8
}
```

Restart the daemon after changing this configuration. Existing Node-equipped
caller images work without rebuilding. The model creates the output directory
and files, then invokes the bridge-owned `send_file` MCP tool with `path` and an
optional plain `name`. The caller receives an inline A2A FilePart with the actual
bytes, including in completed-task lookups. A local path in prose is not a file
delivery. This feature does not enable arbitrary operator or caller MCP servers.

Roots must be normalized absolute directories strictly below `/workspace`, with
no trailing slash. Relative tool paths resolve beneath the first root. The reader
rejects symbolic links in **any** path component, hard links, non-regular files,
and paths outside the configured roots. It runs as the workload user in the
originating container, never against host paths. Configure directories that the
workload user can read. These are export-path limits: the agent can still copy a
file it is otherwise authorized to read into an allowed output directory.

The defaults shown above permit 6 MiB per file, 24 MiB total decoded bytes, and
8 files per task. Maximum configurable limits are 8 MiB per file, 48 MiB total,
and 16 files. Retries share the task budget. Files are snapshotted when the tool
runs and delivered immediately; successful delivery does not prove the remote
user downloaded the file, and later cancellation does not retract an already
accepted artifact.

The daemon sizes its global replay retention for one full attachment batch per
`maxScopes` concurrently active scopes, including base64 expansion, 64 KiB of
JSON metadata allowance per file, and 1 MiB for other frames per scope. With the
defaults (`maxScopes: 8`) the ceiling is approximately **268 MiB of encoded
retained frames**, allocated only as frames await acknowledgement. This is not a
total process memory limit: encoding, socket buffers, and other work also use
memory. Startup rejects combinations requiring more than 512 MiB; lower
`maxScopes` or the file limits to fit. The individual maxima above must be used
with a compatible scope count. Disabling file delivery keeps the normal replay
budget unchanged.

Retention remains bounded by the existing frame-count and age limits as well as
this byte ceiling. Unlimited ACK delay, multiple completed batches awaiting ACK
per scope, or unusually large text output can still exhaust retention and fail
the task with `client_buffer_overflow` before disconnecting. This sizing supports
the configured concurrent attachment batches; it does not promise unlimited
offline buffering.

The bridge binds each helper transport to one active process, task, and caller
container. The helper cannot select a recipient or task. It uses a short-lived
container-loopback endpoint over that execution's Docker channel, without a
host TCP listener, shared output queue, or host credentials. Bindings and pending
reads are revoked on process exit, cancellation, timeout, or shutdown. If a reader
transport fails or times out without confirmed remote process exit, the task fails
and the scope is stopped before reuse; the next task restarts it. An unconfirmed
container stop quarantines the scope for offline recovery. Ordinary path or size
rejections remain recoverable tool errors. A retry gets a new binding; the existing trusted supervisor cleans up descendants before
another execution uses the scope. Reconnection uses the existing execution replay
protocol; a previous execution's helper cannot attach to a later task. Workspace
files themselves persist and may be explicitly sent again in a later request.

File-enabled Claude cards advertise file output; disabled Claude cards and Codex
cards remain text-only. Setting `fileDelivery` on Codex fails startup explicitly.
Traceability output and unsupported inputs remain rejected. To migrate from host
`backends.claude.send_file`, move the export configuration to
`caller_runtime.fileDelivery`, use container paths, and remove the host-only
setting. The host setting does not configure container delivery.

For deployments of the unpublished local asset-container variant, replace
`outgoingFiles` with `fileDelivery` and use the execution-bound `send_file` tool
instead of its completion-time queue. Retain `sharedBinds` and `systemPrompt`
under the same names, following the host-directory validation and recreation
procedure below. Review the 24 MiB default
aggregate budget explicitly: it is lower than eight 6 MiB files. Files are now
delivered immediately and remain visible if the task subsequently fails or is
canceled.

Validation entrypoints:

- `pnpm --filter @vicoop-bridge/client exec tsx --test src/caller-file-retention.test.ts`
  checks real Client/WebSocket delayed ACKs, full aggregate and file-count limits,
  concurrent scopes, reconnect replay, and reuse after acknowledgement.
- `VICOOP_FILE_TEST_IMAGE=sha256:... pnpm --filter @vicoop-bridge/client exec tsx --test src/caller-file-delivery.integration.test.ts`
  checks real Docker path/link rejection, task budgets, and isolated bytes.
- `packages/server/scripts/e2e-caller-file-delivery.mjs` runs a Bun-compiled client,
  real Claude containers, and a disposable HTTP/WebSocket/Postgres server. It
  verifies concurrent callers, same-scope sequential tasks, observed-file-tool
  cancellation, reconnect, PNG/WAV bytes and hashes, and completed-task lookup
  with A2A 0.3 and 1.0. See the script header
  for required environment variables; this test makes real provider calls.

## Host asset directories and operator instructions

Existing host directories can be exposed without copying them into Docker volumes
or rebuilding the caller image. Add these fields to
`backends.claude.caller_runtime` (the same names as the local asset-agent patch):

```json
"sharedBinds": [
  { "name": "assets", "source": "/srv/ip-assets" }
],
"systemPrompt": "Search the corpus under /shared/assets. Keep source files unchanged. Write deliverables under /workspace/output. When file delivery is configured, return actual attachments through send_file."
```

`sharedBinds` works for Claude and Codex; `systemPrompt` is Claude-only and is
rejected for Codex, including during `container init`. Both fields require the
effective runtime to be `container`; host execution rejects them. The default is no binds
and no operator prompt. Each bind has exactly `name` and `source`; arbitrary
mount options, writable binds, custom destinations and remote caller-selected
paths are unsupported. Up to 16 directories are supported. Names use the same
identifier syntax as `sharedVolumes`, and must be unique across both lists.
Sources must be existing absolute canonical directories: resolve symlinks first
with `realpath`, omit trailing slashes, and avoid commas, quotes, backslashes and
control characters. Files, symlink components, duplicate sources and ambiguous
paths are rejected. Spaces and Unicode names are supported.

The bridge requests `readonly,bind-recursive=disabled,bind-propagation=rprivate`
using Docker's `--mount`. Host submounts are excluded and mount events do not
propagate. A Docker CLI/Engine that cannot implement these options fails rather
than falling back to weaker mounts. Before creation or reuse, sources are checked
again. Retained containers must match both Docker's mount declarations (including
non-recursion) and actual source, destination, read-only and propagation fields.
Changed, missing, duplicate or unexpected mounts fail validation. Private writable
workspace/session volumes remain per-caller. Cleanup only manages those owned
volumes and containers; it never removes an operator source directory.

This feature requires a Linux Docker daemon reached through a local Unix socket.
The client and daemon must see the **same canonical source path and contents**.
On Linux, run the client on the Docker host. On macOS, Docker Desktop/Colima must
share the selected host directory into their Linux VM at that path; a path that
exists only on macOS is insufficient. Docker's workload UID/GID `1000:1000` must
have read/traverse permission. SSH/TCP remote Docker endpoints are explicitly
rejected: run the client on that Docker host and configure its paths instead.
Do not use a forwarded Unix socket to disguise a remote filesystem. See
[Docker's bind-mount requirements](https://docs.docker.com/engine/storage/bind-mounts/).

Host file changes appear through existing mounts without a copy/sync step. Keep
the mounted directory itself stable: replacing or renaming its root requires
recreation. For consistent multi-file updates, stop all consumers first. These
mounts expose their contents to **every** caller of this agent; select only
public-to-those-callers asset directories, not the host home, credentials, Docker
socket or caller state. Read-only mounts protect originals from modification;
they do not prevent callers from reading/copying assets into private outputs.
Non-recursive mounts exclude mounted descendants, but ordinary subdirectories
remain visible.

To change names, source paths or the mount list:

1. Stop the daemon and its caller containers.
2. With the **old mount configuration still in place**, run `container list` and
   `container recreate SCOPE_DIGEST --config /path/to/config.json` for every
   retained scope. This removes containers while preserving private workspaces,
   sessions and scope mappings. Offline recreation/removal also works when a
   source directory is missing, because it validates recorded mount ownership
   without accessing source contents.
3. Edit the configuration, validate canonical source paths and restart. New
   containers receive the new mounts on acquisition. Existing data is retained;
   the existing recreation/conversation-reset behavior still applies.

Changing only `systemPrompt` requires a daemon restart, without image rebuild or
container recreation. It is nonblank text, limited to 64 KiB of UTF-8 and cannot
contain NUL. The bridge merges it into one staged append-prompt file alongside
agent identity, caller-context rules and other bridge-generated instructions on
**every execution**, including resumed sessions and retries. It does not mix
`--append-system-prompt` with `--append-system-prompt-file`. Operator instructions
are visible to callers through model behavior; do not put secrets in them.

### Migrating the asset-agent patch

Retain the local `sharedBinds`/`systemPrompt` fields, check them against the stricter
validation above, and recreate old containers using the old client/configuration
before starting the stock client. An older local container may lack the required
non-recursion/propagation declarations. Preserve its state directory and private
volumes rather than deleting caller data.

The stock client supports execution-bound file delivery together with these
mounts and operator instructions. Remove the local `caller_runtime.outgoingFiles` field and replace it with
`caller_runtime.fileDelivery`, setting `allowedRoots` to, for example,
`["/workspace/output"]`. The strict schema rejects `outgoingFiles`; only the local
`sharedBinds` and `systemPrompt` fields carry over under the same names.
Shared asset paths are inputs, not export roots: copy or
process results into an allowed private output directory and invoke `send_file`.
That feature enforces its own per-file, aggregate byte and file-count limits
(defaults: 6 MiB/file, 24 MiB/task, 8 files/task); a prompt does not override them.
Delivery occurs when `send_file` runs, rather than from a queue at task completion.
Update operator prompts and consumer instructions that describe completion-time
queued delivery. Files already delivered remain visible if a later step fails or
is canceled.
Without that feature, paths in prose do not become attachments. This mount/prompt
configuration does not replace or weaken the execution-bound file-delivery design.

Maintainers can verify live host updates, write rejection, private workspaces and
sessions, recreation, source preservation, and per-execution prompt staging with:

```sh
VICOOP_SHARED_TEST_IMAGE=sha256:YOUR_CALLER_IMAGE_ID \
  pnpm --filter @vicoop-bridge/client exec tsx --test src/caller-shared-binds.integration.test.ts
```

Run from a directory shared into the Docker VM. The prompt test uses a deterministic
CLI fixture through the real caller worker and broker; it makes no model calls.

Also set `VICOOP_SHARED_TEST_FILE_DELIVERY=1`
to check actual attachments and the configured file-tool instructions on all
three executions alongside the operator prompt.

## Bounded concurrency across one caller's contexts

Claude and Codex support opt-in concurrent execution of independent A2A contexts.
Without `concurrency`, the existing single-container, shared-workspace, per-caller
serialization contract above is unchanged, including its end-to-end task timeout.
With fixed image storage initialized, add this under `caller_runtime` and restart:

```json
"concurrency": {
  "perCaller": 2,
  "global": 8,
  "queuePerCaller": 16,
  "queueTimeoutMs": 600000
}
```

These are the defaults when `concurrency` is present. `perCaller` accepts 1–8;
`global` accepts 1–32. `global` is per configured caller runtime in this daemon,
not a distributed limit across hosts. `queueLimit` remains the total waiting
request limit; `queuePerCaller` additionally bounds a single caller's waiters.
Both queue limits may be zero. A full queue fails with `runtime_capacity`.
`maxScopes` continues to count retained callers, including stopped callers;
`maxContexts` bounds retained contexts **per caller across restarts** in this mode.
Lowering that limit below retained context count fails startup.

Admission rotates among callers with eligible work. One context always executes
in order, and an earlier waiter for a busy context does not occupy an extra slot
or block another context. Running work is not preempted to admit a new caller.
An execution slot covers allocation, backend initialization, tool/approval waits,
file delivery and confirmed cleanup. Queue timeout starts on admission to the
queue; `taskTimeoutMs` starts when an execution slot is granted. They fail as
`runtime_queue_timeout` and `runtime_timeout`, respectively. Canceling a queued
request removes its queue entry without touching an active execution.
Heartbeat metadata exposes the current `vicoop.runtime.phase`; silence from a
backend is not evidence that an execution is idle.

### Workspace and resource boundaries

Each context gets its own container, private network, persistent `/workspace`
and backend session directory. Context keys are bridge-generated hashes of the
validated caller scope and A2A context; caller input never becomes a Docker name
or filesystem path directly. Claude and Codex use the same scheduling and Docker
lifecycle. Codex's app-server, input staging and thread mapping belong to that
context. Claude's file helper and broker binding belong to that execution.

The caller's original workspace remains available **read-only** at
`/caller-workspace`. Existing files and environment preparation are retained;
files are not copied or merged automatically. For example, copy a prepared
script or project from `/caller-workspace` into `/workspace` when it needs writes.
Absolute paths or dependencies in a prepared environment that assumed the old
writable workspace may need adjustment. Backend configuration/session files from
the legacy environment are not automatically imported. Switching modes starts
new conversations. Shared operator asset mounts remain read-only at `/shared/*`.
Different contexts may safely write the same `/workspace/output/result.png` name;
there is no shared writable output directory between them.

Context data lives under `contexts/<opaque-context-key>/{workspace,sessions}` in
the caller's **existing fixed ext4 allocation**. The legacy workspace and every
context share the caller's `storageMiB` block/inode limit; no extra storage
reservation is made for each context. A full shared filesystem can affect all
contexts of that caller. This is not per-context disk quota or transactional
rollback; partial writes survive failures. Legacy monitored-volume storage is
rejected for concurrency because it cannot provide this enforced aggregate bound.
Context files are retained until explicit caller data removal. There is no
automatic context eviction or background data deletion.

CPU, memory, PIDs and tmpfs limits apply **per execution container**. Budget host
resources for up to `global` containers, plus bounded allocation/storage helpers
and daemon overhead. A context container/network is removed after each execution
and confirmed cleanup, so completed contexts do not accumulate idle containers.
In this mode `idleTimeoutMs` does not schedule an additional scope-wide stop;
that timer applies only to the legacy single-container mode. Context conversation
mappings remain retained until failure, daemon restart or backend session expiry.
In-memory conversation mappings are retained within `maxContexts`; successful
follow-ups resume the same Claude session or Codex thread from persistent files.
Daemon restart resets conversation mappings and reports `conversationReset`,
while preserving workspace/session files. This mode does not claim cross-restart
conversation restoration. The legacy caller container used for initial allocation
and offline environment preparation remains retained and stopped.

Cancellation, backend failure or uncertain execution cleanup closes only the
affected context's broker/worker and removes its container. Each process captures
its immutable Docker ID for exec and delayed cleanup; a late callback from a
removed container cannot stop a subsequent execution that reuses its name.
Cached conversation workers rebind to the new ID before each execution. File
reads and Codex input staging also use the bound immutable ID. Cleanup failure
quarantines that context and keeps its execution slot charged until daemon
recovery. Uncertain shared allocation/storage-helper failures block new work for
that caller; already running siblings are not deliberately stopped by that
request's cleanup. Docker daemon loss, physical disk failures or shared storage
exhaustion can affect multiple executions and cannot be isolated by scheduling.
Recovery validates persisted ownership and resource boundaries before removing
old context containers; it never silently adopts a foreign resource. Offline
`container list` includes retained context keys; `container recreate/remove`
handles their owned containers/networks as well as the original caller resources.

Claude keeps its existing optional `fileDelivery` support. Concurrent executions
use separate bindings, budgets and output snapshots; cancellation cannot rebind
one execution's helper to a sibling. Codex remains text-output-only; this feature
does not add Codex outgoing FileParts. Replay retention is sized for `global`
concurrent attachment batches instead of `maxScopes`. The 512 MiB ceiling still
applies: the default 24 MiB/file-batch configuration fits 8 slots (about 268 MiB),
but not 16. Lower `global` or file limits when startup rejects the byte budget.
Retention still has frame/age limits and is not unlimited buffering after an
execution ends.

### Migration, rollback and verification

1. Stop the daemon, preserve the original state directory/configuration, and make
   an offline backup of caller storage before changing workspace semantics.
2. Keep the existing image, storage pool, reservations and caller identities.
   Enable `concurrency`, then restart. No storage-helper image rebuild is needed;
   the caller image must provide the existing Node/tini runtime contract.
3. To disable parallel execution while retaining the new workspace layout, set
   `concurrency.perCaller` to `1`. Set `global` to `1` as well if all callers must
   execute serially. Do not remove the `concurrency` object while context data is
   retained: startup rejects that change rather than switching back to a different
   writable workspace without notice.
4. The first context allocation advances the manifest to version 8; older client
   binaries reject it. Binary downgrade requires the pre-migration offline backup
   or an explicit export/reprovision plan. Never lower the manifest version by
   hand. Explicit `container remove` deletes that caller's legacy and context data
   together; it is not a routine rollback step.

Deterministic scheduler/backend tests cover overlap, context FIFO, fair admission,
queue limits, queue cancellation/timeout, cleanup barriers and quarantine capacity.
`packages/client/scripts/caller-concurrency-smoke.mjs` runs the compiled CLI with
real Docker, fixed ext4 storage and deterministic Claude/Codex protocol fixtures.
It checks actual simultaneously running backend processes, same-name file
isolation (including Claude FilePart bytes), sibling cancellation and injected
supervisor failure, other-caller
progress, remote approval isolation, inline-image routing, session resume, crash
recovery and `perCaller: 1` rollback. Run it separately for each backend:

```sh
docker build -t caller-concurrency-fixture -f packages/client/scripts/fixtures/caller-backends/Dockerfile .
VICOOP_CLIENT_BIN=/absolute/path/to/compiled/vicoop-client \
VICOOP_SMOKE_IMAGE=$(docker image inspect --format '{{.Id}}' caller-concurrency-fixture) \
VICOOP_SMOKE_KIND=claude node packages/client/scripts/caller-concurrency-smoke.mjs
# Repeat with VICOOP_SMOKE_KIND=codex.
```

The smoke reports an overlap timestamp after observing both backend processes
inside their independent containers. These are lifecycle tests, not provider
throughput measurements or evidence from real model calls.

Validation on 2026-11-06 used the Bun-compiled client and real Docker with these
protocol fixtures. Observed simultaneous same-caller execution at
`2026-11-06T02:59:15.690Z` (Claude) and `2026-11-06T02:59:15.861Z` (Codex).
Both runs passed cancellation/supervisor-failure sibling survival, approval and
input routing, persistence/recovery, and serialization rollback. Claude also
passed execution-bound FilePart byte attribution for identical output paths.
No real provider/model calls or production deployment were performed in this
validation.
