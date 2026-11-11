# External job completion and A2A continuation

Issue #574 adds a durable completion inbox and one linked continuation task.
An agent may finish its proposal/submission turn, and its caller runtime may
stop, while a host executor performs an external job. After the executor
reports completion, the bridge starts a new task in the original caller's
context using the ordinary execution path. The client acquires or restarts its
runtime and applies its existing context serialization. The original terminal
task is never changed back to working.

This contract is independent of consumer consent (#575) and operation approval
(#544). The trusted host executor must enforce the applicable approval before
submitting/uploading to a provider. Registering a continuation does not itself
approve that provider operation. Credential proxying (#576) is also independent.

## Authority and immutable registration

The host adapter uses an existing `vbc_owner_*` owner-session bearer. Only the
agent's current owner can register, complete or cancel host jobs; an ordinary
agent-call token or model-authored approval string cannot do so. Keep this
bearer outside the agent workload. There is no new general executor credential
or provider credential relay.

`POST /admin-api/agents/:agentId/deferred-jobs`:

```json
{
  "operationId": "<uuid>",
  "version": 1,
  "payloadDigest": "<64 lowercase hex SHA-256>",
  "sourceTaskId": "<A2A task id>",
  "sourceExecutionId": "<server execution marker UUID>",
  "expiresAt": "2026-11-12T12:00:00.000Z"
}
```

The source task must exist under that agent, carry an authenticated principal,
and have the exact server execution marker. Completed and input-required
sources are valid. Canceled, failed, rejected, revoked or unavailable sources
are not. The server copies principal, actor, authorization profile/grant and
context from that task. Caller identities in a request body are not accepted.
Subsequent turns may replace the source task's execution marker; that does not
change the job's immutable origin snapshot.

Registration snapshots agent ownership and caller-policy revisions. Any later
ownership or caller-policy change invalidates the job conservatively, including
remove/re-add and owner-transfer/return. Exact direct principal grants, public
agents with an authenticated principal, and exact federated grants are supported.
An email/domain-only grant cannot be reconstructed from a task's principal;
register an exact principal grant instead. Task history is not evidence of an
email claim. Owner/caller bearer checks bypass the normal authentication cache.

An operation ID can be registered once per agent. Identical retries return the
same job; changed version/digest/source/expiry conflicts. Replacement work must
have a new operation ID. Expiry must be in the next 30 days. The identity and
execution correlation follows the shared shape used by #575.

A successful response is `{ "job": { ... } }` with `jobId`, `operationId`,
`version`, `payloadDigest`, `sourceTaskId`, `sourceExecutionId`, `contextId`,
`expiresAt`, `state` and nullable `continuationTaskId`. The host should give this
job reference to the consumer as part of the submission response. A promise of
later delivery must follow successful registration, not precede it.

The owner authorizes and funds the follow-up model execution by registering it.
It is not another consumer x402 payment round-trip. The worker does not pass a
payment gate into that host-authorized continuation. It never submits the
external operation or retries a paid provider request.

## Completion, lookup and cancellation

`POST /admin-api/agents/:agentId/deferred-jobs/:jobId/complete`:

```json
{
  "version": 1,
  "payloadDigest": "<same digest>",
  "eventId": "provider-completion-123",
  "outcome": "succeeded",
  "parts": [
    { "kind": "text", "text": "Generation finished; inspect the attached result." },
    { "kind": "file", "file": {
      "name": "candidate.png", "mimeType": "image/png", "bytes": "<base64>"
    } }
  ]
}
```

`outcome` may also be `failed`; the continuation then reviews/reports that
failure. File URI parts can reference larger authorized results; the ordinary
backend's file input restrictions still apply. Completion requests are limited
to 1 MiB and 100 parts. The server bounds the body while reading it.

The first completion is stored transactionally. An identical replay returns
current status, including after cancellation or delivery, without scheduling
again. A changed event ID, result, version or digest conflicts. Completion is a
control operation authenticated independently of model text. Do not put secrets
or private conversation logs in result parts; only intended consumer-visible
results belong there.

Owner endpoints:

- `GET /admin-api/agents/:agentId/deferred-jobs/:jobId`
- `POST /admin-api/agents/:agentId/deferred-jobs/:jobId/cancel`

Consumer endpoints:

- `GET /agents/:agentId/deferred-jobs/:jobId`
- `POST /agents/:agentId/deferred-jobs/:jobId/cancel`

Consumer endpoints accept a bridge caller bearer or federated token. Federated
read needs `a2a:task.read`, cancellation needs `a2a:task.cancel`, and principal,
actor, profile, exact grant and any task binding must match the registered
origin. Raw SIWE bearers should first be exchanged for a caller token. Job
lookup works while the agent's WebSocket is offline. Another caller receives
404. A revoked origin cannot inspect the private job. Cancellation is durable
and cancels a live successor through the same dispatch/cancel serialization
used by ordinary tasks.

## States and delivery

| State | Meaning |
| --- | --- |
| `waiting` | Registered; no completion has been received. |
| `queued` | Completion is durable; waiting for dispatch, including while the agent is offline. |
| `dispatching` | A linked successor has been durably allocated; its model execution is running or its dispatch outcome needs recovery. |
| `delivered` | The successor task completed and its task output was persisted. This is not consumer receipt. |
| `awaiting_input` | The successor ended its turn with an input/authorization wait. Inspect the successor using ordinary A2A. |
| `failed` | The successor failed/rejected. |
| `canceled` | Explicit cancellation, expiry, revoked authority, changed ownership or unavailable origin prevents further work. `failureCode` gives the reason. |
| `reconciliation_required` | A previous dispatch may have occurred, but its terminal outcome cannot be established. It is never automatically repeated. |

Poll the job, then retrieve `continuationTaskId` with ordinary A2A `tasks/get`
or subscribe through the existing task APIs. The successor carries metadata
under this document's URI with job/operation/source correlation. Verify actual
file artifacts and download their bytes; `delivered` alone is not proof that
the consumer received an attachment. No additional consumer message is needed
to cause execution or artifact production.

The completion is passed as a new user-role message in the original context,
with structured job metadata and an instruction to review/deliver rather than
repeat the external operation. That instruction is for workflow clarity, not a
security boundary; the host executor must still gate provider execution.

## Recovery and lifecycle

`startServer` starts the database-backed worker. Embedded users can construct
`DeferredJobsService({ db, registry })`, pass it to `createHttpApp` through
`deferredJobs`, and call `start()` (or deterministic `tick()` in tests).
`createHttpApp` alone mounts the APIs and does not start a background timer.
`stop()` stops polling/admission; existing execution drains continue, and
`drain()` waits for them. A process crash is handled through durable state.

Before dispatch, the worker checks current origin/authority, waits for the
source execution to finish, atomically allocates one successor task and marks
dispatch intent. Normal client lanes serialize same-context work. Pending
rows are scanned in bounded keyset pages so many waiting jobs cannot starve
later completions. No application scans Docker names or runs Docker exec.

Queued work survives server/client restart. Active dispatches renew a one-minute
lease. After a stale lease, a persisted terminal successor establishes success
or failure; absent/nonterminal results become `reconciliation_required`.
The bridge deliberately cannot promise exactly-once effects across a crash
between persisting intent and sending/finishing a task. Inspect the successor,
client execution journal and delivery evidence before arranging any explicit
new work; do not replay the provider submission or old completion to force a
retry. No automatic paid retry or ambiguous artifact re-send is performed.

Expired/missing origin contexts, source cancellation, revoked grants and agent
ownership changes are checked before completion and dispatch and during polling
of active work. Cancellation cannot undo a provider effect or artifact already
sent. A late callback never resurrects canceled work. The normal task retention
policy can make an old source unavailable; such jobs fail closed. Job records
are retained for audit and are not a public GraphQL mutation surface.

## Validation

`deferred-jobs.test.ts` runs against PostgreSQL and the real HTTP application /
WebSocket forwarding executor using a deterministic registered backend sink.
It covers durable offline completion and service restart, original context and
caller forwarding, linked successor artifacts/bytes, source terminal-state
preservation, duplicate/conflicting/stale events, wrong-caller and wrong-token
access, expiry/cancellation/revocation, grant/owner remove-and-restore, immediate
bearer revocation, active cancellation, bounded request bodies, scan fairness,
and ambiguous-dispatch recovery without replay.

This is backend-neutral server coverage, not a live Claude/Codex/provider run.
The integrated #574/#575 E2E should additionally prove the consumer proposal →
approval → one external operation → continuation → attachment retrieval path.
