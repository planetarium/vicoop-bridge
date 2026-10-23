# Remote tool approval (v1)

Issue [#71](https://github.com/planetarium/vicoop-bridge/issues/71) covers
resuming an already-running Claude/Codex permission request. Operation-level
approval followed by a separate executor is tracked in #544.

## Enable

Upgrade both bridge server and client, and opt in through the client's
`~/.vicoop/config.json` (merge into your existing configuration):

```json
{
  "backends": {
    "claude": { "remote_approvals": true },
    "codex": { "approval_decision": "remote" }
  }
}
```

Select the backend normally. Sign in to the bridge admin UI as the agent owner
or a bridge administrator. The **Tool approvals** panel displays the native
request's tool name and fixed JSON arguments. Choose **Allow once** or **Deny**.
This resumes the pending native request in the same execution, without a new
chat turn or a model-generated interpretation of the decision.

Claude uses `--permission-prompt-tool stdio --permission-mode default`; Codex
uses app-server command/file-change approval requests with `approvalPolicy:
"untrusted"`. Existing native permission rules still apply: this forwards
requests the harness actually raises, not every tool call. Claude allowlists,
including bridge-managed MCP tools, can allow calls without prompting. Configure
native ask/deny rules for operations that must require approval. Claude bypass
permission flags cannot be combined with this mode. Legacy modes remain unchanged.
Unknown approval kinds and unsupported/old bridge peers fail closed. Claude's
AskUserQuestion remains a separate `input-required` flow.

## A2A mapping

The task enters the standard `auth-required` state (`TASK_STATE_AUTH_REQUIRED`
on the A2A 1.0 binding). The underlying SDK (`@a2x/sdk` 0.24.0) marks every
`auth-required` status update `final: true`, but the bridge keeps the physical
stream open: the same stream then carries `working`, any artifacts and the
terminal event (`final: true`). Clients should treat a `final: true`
`auth-required` event carrying this extension's metadata as a suspension, not
as the end of the execution. `tasks/get` sees the state while the stream stays
open. The native execution is retained; clients must not submit a new
message to approve. `contextId` is conversation scope, not approval authority.

The Agent Card advertises this optional extension only while an opted-in client
is connected:

`https://github.com/planetarium/vicoop-bridge/blob/main/docs/tool-approval-v1.md`

The status message includes that URI in `extensions` and a metadata entry keyed
by the URI:

```json
{
  "requestId": "<uuid>",
  "executionId": "<uuid>",
  "toolName": "Bash",
  "input": { "command": "..." },
  "expiresAt": "<ISO timestamp>",
  "decisions": ["allow_once", "deny"],
  "decisionUrl": "/admin-api/agents/<agent-id>/approvals/<request-id>",
  "requesterApprovalUrl": "/agents/<agent-id>/approvals/<request-id>"
}
```

`executionId` is the server-generated ID of the execution that raised the
request (see [Recovering after stream loss](#recovering-after-stream-loss)).
Both URLs are relative to the bridge origin; `<agent-id>` is percent-encoded.
`decisionUrl` is the owner/administrator route; `requesterApprovalUrl` is the
[requester route](#requester-decisions-optional), which denies unless the owner
has opted in. The Agent Card also supplies absolute `decisionUrlTemplate` and
`requesterApprovalUrlTemplate` values when a public URL is configured. Native request
arguments are visible to the authorized task reader, so they should not contain
secrets that the task caller is not allowed to see.

## Recovering after stream loss

A2A reuses a task ID across turns, so a task ID alone does not identify which
execution produced what `tasks/get` returns. The bridge therefore writes a
dispatch marker into the public task metadata, keyed by the extension URI:

```json
{ "metadata": {
  "https://github.com/planetarium/vicoop-bridge/blob/main/docs/tool-approval-v1.md": {
    "executionId": "<uuid>" } } }
```

- The marker is written before each dispatch to the agent and is kept with
  every later snapshot, including the terminal state, so it is still there
  after the native execution has finished and its approval records are gone.
- Every dispatch that reuses the task ID replaces it, including continuations
  by the same caller. A dispatch to a client without execution replay removes
  it. In the same write the task's status is reset to `working`; for a
  replay-capable dispatch (one that gets a marker) its artifacts are also
  cleared, so nothing from an earlier execution is shown under the new marker.
  Conversation `history` is kept.
- While a marker is current, the task's `artifacts` are exactly that
  execution's output (empty if it produced none), even when it reuses an
  artifact ID from an earlier execution. Dispatches without replay support
  (no marker) keep the previous behavior of accumulating artifacts per task.
- Only the server writes it. A value supplied by the caller in request metadata
  is discarded; other metadata keys are preserved.
- Writes from any other message request are not persisted while a marker is
  current: a superseded execution (with or without replay support), and a
  request that fails before it dispatches (payment required, unsupported caller
  scope, or a failure to record the dispatch). The superseded caller still
  receives its own outcome (e.g. `failed`, labelled with its own
  `executionId`); `tasks/get` keeps showing the current execution. Task
  cancellation is unaffected.
- Status update events on the stream carry the same `{ "executionId" }` entry
  in their top-level `metadata`, identifying the execution they came from.

A `message/stream` response (v0.3 JSON-RPC, v1 JSON-RPC and v1 HTTP+JSON) does
not own the execution's lifetime. If the client disconnects — for example a
connector hitting a serverless time limit while an approval's ten-minute
deadline is still running — the bridge detaches the response and keeps draining
the execution's events, so the approval stays decidable and the state and
output keep being persisted until the native terminal state, approval expiry or
the inactivity watchdog ends it. While attached, the response follows the
client's reads with at most one event buffered ahead. To stop an execution,
use `tasks/cancel`; disconnecting does not cancel. Other streams
(`tasks/resubscribe`) still end with their connection.

A client that lost the stream after an `auth-required` approval recovers its
result by calling `tasks/get` and comparing the marker with the approval's
`executionId`. If they are equal, the state and output belong to that
execution. If they differ (or the marker is absent), a later execution has
taken over the task ID and the result must not be attributed to the original
approval. The marker carries no authorization meaning; reading it requires
ordinary `tasks/get` access.

## HTTPS decision API and authority

- `GET /admin-api/approvals`: pending/decided requests visible to the signed-in
  owner (or all requests for a bridge administrator).
- `POST /admin-api/agents/:agentId/approvals/:requestId`: body
  `{"decision":"allow_once"}` or `{"decision":"deny"}`.
- Both require the existing `Authorization: Bearer <owner-session-token>`.
  Agent-call tokens cannot approve here (see requester decisions below). The
  server rechecks current database ownership/administrator authority; a
  principal in a request body is ignored.
- Same principal/same decision retries are idempotent while the execution is
  live. Conflicting/stale decisions return 409; missing or inaccessible requests
  return 404. There is no session-wide grant and no argument editing endpoint.

Never distribute a shared owner bearer token to Slack (or any other) users.
Integrations that want the requester to decide use the route below instead.

## Requester decisions (optional)

An agent owner may let the federated requester who started an execution
(for example a Slack user acting through Mentionable) decide that execution's
own approvals. This is off by default.

### Owner policy

- `GET /admin-api/agents/:agentId/requester-approval-policy` →
  `{"agent_id": "...", "enabled": false}`
- `PUT /admin-api/agents/:agentId/requester-approval-policy` with exactly
  `{"enabled": true}` or `{"enabled": false}`.

Both take the owner-session bearer; RLS limits them to the agent owner or a
bridge administrator (404 otherwise).

For example, with the owner-session token (`vbc_owner_*`, from
`/auth/siwe/exchange` or `/oauth/device/code` with `intent=owner_session`) in
an environment variable rather than on the command line or in shared docs:

```bash
export BRIDGE_URL='https://<your-bridge-host>'
export AGENT_ID='<agent-id>'
export OWNER_SESSION_TOKEN='<vbc_owner_... token>'   # never share with requesters

# Inspect the current policy (defaults to {"enabled": false}).
curl -sS "$BRIDGE_URL/admin-api/agents/$AGENT_ID/requester-approval-policy" \
  -H "Authorization: Bearer $OWNER_SESSION_TOKEN"

# Enable requester decisions for this agent.
curl -sS -X PUT "$BRIDGE_URL/admin-api/agents/$AGENT_ID/requester-approval-policy" \
  -H "Authorization: Bearer $OWNER_SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true}'

# Disable it again. Takes effect on the next requester request; pending
# approvals then need the owner/administrator route.
curl -sS -X PUT "$BRIDGE_URL/admin-api/agents/$AGENT_ID/requester-approval-policy" \
  -H "Authorization: Bearer $OWNER_SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"enabled": false}'
```

URL-encode `AGENT_ID` if it contains reserved characters. The value is persisted in
`agents.requester_approvals_enabled` (default `false`, not writable through
GraphQL) and reread on every requester access, so disabling it takes effect on
the next request. The owner/administrator routes above keep working either way.

### Requester API

- `GET /agents/:agentId/approvals/:requestId`
- `POST /agents/:agentId/approvals/:requestId` with exactly
  `{"decision":"allow_once"}` or `{"decision":"deny"}` (any other key: 400).

Both return:

```json
{ "approval": { "requestId": "...", "agentId": "...", "taskId": "...",
  "executionId": "...", "toolName": "Bash", "input": { "command": "..." },
  "expiresAt": "...", "state": "pending", "decision": "allow_once", "decidedBy": "..." } }
```

`input` is the original, immutable native arguments; `decision`/`decidedBy`
appear once decided. Authentication is
`Authorization: Bearer vbc_oauth_*` — an existing federated
[token-exchange](./oauth-federation.md) access token for this agent that
carries `a2a:task.read`. That token proves identity only; `task.read` keeps its
normative federation meaning. Approval authority is the owner's separate
explicit grant plus all of the following, checked on every request:

1. The token is valid for this agent (not expired/revoked; its exact grant is
   still in `allowed_callers`).
2. `requester_approvals_enabled` is `true` for the agent.
3. The token's principal (platform subject, e.g. workspace/user), actor
   (Connector DID), profile and exact authorization grant equal the
   *approval-origin snapshot*: the identity of the TaskBinding that raised the
   request, copied once when the request was created. Requests raised by
   executions without a complete federated identity are never
   requester-decidable.
4. If the token is bound to a task, it is this approval's task.
5. The exact grant is currently active, and any persisted task row for the task
   is neither revoked nor bound to another identity. A missing task row grants
   nothing; the live binding is required independently.
6. The live execution for the task is still the original execution ID, with
   the same identity as the snapshot.

The snapshot is what keeps a reused task ID from carrying an approval across
executions: a continuation is a new execution, so earlier requests are
invalidated and later requests carry their own origin.

Owner-session, `vbc_caller_*`, public (no bearer) and invalid tokens receive
401. A request that is missing, belongs to another agent or identity, lacks
`task.read`, or whose agent has not opted in receives 404, so the route does not
reveal whether a request exists. Expired or no-longer-live executions, and a
decision that conflicts with an earlier one (including one made by the owner),
receive 409. A retry by the same requester with the same decision is idempotent
while the execution is live. The principal comes only from the token; the body
cannot name one. Revoking the federated caller revokes its tokens and task
authority, which immediately ends requester approval as well; re-adding the
grant does not resurrect it.

Structured logs record `tool_approval_decided` with `decidedVia`
(`owner`/`requester`) and the origin principal/actor/profile, and
`requester_approval_rejected` with a reason code. Neither logs the tool input.
Native arguments are visible to the authorized requester, so they should not
contain secrets that requester is not allowed to see.

## Privacy boundary for native arguments

Native tool arguments (commands, paths, request bodies, MCP inputs) are meant
to reach only whoever inspects the approval: the `approval.request` frame, the
`auth-required` status metadata and the approval APIs above. A task reader that
can call `tasks/get` can read that status metadata; consumers such as Mentionable
are expected to show it only to the approver (e.g. in a private modal).

When remote approvals are enabled on the client (Claude `remote_approvals`,
Codex `approval_decision: "remote"`), every execution of that backend keeps
structured native arguments out of the rest of the task, whether or not a
given call ends up gated. The native trace is emitted before the permission
callback, so filtering only around the approval event would not be enough:

- Claude `claude-tool-call` traceability artifacts carry the tool name only
  (text part and `data.toolName`/`toolUseId`); `claude-subagent-event` omits the
  subagent description.
- Codex `codex-command-execution` traceability artifacts carry status and exit
  code only, without the command, its output or `data.command`.
- Claude non-zero exit failures no longer include the stdout/stderr tails
  (stdout is the raw stream-json, including tool inputs); they go to the
  client's local log instead.

Unchanged: the assistant's own text (`claude-message`/`codex-message`), the
final result, tool-result media (images/PDFs) and `AskUserQuestion`
(`input-required`) content, which is meant for the user. The boundary covers
structured native request details only: if the model writes an argument
into its own prose ("I'll run `curl … token`"), that text is part of the answer
and is not redacted. Tool-result text is never published as an artifact. Without
remote approvals, traces keep their existing argument summaries.

This is enforced by the client, so deployments must upgrade the client (not
only the bridge server) to get it; an older client with remote approvals
enabled still publishes argument summaries in traceability artifacts. Tasks
that do not request the traceability extension never received these
artifacts.

## Binding and lifecycle

The negotiated internal capability is `remote-tool-approval-v1`. The sequenced
`approval.request` and `approval.received` WebSocket frames use existing execution
replay; `approval.resolve` is bound to the exact task, execution and random
request ID. The client snapshots the native arguments before asking and returns
only the native one-shot decision (Claude also gets the unchanged input).
One pending request per execution is supported; overlapping requests are denied.
Requests larger than 64 KiB are denied locally.

The first authorized decision wins. The server retries delivery until receipt;
the client consumes a request once. Receipt means the decision was consumed,
not that a tool's external effect succeeded. Native cancellation/process exit,
task cancellation, execution displacement and expiry invalidate pending requests.
The deadline is ten minutes. Server expiry cancels a still-stuck task. Short
transport outages use the existing reconnect grace; they do not create a new
permission grant. Approval records are in memory: server restart cannot restore
a grant, and the existing execution/reconnect machinery fails the old execution
closed. The task history records approval state transitions and structured server
logs record request/decision/receipt/expiry with the approver principal. There is
no separate durable approval audit table.

The bridge trusts its registered runtime to describe and enforce native tool
requests. This is not a sandbox against a malicious runtime or a guarantee that a
shell command's external effects equal a model's natural-language description.

## Validation

Tests cover native Claude/Codex control messages; argument snapshots; wrong
execution, duplicate and conflicting decisions; timeout/cancel/displacement;
HTTP owner authority; requester opt-in, exact origin binding (wrong
principal/workspace/actor/scope/task, revoked grant, execution replacement),
argument privacy and concurrent/idempotent decisions; the dispatch marker on
initial and terminal `tasks/get`, its replacement on same-task re-dispatch, and
skipped writes from superseded (replay and legacy) executions and from
requests that fail before dispatch, exclusive per-execution artifacts for
replay-capable dispatches (legacy accumulation preserved), the v0.3 SSE
approval event as emitted by the SDK (`final: true`, `executionId`, followed by
`working`/artifact/`completed` on the same stream), and client disconnect on
all three streaming bindings (approval still decidable, result recovered
through `tasks/get`); WebSocket negotiation, replay receipts and heartbeat
state preservation; and persisted A2A suspension/resumption without inactivity
expiry. A local Claude CLI smoke test additionally verified `can_use_tool` and
its denial response without a Claude/Codex update.
