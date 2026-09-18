# R2: dedicated caller containers

Status: implemented in #506; see [operator documentation](caller-runtime.md)
for the implemented behavior and remaining limits. This replaces the execution-container/snapshot design in
[PR #499](https://github.com/planetarium/vicoop-bridge/pull/499), following the
[requirement clarification](https://github.com/planetarium/vicoop-bridge/pull/499#issuecomment-5710929289).
The scope now combines R2 with the Claude/Codex caller-isolation portion of R4 in
[issue #497](https://github.com/planetarium/vicoop-bridge/issues/497).

The daemon exposes `host` and `container` modes. `container` always allocates
per-caller runtimes; it replaces both the legacy shared-container execution
path and the draft `caller-container` spelling. See the operator migration
section before upgrading a shared-container configuration.

## Foundation and scope

Build on and target `codex/497-docker-runtimes`, retaining the R1 scope
negotiation and compatible foundations from #498. The integration branch has
been rebased onto `main` at `6425dca`, so the Claude host authentication broker
(#501) and shared execution/authentication infrastructure (#505) are already
included. R2 remains stacked on this integration branch. Selectively reuse #499's
server authentication, scope validation, queue/lease protections and applicable
tests. Its snapshot runtime and its validation results do not establish compliance
with this replacement design.

This PR supports directly authenticated callers using Claude or Codex and plain A2A.
OpenClaw isolation, delegation, MCP/caller tools, outgoing file delivery and
automatic idle reclamation remain outside this release. Unsupported combinations
must fail explicitly before allocation.

## Ownership and lifetime

One public agent and bridge connection serve multiple caller scopes. The server
alone derives scope from agent identity and authenticated principal. Prompts,
request arguments, caller metadata and runtime names cannot select another scope.

Each scope owns one reusable Docker container, a dedicated workspace volume and
dedicated backend conversation-state storage. A later request from the same
principal reuses that container, including when it supplies a new `contextId`.
Conversation bindings are keyed by scope plus `contextId`; equal context IDs from
different principals remain isolated.

Separate the persistent scope runtime from an execution lease. Processes,
supervision, staged inputs and temporary authentication grants belong to an
execution. The container and user storage survive successful execution completion.
Real provider credentials stay on the host; reuse the shared broker, supervisor
and runtime-boundary components from #501/#505 with scope-specific runtime binding.

## Lifecycle and safety contract

- Deduplicate concurrent first allocation per scope, including partial failures.
  Canceling a queued waiter must not release another execution's lease.
- Serialize same-scope execution initially. Track container ownership, generation,
  active leases and conversation bindings independently of individual tasks.
- Confirm execution termination before reporting cancellation or allowing reuse.
  Uncertain cleanup quarantines that scope. If containment requires stopping a
  container, stop only the affected scope and retain its storage.
- Bound containers, retained storage, queues, contexts, allocation/cleanup time,
  CPU, memory, PIDs and task duration. Define an enforceable volume storage limit;
  switching from tmpfs to named volumes must not silently remove the storage bound.
- Stop/restart/recreation must attach only the same scope's storage. Validate
  ownership labels, image, mounts and runtime boundary before reuse; reconcile
  unknown or unfinished executions before accepting work after a daemon restart.
- Protect active/acquiring leases from operator stop/removal. Explicit idle-only
  data deletion is separate from container stopping or recreation.
- Persist workspace and backend conversation files. Specify and test whether
  conversation resumption is supported across daemon restart/container recreation.
  When unavailable or failed, explicitly report a fresh conversation; never claim
  a successful resume. Automatic restoration machinery can remain in R3.
- Define partial-write behavior on failure/cancellation. Do not carry forward
  #499's success-only checkpoint/rollback promise without implementing it for the
  persistent-volume design. Process termination does not undo filesystem writes.
- Await shutdown and revoke execution grants on completion, cancellation or
  transport loss. Cleanup/recovery for one caller must not affect another caller.

## Implementation and acceptance checklist

- [x] Rebase the integration branch onto main with #501/#505 dependencies while
      preserving R1 protocol negotiation and server-derived scope.
- [x] Integrate strict caller authentication and client scope/generation validation.
- [x] Implement scope-owned container/volume allocation, reuse and reconciliation.
- [x] Bind shared broker/supervisor infrastructure to each scope and execution.
- [ ] Adapt queueing, leases, resource accounting and quarantine to persistent runtimes.
- [x] Implement explicit conversation resume/reset policy and idle-only administration.
- [x] Demonstrate real Docker A/B/A: distinct Alice/Bob container IDs, Alice's later
      requests reuse her ID, and a new Alice context also reuses her container.
- [x] Demonstrate isolated files and conversations even with identical context IDs.
- [x] Demonstrate stop/start and recreation preserve only the owner's files and
      conversation state, with verified resume or explicit reset behavior.
- [ ] Test concurrent allocation, canceled waiters, active cancellation, failed
      cleanup, shutdown, daemon crash/restart and disconnect/replay; verify another
      caller's active work and storage remain unaffected.
- [ ] Test forged scope, rejected authentication/negotiation, resource exhaustion
      and provider-secret isolation; rejected requests allocate no resources.
- [x] Run build/typecheck, affected suites, existing-mode regressions and real Docker
      acceptance through the Bun-compiled client. Record fresh evidence separately
      from the superseded PR's results.
- [x] Supply operator documentation, migration/rollback and rollout policy, and a
      client-only changeset with the implementation before marking ready for review.

The PR remains draft until the acceptance evidence is reviewed. Runtime selection
is now opt-in and implemented for both backends. Storage thresholds currently
use monitored admission and shutdown rather than filesystem hard quotas; strict
disk containment is an outstanding limitation, not a completed acceptance item.
Old #499 snapshot validation is not carried forward as evidence.

## Validation recorded on 2026-09-17

Repository build/typecheck passed. Client: 1,000 passed; server: 454 passed,
78 skipped; protocol: 11 passed. Focused caller tests and client typecheck also
passed after the last broker diagnostic change.

Real Docker lifecycle tests passed under tsx and Bun. The Bun-compiled client
passed deterministic Claude and Codex A/B/A conversations/files, new-context
container reuse, reconnect, cancellation, crash/restart, offline recreation,
and detached start/stop. Real-provider tests passed under tsx and as a
Bun-compiled executable with Claude Haiku 4.5 and Codex GPT-5.5, including
observing a running shell tool before cancellation, stopping only its scope,
and preserving workspace data through restart/recreation with explicit reset.

The real-provider image used Claude 2.1.265 and Codex 0.153.4 with immutable ID
`sha256:ab348b2048480c3f3f4e3bd3ab7e61c8a57b06d507800589bed48b56752ed55e`.
It reused locally installed native binaries because the Docker VM was nearly
full. After authorized unused build-cache cleanup, the committed production
recipe also built successfully with `--no-cache` (Claude 2.1.267 / Codex 0.153.4),
producing `sha256:4d2cef92d3fbb25c5b1af7c71ea7d8b814eb5048731e09282ad53582b0507ed1`.
Both backend lifecycle checks and the Bun-compiled real-provider tests
(including observed-tool cancellation) passed on this image. Actual-provider validation used host OAuth on macOS
Docker; native Linux and provider API-key calls are not established by these runs.
The full CLI transport tests use deterministic providers; real model tests call
the runtime directly. Strict disk quotas and the remaining unchecked combined
acceptance gates are not claimed complete. No release or deployment occurred.
