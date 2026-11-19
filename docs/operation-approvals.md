# Operator-approved external operations

A caller-isolated Claude or Codex agent proposes named work. The connector registers the proposal from its A2A artifact, presents the stored arguments, and submits an explicitly authenticated operator decision. An independent host claims the approved work after the agent has exited. The operator time window is configured per operation, from one hour to seven days. Existing native tool approvals continue to use their own policy.

## Register a host operation

1. On the **bridge server**, set `VICOOP_OPERATIONS` to a JSON array of deployment-managed definitions. The default empty registry disables these routes. All server replicas must use the same definitions. Use `SELECT id, owner_principal, owner_revision FROM agents WHERE id = ...` to obtain the current ownership binding. The revision changes on ownership transfer. Keep the previous revision's definition while its executor reconciles any claimed work. Register the new revision with a different executor credential. Only the current revision can claim work; the previous executor can list unresolved claims and finalize outcomes for its own revision. Removing the old definition disables even that recovery access. Deleting the agent removes its ledger, so finish reconciliation before deletion.
2. Give each designated executor a random high-entropy bearer secret (e.g. 32 random bytes encoded as hex). Set `executorTokenSha256` to the lowercase SHA-256 hex digest of the literal bearer string without a trailing newline. Keep the secret on the executor. A credential rotation with the same named executor preserves the request. Update the operation version when changing the handler's semantics. A definition change invalidates outstanding unclaimed approvals. Have the agent submit a new proposal using the updated definition.
3. Register each operator by the independent platform subject and connector DID. A current agent-scoped federated credential and exact operator membership are required. People sharing a workspace grant do not share operator authority. Configure requester grants using the normal federation flow. Source-grant removal and ownership transfer cancel outstanding work. Operator-grant removal cancels their unconsumed decisions.
4. On the **bridge client**, add `"operations":["merge-pr"]` under the Claude or Codex backend's `caller_runtime`. These names control which operations its `propose_operation` MCP tool offers. Include argument names and formats in `operatorInstructions`. The proposal tool works with file delivery disabled. Keep all side-effect credentials on the executor host, outside the agent's environment, mounts and available credential proxies.

Example server definition (replace the placeholders with deployment values):

```json
[{
  "agentId":"ops-agent",
  "ownerPrincipal":"<registered owner principal>",
  "ownerRevision":0,
  "operation":"merge-pr",
  "version":"1",
  "executorId":"github-host",
  "executorTokenSha256":"<64 lowercase hexadecimal characters>",
  "ttlSeconds":86400,
  "operators":[{"principalId":"slack:T123/U456","actorId":"did:web:connector.example"}],
  "fields":{
    "repository":{"type":"string","allowedValues":["example/service"]},
    "pull":{"type":"integer"},
    "head":{"type":"string"}
  }
}]
```

Fields are required; extra fields are rejected. Supported values are strings, safe integers and booleans. Use the optional `allowedValues` to pin target identifiers. The host adapter also enforces service-specific constraints and uses upstream preconditions. The model supplies only arguments and a registered operation name. It has no channel to specify a command, executable path, approver, destination URL, executor, credentials, or TTL.

## Connector contract

The tool emits a single A2A artifact with a new `artifactId` and one DataPart:

```json
{"type":"vicoop.operation-proposal.v1","operation":"merge-pr","arguments":{"repository":"example/service","pull":42,"head":"<full expected SHA>"}}
```

With the original requester's agent-scoped federated bearer (`a2a:task.read`), POST `/agents/:agent/operations` with `{taskId,proposalKey,operation,arguments}`. Set `proposalKey` to that artifact's ID. The server authenticates the exact task origin and checks the stored artifact. The first registration requires the durable task to be completed or input-required. A still-working task can be retried after that transition. Failed, rejected and canceled tasks cannot register new work. A new artifact can arrive via SSE before persistence: retry a 409 indicating artifact unavailability with the same key. A changed payload is a conflict. Store the returned request ID and the original Slack thread association durably. Replaying the same proposal key returns the same request. Ordinary chat text does not enter this flow.

Every operator must exchange their own fresh platform proof. An operator who is not the original requester uses an agent-scoped platform exchange. A task-bound bearer can access only its own task. Use the operator's bearer for both review and decision, not a shared bot or requester credential.

| Method and path under `/agents/:agent/operations` | Purpose |
| --- | --- |
| GET `/:id` | Requester or registered operator reads `id, taskId, operation, version, executorId, arguments, digest, expiresAt, state, result`. Render the stored request for review. |
| POST `/:id/decision` | Operator sends `{"decision":"approve","digest":"..."}` or `deny`. The first valid decision wins. |
| POST `/:id/cancel` | Requester can cancel unconsumed pending or approved work. |
| GET `/:id/audit` | Requester or operator reads timestamps, decision principals, actors, grants and state transitions. |

Poll the read endpoint for results to deliver back to the originating thread. States are `pending`, `approved`, `denied`, `cancelled`, `expired`, `executing`, `succeeded`, `failed` or `unknown`. Expiry is calculated from the server clock until claim. The host checks the deadline again immediately before submission. The persisted operation can outlive its A2A task. For background polling, exchange a freshly signed task-continuation assertion for only `a2a:task.read`. When the task has been pruned, the original requester, connector actor, live grant and ownership revision must still match the operation ledger. The resulting bearer is restricted to this task's operation status reads. It cannot fetch A2A tasks, decide, cancel or retrieve the audit log. Removing and re-adding the requester grant permanently revokes recovery of those prior operations.

## Run the designated executor

The one-shot Node worker in [examples/operation-executor](../examples/operation-executor/) processes one item; run it periodically, using a scheduler account isolated from agent workloads. Configure `BRIDGE_URL`, `AGENT_ID`, `OPERATION`, `OPERATION_VERSION`, `EXECUTOR_TOKEN` and `OPERATION_HANDLER` (absolute path to the trusted executable). Use an HTTPS bridge origin; loopback HTTP is supported for local tests.

- For `merge-pr` version `1`, select `github-merge.mjs` and set `GITHUB_REPOSITORY` and the host's scoped `GITHUB_TOKEN`. The handler pins the repository and sends the approved full head SHA with the GitHub merge request.
- For `argocd-sync` version `1`, select `argocd-sync.mjs` and register `application, namespace, project, revision` string arguments. Set `ARGOCD_URL`, `ARGOCD_TOKEN`, `ARGOCD_APPLICATION`, `ARGOCD_NAMESPACE`, `ARGOCD_PROJECT`, `ARGOCD_REPOSITORY`. Use a dedicated single-source Git Application with controller-managed configuration and project/RBAC restrictions on permitted repositories and destinations. The handler pins the full commit SHA. Its success result means the controller accepted the sync request. Rollout health is a later observation.
- For site-specific work such as withdrawal approval, install the site's trusted executable and define the immutable inputs, e.g. an internal withdrawal ID and expected revision. The site adapter must atomically verify the preconditions, enforce its own limits and use the operation ID for upstream idempotency or reconciliation. The repository does not contain a withdrawal-provider integration.

The worker authenticates `POST /operation-executors/:agent/:operation/claim`. An atomic SQL claim returns `{operation:null}` or a stored job exactly once. The handler receives that job as JSON on stdin and runs without a shell. It must return only a user-safe `{state,result}` on stdout, with a state of `succeeded`, `failed` or `unknown`. Keep internal artifacts and credentials out of the result; it will be shown to the requester. A timeout, malformed handler response, or uncertain upstream write leads to reconciliation. The host reports the result to `POST /operation-executors/:agent/:operation/:id/result`.

If a host dies after claim, or loses a response, inspect `GET /operation-executors/:agent/:operation/unresolved` with its credential for executing/unknown IDs. Check the actual provider before recording a result. Re-reporting the same final state and result is idempotent. An unknown outcome can be settled by ID. The bridge never reassigns consumed work.
