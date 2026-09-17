# R2: dedicated caller containers

Status: design and implementation plan; caller isolation is not implemented by
this document. This replaces the execution-container/snapshot design in
[PR #499](https://github.com/planetarium/vicoop-bridge/pull/499), following the
[requirement clarification](https://github.com/planetarium/vicoop-bridge/pull/499#issuecomment-5710929289).
The release remains the Claude-first R2 unit of
[issue #497](https://github.com/planetarium/vicoop-bridge/issues/497).

## Foundation and scope

Build on and target `codex/497-docker-runtimes`, retaining the R1 scope
negotiation and compatible foundations from #498. The integration branch has
been rebased onto `main` at `6425dca`, so the Claude host authentication broker
(#501) and shared execution/authentication infrastructure (#505) are already
included. R2 remains stacked on this integration branch. Selectively reuse #499's
server authentication, scope validation, queue/lease protections and applicable
tests. Its snapshot runtime and its validation results do not establish compliance
with this replacement design.

R2 supports directly authenticated callers using Claude and plain A2A. Codex and
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
- [ ] Integrate strict caller authentication and client scope/generation validation.
- [ ] Implement scope-owned container/volume allocation, reuse and reconciliation.
- [ ] Bind shared broker/supervisor infrastructure to each scope and execution.
- [ ] Adapt queueing, leases, resource accounting and quarantine to persistent runtimes.
- [ ] Implement explicit conversation resume/reset policy and idle-only administration.
- [ ] Demonstrate real Docker A/B/A: distinct Alice/Bob container IDs, Alice's later
      requests reuse her ID, and a new Alice context also reuses her container.
- [ ] Demonstrate isolated files and conversations even with identical context IDs.
- [ ] Demonstrate stop/start and recreation preserve only the owner's files and
      conversation state, with verified resume or explicit reset behavior.
- [ ] Test concurrent allocation, canceled waiters, active cancellation, failed
      cleanup, shutdown, daemon crash/restart and disconnect/replay; verify another
      caller's active work and storage remain unaffected.
- [ ] Test forged scope, rejected authentication/negotiation, resource exhaustion
      and provider-secret isolation; rejected requests allocate no resources.
- [ ] Run build/typecheck, affected suites, existing-mode regressions and real Docker
      acceptance through the Bun-compiled client. Record fresh evidence separately
      from the superseded PR's results.
- [ ] Supply operator documentation, migration/rollback and rollout policy, and a
      client-only changeset with the implementation before marking ready for review.

The feature must remain unavailable until the complete R2 safety and acceptance
baseline passes. This document alone changes no runtime behavior.
