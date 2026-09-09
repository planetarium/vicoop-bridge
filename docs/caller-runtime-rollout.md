# Caller-scoped Docker runtime rollout

Tracking: [#497](https://github.com/planetarium/vicoop-bridge/issues/497).
Design background: [#496](https://github.com/planetarium/vicoop-bridge/issues/496).

## R1: compatible foundations

R1 supports the existing `host` and `container` modes. Their install,
credential locations, runtime/volume names and persistence behavior stay the
same. R1 does **not** provide caller-isolated execution or change task ownership.

`--runtime caller-container` (or `backends.claude.runtime` /
`backends.codex.runtime` set to `caller-container`) is reserved and produces an
error before backend startup. Configuration normalization preserves this value
so it cannot silently become host execution. R1 clients do not advertise
`execution-scope-v1` and do not allocate caller runtimes.

Docker lifecycle operations in `RuntimeContainer` and the startup credential
probe run asynchronously. Ordinary commands have a 30-second timeout and a
1 MiB aggregate captured-output limit. Image pulls retain visible progress and
have a 10-minute timeout; readiness polling uses its remaining 10-second budget.
One-shot `container list`/remove helpers still use the synchronous compatibility
runner (bounded to 30 seconds per command); they are not request-path APIs.

Timeout/abort stops the local Docker CLI. The Docker daemon may already have
accepted the operation: inspect the named runtime before retrying. These errors
do not certify cancellation of in-container processes. The existing spawn
adapter remains a stdio transport, not a process-group supervisor.

Explicit per-spawn environment overrides are passed to `docker exec -e` without
a shell. Unspecified variables keep the container environment; the bridge's
entire host environment is not forwarded. Do not supply secrets as arbitrary
overrides unless their visibility inside the runtime is intended.

## Execution scope wire contract

The server emits a top-level `task.assign.executionScope` only when the client
advertises all of `execution-scope-v1`, `caller-context-v2`, and `task-replay-v1`.
It acknowledges scope wire support in `hello.ack` after authentication. This
acknowledgement is a protocol capability, not an isolation guarantee or mode.

The strict v1 object contains:

| Field | Meaning |
| --- | --- |
| `policy` | `direct-principal-v1` |
| `agentId` | The exposed agent's identity |
| `principalId` | Exact authenticated principal from the server auth handoff |
| `id` | Lowercase SHA-256 hex of the UTF-8 JSON array `["vicoop-execution-scope", policy, agentId, principalId]` |

The ID is an opaque storage association, not a bearer credential. It excludes
contextId, executionId, credential rotations and attribution attestations.
Different contexts for one scope share a workspace; different principals or
agents have different scope IDs. Shared API keys identify one shared principal.

Only the authenticated HTTP handoff can supply the principal. Public message
metadata named `executionScope`/`execution_scope` is stripped before forwarding;
it cannot override the top-level value. Existing underscore-prefixed internal
metadata stripping at HTTP ingress continues to protect the auth handoff.

Missing/invalid caller context, absent principal, distinct actor, token-exchange
authorization key/profile, or incomplete negotiation yields no v1 scope. No
grant-derived policy is implemented in R1. Normal single-runtime requests keep
their existing behavior. R2 must reject missing scopes before allocation and
validate scope agent/principal against its connection and caller context.

Policy/schema changes require a new version and explicit storage migration;
never map an unfamiliar policy to an existing directory. Runtime-name encoding,
ownership-label validation and scope-manager leases are R2 responsibilities.
The full digest is not constrained to today's 32-character runtime-name limit.

## Deployment and rollback

| Client | Server | Result |
| --- | --- | --- |
| Pre-R1 | R1 | Existing wire shape: no scope is sent without all required capabilities |
| R1 | Pre-R1 | Existing modes work; R1 advertises no new scope capability |
| R1 | R1 | Existing modes work; caller isolation is unavailable |
| Future scope-aware | Pre-R1 | No scope acknowledgement/value; isolated mode must refuse work |

R1 client and server may ship in either order. Server changes deploy through
`fly deploy`; the client ships via its client-only changeset. No database or
volume migration is introduced. Rollback to pre-R1 is supported for `host` and
`container`; remove reserved `caller-container` configuration before downgrade
because older config normalizers can drop unknown values. Do not roll back a
future enabled isolated client/server using R1 compatibility claims.

## Provider boundary and R2 activation gate

`runtime-provider.ts` specifies the future isolated provider's lifecycle,
file transfer and supervised-process contract. The legacy Docker spawn adapter
does not implement that supervisor. No type cast or scope capability should be
used to claim otherwise.

Before activation R2 must implement authorized scope routing, separate volumes,
credential provisioning, allocation deduplication, capacity limits, input-file
staging, active leases, supervised cancellation, execution fencing, and minimum
crash reconciliation. MCP, Codex and delegation remain explicit unsupported
combinations until their release gates pass. Automatic eviction and advanced
conversation restoration can follow the first safe release.

## Reproducible runtime smoke

With Docker and a cached runtime image available, from the repository root:

```sh
pnpm -r build
pnpm exec tsx packages/client/scripts/runtime-foundations-smoke.ts
bun build packages/client/scripts/runtime-foundations-smoke.ts --compile --outfile /tmp/vicoop-runtime-smoke
/tmp/vicoop-runtime-smoke
```

Set `VICOOP_SMOKE_IMAGE` to select a compatible runtime image. The script creates
unique `r1-smoke-*` resources, skips firewall setup for its disposable test,
checks lifecycle/stdio/EOF/cwd/env/file transfer/volume persistence and removes
its own container and volumes. It does not authenticate or invoke paid models,
and it does not validate caller isolation or supervised cancellation.
