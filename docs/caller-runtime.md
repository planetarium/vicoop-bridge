# Claude caller-isolated Docker runtime (R2)

Opt in with `--backend claude --runtime caller-container`. One public agent and
bridge connection serve distinct directly authenticated principals. Scope is a
server-generated SHA-256 digest of policy version, agent ID and principal ID;
message metadata, model output, context IDs and tool arguments cannot select it.
A shared bearer credential represents one principal, regardless of how many
humans use it. Existing `host` and `container` profiles retain their behavior.

## Supported surface

Linux and macOS Docker hosts, a local Docker engine with its default seccomp
profile and private PID namespaces, Claude plain A2A text and inline image/PDF
inputs. URI-only input fetching is disabled. The regular Claude parser's MIME
and byte limits still apply. Use an engine controlled by this operator, with no
external process changing its context or deleting managed resources during use.

Anonymous requests are rejected even when the agent's allowed-caller list is
empty. An empty list permits **authenticated direct** callers; a nonempty list
still restricts their principals. Existing task ownership checks remain in force.
Delegation/token exchange, isolated Codex/OpenClaw, OpenAI compatibility,
caller tools, MCP servers, and outgoing file delivery are unsupported. The client
removes its OpenAI compatibility advertisement and rejects tool/data envelopes.
Claude runs with strict empty MCP configuration and no user/project setting
sources. Host cwd, runtime-name and operator Claude settings are rejected.
Workload files, including `CLAUDE.md`, remain part of that caller's workspace.

## Image and credentials

Build an image with an exact Claude version and an immutable Node base digest:

```sh
docker build -f packages/client/docker/caller-runtime/Dockerfile \
  --build-arg CLAUDE_VERSION=2.1.265 \
  -t my-caller-claude packages/client/docker/caller-runtime
docker image inspect my-caller-claude --format '{{.Id}}'
```

The Dockerfile pins Node 22; override `NODE_IMAGE` with another suitable repository
digest when upgrading. Record the resulting image ID/digest in configuration;
mutable tags are rejected and images must already be local. The image must have
Node, POSIX sh, tar, sleep, mkdir and Claude installed read-only, support UID/GID
1000, and declare no `VOLUME`s. Add any required development tools at image build
time. No operator configuration, workspace or credentials belong in the image.
The base recipe is intentionally a minimal toolchain.

Create a dedicated plaintext file containing one Anthropic API key, mode `0600`,
and an empty state directory, mode `0700`. Paths must be absolute. Example client
configuration (merge with normal registration/token fields):

```json
{
  "backend": "claude",
  "backends": { "claude": { "runtime": "caller-container" } },
  "caller_runtime": {
    "image": "sha256:<64 lowercase hexadecimal characters>",
    "credentialFile": "/private/path/anthropic-key",
    "stateDirectory": "/private/path/caller-state",
    "maxScopes": 8,
    "queueLimit": 16,
    "workspaceMiB": 128,
    "taskTimeoutMs": 600000
  }
}
```

The key is read afresh for every execution and injected as `ANTHROPIC_API_KEY`.
Replace the file to rotate it; active work keeps its existing key. The workload
can read and use this credential, including copying it into its own files; this
profile does not provide credential secrecy from the agent. Docker administrators
can inspect it in the container environment. Supply a credential appropriate for
all callers admitted by this agent. Host OAuth/login directories are never copied.

## Execution, persistence and limits

Each scope has one backend/session map while the daemon lives. All tasks within a
scope are serialized, including allocation, snapshot and cleanup; different scopes
can run concurrently. Reusing a context ID across callers never shares the backend.
The ordinary Claude session TTL applies (one hour); a daemon restart creates a new
conversation even when files survive. A working status reports
`metadata["vicoop.runtime"] = {workspaceRestored: true, conversationReset: true}`
for a restored scope's new binding. R3 will add stronger conversation restoration.

Each task gets a unique container and private bridge network. There are no host
bind mounts, Docker socket or published ports. Rootfs is read-only, capabilities
are dropped, privilege escalation is disabled, and jobs run as UID 1000. `/state`
is bounded tmpfs holding workspace, HOME and Claude session files in separate
subdirectories; `/tmp` is a separate ephemeral 32 MiB tmpfs. A root PID 1 watchdog
exits after the configured task timeout plus 120 seconds; workload processes cannot
stop it. Container memory is workspace size plus 512 MiB, swap disabled, CPUs 1,
PIDs 128. Networks isolate containers from each other; outbound network access is
available and is not an egress allowlist or VM-level isolation guarantee.

At successful completion, a same-UID supervisor stops workload processes, checks
thread states, and streams an opaque tar snapshot into a host-owned pending file.
Docker's archive API does not capture tmpfs contents. The manager confirms whole
container removal and removes its network before atomically replacing the scope's
committed snapshot and releasing the execution lease. The host never extracts a
tar or mounts caller data. Terminal success waits for this barrier. Cancellation
also removes the whole container; killing the local `docker exec` process is not
treated as proof that remote descendants exited. Unconfirmed cleanup quarantines
the scope until startup reconciliation succeeds.

**Persistence is transactional in R2.** Successful checkpoints survive task/container
recreation and daemon restart. A failed or canceled task discards changes that have
not reached the atomic checkpoint replacement. A cancellation racing *after* that
commit retains the new checkpoint and reports that distinction when its terminal
frame can still be delivered. Cancellation is not a guarantee of rollback after
commit. Delivery failure or a crash after commit can likewise leave completed
changes without a received success response; blindly retrying is not exactly-once
execution. Snapshots target daemon/process restart recovery, not host power-loss
or filesystem-corruption durability. Previously committed caller data is not
implicitly deleted by stop, cancellation, cleanup, or upgrade.

| Setting | Default | Accepted range / behavior |
| --- | --- | --- |
| `maxScopes` | 8 | 1–32 admitted/retained callers; no automatic eviction |
| `queueLimit` | 16 | 0–128 additional outstanding tasks; total admission bound is maxScopes + queueLimit |
| `workspaceMiB` | 128 | 8–512 per scope, includes CLI state and files |
| `taskTimeoutMs` | 600000 | 1000–3600000; includes queue and allocation |
| Context bindings | 256 | Per scope, reject new contexts when full |
| Snapshot bytes | 2 × workspace size | Hard streaming cap for each committed/pending tar |
| Docker operations | 30 seconds each | Cleanup uses independent deadlines after cancellation |

Admission capacity returns `runtime_capacity`. Each admitted principal reserves a
slot until daemon restart or offline state deletion; failed initial tasks can
consume a live-daemon slot too. Queue waiting is cancellable. Allocation has a
fixed sequence of bounded operations with deadline checks between them; accepted
Docker mutations are cleaned up even if the deadline expired during the command.
Maximum host snapshot storage is bounded by two snapshots per admitted scope
(committed plus pending), each capped as above. Tar overhead counts toward the cap.
Do not reduce limits below retained state usage; startup explicitly rejects that.

## Inspection, deletion and crash recovery

Live resource identification:

```sh
docker ps -a --filter label=vicoop.component=caller-runtime
# Inspect labels vicoop.caller-namespace and vicoop.scope on an identified container.
```

With the daemon stopped, inspect snapshots or explicitly delete one scope:

```sh
vicoop-client caller-state --directory /private/path/caller-state --agent-id YOUR_AGENT
vicoop-client caller-state --directory /private/path/caller-state --agent-id YOUR_AGENT \
  --delete-scope THE_64_HEX_SCOPE_ID
```

The management command uses the same exclusive owner lock and refuses a live
owner or leftover containers. Start the daemon to reconcile after a crash, then
stop it before deleting data. A directory manifest binds it to an agent/host/schema;
owner records include hostname, PID and a unique token. A live or incompatible
owner fails closed. A dead same-host owner can be recovered; startup removes all
old namespace containers/networks and incomplete snapshots before accepting work.
Resources are removed and recreated, never adopted with unknown mounts or images.

A crash during the short owner-file critical section may leave `.guard`; inspect
owner PID, Docker resources and directory ownership before manually removing this
lock directory. A wedged Docker engine can leave a quarantine/owner record and
resources; restore Docker access and restart for reconciliation. Orderly shutdown
awaits tasks/cleanup for up to 120 seconds. Detached `stop` honors the launch-time
cleanup budget plus a 5-second exit margin, even if configuration changes later;
its pidfile remains owned until cleanup ends. After the deadline, process exit leaves recovery to the
watchdog and next startup. The watchdog terminates processes but does not delete
Docker metadata/networks. Do not manually remove resources belonging to a live
owner. Rich live inspection, idle eviction and retention automation belong to R3.

## Rollout and validation

Deploy the R2 server first, then release/upgrade the client, then opt in. Existing
modes work in mixed-version deployments. An isolated client requires explicit
`caller-runtime-v1`, `execution-scope-v1` and replay acknowledgment; R1-only and
legacy servers cannot activate it. Rolling the server back requires stopping or
reconfiguring isolated clients first. Switching to host/single-container mode never
imports isolated state. Keep snapshots while rolling back; R1 does not read them.

Docker smoke uses a local pinned Node image and no model calls:

```sh
VICOOP_SMOKE_IMAGE=sha256:YOUR_IMAGE_ID pnpm exec tsx packages/client/scripts/caller-runtime-smoke.ts
bun build --compile packages/client/scripts/caller-runtime-smoke.ts --outfile /tmp/caller-runtime-smoke
VICOOP_SMOKE_IMAGE=sha256:YOUR_IMAGE_ID /tmp/caller-runtime-smoke
```

The full CLI smoke uses a **deterministic Claude fixture**, not a paid Claude API
request. It checks argv, prompt staging, backend session reuse, A/B/A workspaces,
WebSocket disconnect/replay, forced daemon restart/reset, and shutdown:

```sh
pnpm -r build
docker build -t vicoop-caller-fixture packages/client/scripts/fixtures/caller-claude
bun build --compile packages/client/src/cli.ts --outfile /tmp/vicoop-client
VICOOP_CLIENT_BIN=/tmp/vicoop-client \
  VICOOP_SMOKE_IMAGE=$(docker image inspect vicoop-caller-fixture --format '{{.Id}}') \
  node packages/client/scripts/caller-client-smoke.mjs
```

Both smoke scripts create unique state and clean up only their own namespace.
Real Claude image installation/version checks are separate evidence from fixture
execution; fixture success does not claim a paid model end-to-end run.
