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
on the A2A 1.0 binding), with `final: false`. `tasks/get` sees the state while the
stream stays open; the existing subscription/stream carries the return to
`working`. The native execution is retained; clients must not submit a new
message to approve. `contextId` is conversation scope, not approval authority.

The Agent Card advertises this optional extension only while an opted-in client
is connected:

`https://github.com/planetarium/vicoop-bridge/blob/main/docs/tool-approval-v1.md`

The status message includes that URI in `extensions` and a metadata entry keyed
by the URI:

```json
{
  "requestId": "<uuid>",
  "toolName": "Bash",
  "input": { "command": "..." },
  "expiresAt": "<ISO timestamp>",
  "decisions": ["allow_once", "deny"],
  "decisionUrl": "/admin-api/agents/<agent-id>/approvals/<request-id>"
}
```

The decision URL is relative to the bridge origin. The Agent Card also supplies
an absolute `decisionUrlTemplate` when a public URL is configured. Native request
arguments are visible to the authorized task reader, so they should not contain
secrets that the task caller is not allowed to see.

## HTTPS decision API and authority

- `GET /admin-api/approvals`: pending/decided requests visible to the signed-in
  owner (or all requests for a bridge administrator).
- `POST /admin-api/agents/:agentId/approvals/:requestId`: body
  `{"decision":"allow_once"}` or `{"decision":"deny"}`.
- Both require the existing `Authorization: Bearer <owner-session-token>`.
  Agent-call tokens cannot approve. The server rechecks current database
  ownership/administrator authority; a principal in a request body is ignored.
- Same principal/same decision retries are idempotent while the execution is
  live. Conflicting/stale decisions return 409; missing or inaccessible requests
  return 404. There is no session-wide grant and no argument editing endpoint.

Mentionable can consume the A2A status, but its existing Slack question buttons
are not approval credentials. This PR does not add Slack approval UI or delegated
approver grants. Such an integration must establish server-verifiable owner or
delegated authority; forwarding a Slack user ID or an A2A caller token is not
sufficient. Never distribute a shared owner bearer token to Slack users.

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
HTTP owner authority; WebSocket negotiation, replay receipts and heartbeat
state preservation; and persisted A2A suspension/resumption without inactivity
expiry. A local Claude CLI smoke test additionally verified `can_use_tool` and
its denial response without a Claude/Codex update.
