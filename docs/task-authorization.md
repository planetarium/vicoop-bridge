# A2A task access

Agent admission (`allowed_callers`) and task ownership are separate checks.
For `/agents/:id` and `/agents/:id/v1`, a directly authenticated caller can
read or act on a task only when its stored `owner_agent` and `owner_principal`
match the requested agent and verified caller. The initial task insert records
the verified principal before execution starts. Tokens reissued to that same
principal retain access; a different principal on the same allowlist does not.
Context IDs and caller-provided metadata do not grant access.

This applies to get, continuation through `message.taskId`, cancel, resubscribe
(including terminal replay), and push notification configuration operations.
Missing and inaccessible direct task reads/mutations return task-not-found
without task content. JSON-RPC uses HTTP 200, echoes the request ID, and returns
code `-32001`, so SDK clients receive `TaskNotFoundError`. HTTP+JSON uses HTTP 404.
Every denied operation is logged with its response rejection ID. Denied requests do not reach the executor or mutate task
state. The agent owner and platform administrators have no implicit override
on these A2A routes. Host execution and caller-isolated execution use the same
server policy.

For message operations, a nonexistent task ID (including one removed by retention)
keeps the SDK's existing behavior: create a new server-generated task under the
current caller. An existing inaccessible task remains denied without mutation.
This deliberately allows a caller who already knows a UUID to distinguish missing
from inaccessible tasks; it preserves continuation after retention without
resuming another caller's task. Caller-provided IDs are never adopted for new rows.

Unknown operations and task operations without a task ID are rejected before SDK
dispatch. Authenticated extended-card retrieval is explicitly recognized; existing
federated restrictions on this operation remain unchanged. SDK upgrades that add
operations must add authorization mappings before the operations are exposed.
HTTP route matching uses the raw URL pathname and decodes IDs exactly once;
malformed encoding returns the SDK-compatible invalid-params response.

A2A v1 listing filters both rows and totals before pagination by the verified
principal. Concurrent callers share SDK handlers, but the listing scope is
request-local. Existing federated profile checks remain in place; federated
listing, and direct listing on an agent with federated task bindings, remain
unsupported as before. Federated tasks require their original authorization
profile, actor, principal, and active grant.

## Public agents and existing tasks

Public agents still admit anonymous calls and share **new public tasks**.
These tasks are explicitly stamped at creation with authorization profile
`vicoop:public-task:v1` and no principal. A bearer sent to a public agent is
not treated as an authenticated identity by the existing admission middleware.

Changing a restricted agent to public does not expose its private tasks.
Changing it back to restricted does not assign historical public tasks to the
next caller. Public tasks become accessible anonymously again only while the
agent is public. Public/private mode changes do not terminate already admitted
streams or executions.

Existing direct tasks with a recorded principal continue to work for that
principal. Existing rows with no principal and no explicit public profile are
inaccessible through A2A and excluded from lists. There is no automatic public
backfill: absence of an owner is not proof of intended sharing. Operators must
start a new task, or separately review reliable creation-time evidence before
repairing ownership. This change requires no schema migration; it uses the
existing authorization columns.

## Verification

Against an isolated local database with the server schema available:

```sh
DATABASE_URL=postgres://localhost/vicoop_task_access_test \
  pnpm --filter @vicoop-bridge/server exec tsx --test src/task-access.test.ts
```

The integration test uses real token issuance/verification, HTTP handlers, and
PostgreSQL persistence, with an in-process test agent replacing provider calls.
It checks both A2A versions and the v1 HTTP+JSON binding, concurrent listing,
working/completed tasks, same/different contexts, token renewal, handler cache
reconstruction, host mode, public transitions, and denied mutation paths.
A deployment should still be verified with two real directly authenticated
callers and a caller-isolated runtime after the server is deployed.
