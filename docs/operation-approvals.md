# Operator-approved external operations

A caller-isolated Claude or Codex agent proposes named work. The connector registers the proposal from its A2A artifact, presents the stored arguments, and submits an explicitly authenticated operator decision. An independent host claims the approved work after the agent has exited. The operator time window is configured per operation, from one hour to seven days. Existing native tool approvals continue to use their own policy.

## Register a host operation

1. As the **agent owner**, use an owner-session bearer to register a definition with `PUT /admin-api/agents/:agent/operations/:operation`. The agent and operation come from the URL. The bridge derives owner and revision from the authenticated owner and current agent registration. List definitions with `GET /admin-api/agents/:agent/operations`, read one with `GET` on its item URL, replace it with `PUT`, and retire it with `DELETE`. Changes apply across replicas without a restart. A semantic change or retirement cancels unclaimed work. Restoring the old definition cannot revive it. A retired executor can still reconcile work it already claimed. After ownership transfer, the new owner must register a fresh definition and a different executor credential. Finish reconciliation before deleting the agent, which removes its ledger.
2. Give each designated executor a random high-entropy bearer secret (e.g. 32 random bytes encoded as hex). Set `executorTokenSha256` to the lowercase SHA-256 hex digest of the literal bearer string without a trailing newline. Keep the secret on the executor. A credential rotation with the same named executor preserves the request. Update the operation version when changing the handler's semantics. A definition change invalidates outstanding unclaimed approvals. Have the agent submit a new proposal using the updated definition.
3. Register each operator by verified identity. For a federated operator, supply the platform subject, connector DID and authentication method URI. Omitting `method` selects the Mentionable Slack workspace proof (`urn:mentionable:auth:slack-workspace-member:v0.1`). For any other proof, supply its exact `method`. For direct Google or SIWE, supply only the individual principal: `google:<verified-sub>` or `eth:0x<40 lowercase hex digits>`. The agent's caller policy must also admit the operator. A listed operator can approve or deny their own proposal using the same decision credential required for any other proposal. Any authorized requester can cancel their own proposal before execution. Removing the requester's grant or transferring ownership cancels outstanding work. Removing an operator's grant cancels their unconsumed decisions.
4. On the **bridge client**, add `"operations":["merge-pr"]` under the Claude or Codex backend's `caller_runtime`. These names control which operations its `propose_operation` MCP tool offers. Include argument names and formats in `operatorInstructions`. The proposal tool works with file delivery disabled. Keep all side-effect credentials on the executor host, outside the agent's environment, mounts and available credential proxies.

To register a PR merge, save the following body as `merge-pr.json` and replace the example targets, operator identities and digest.

```json
{
  "version":"1",
  "executorId":"github-host",
  "executorTokenSha256":"<64 lowercase hexadecimal characters>",
  "ttlSeconds":86400,
  "operators":[
    {"principalId":"slack:T123/U456","actorId":"did:web:connector.example"},
    {"principalId":"google:123456789012345678901"},
    {"principalId":"eth:0x1111111111111111111111111111111111111111"}
  ],
  "fields":{
    "repository":{"type":"string","allowedValues":["example/service"]},
    "pull":{"type":"integer"},
    "base":{"type":"string","allowedValues":["main"]},
    "head":{"type":"string"}
  }
}
```

```sh
curl --fail-with-body -X PUT \
  -H "Authorization: Bearer $OWNER_SESSION" \
  -H 'Content-Type: application/json' \
  --data-binary @merge-pr.json \
  "$BRIDGE_URL/admin-api/agents/ops-agent/operations/merge-pr"
```

Fields are required; extra fields are rejected. Supported values are strings, safe integers and booleans. Use the optional `allowedValues` to pin target identifiers. The host adapter also enforces service-specific constraints and uses upstream preconditions. The model supplies only arguments and a registered operation name. It has no channel to specify a command, executable path, approver, destination URL, executor, credentials, or TTL.

### Migrating an existing bridge

Drain and stop replicas running the old registry before the upgrade. Supply the existing `VICOOP_OPERATIONS` array on the first startup with the new schema. The bridge imports it once, transactionally, and records completion in PostgreSQL. Each current entry keeps its existing policy digest. Entries for past ownership revisions are retained for executor reconciliation. Resolve missing agents or future ownership bindings in the legacy registry before retrying a failed migration.

After startup, verify the active definitions using each owner's list endpoint and remove the environment variable. Subsequent startups ignore its value; retiring an operation through the API is durable even if a replica still has the old environment. A fresh installation starts with an empty registry. During upgrade, an existing live ledger with a missing legacy configuration stops startup to avoid accidentally dropping access; set `[]` only if the legacy registry really was empty.

## v1

The optional A2A extension URI is `https://github.com/planetarium/vicoop-bridge/blob/main/docs/operation-approvals.md#v1`. Discover it in `capabilities.extensions` on either Agent Card version. The bridge advertises it when a supported caller runtime and its current ownership-bound server policy share an operation for an available authentication scheme. Its `params.registrationUrl` identifies the registration endpoint. Resolve a relative URL against the card origin and verify the trusted bridge origin before sending credentials.

Request the URI on each proposal-capable turn using `X-A2A-Extensions` (0.3) or `A2A-Extensions` (1.0). An authenticated Google, SIWE or federated turn can propose the operation names enabled by both the runtime and the current server policy. The proposal artifact carries the same URI in `extensions`. First-time registration requires this marker. For an unregistered artifact from a pre-extension deployment, request a new proposal; existing registered requests retain their IDs and lifecycle. For direct callers, a continued task must still hold the grant recorded when the task was created. Start a new task if the original predates direct operation support or its grant was removed. Ordinary chat works without activation. Activation permits proposal output only. Registration, operator review and host execution use the separate credentials below.

## Connector contract

The tool emits a single A2A artifact with a new `artifactId` and one DataPart:

```json
{"type":"vicoop.operation-proposal.v1","operation":"merge-pr","arguments":{"repository":"example/service","pull":42,"base":"main","head":"<full expected SHA>"}}
```

Using the original requester's bearer, POST `/agents/:agent/operations` with `{taskId,proposalKey,operation,arguments}`. Set `proposalKey` to that artifact's ID. The server authenticates the exact task origin and checks the stored artifact. The first registration requires the durable task to be completed or input-required. A still-working task can be retried after that transition. Failed, rejected and canceled tasks cannot register new work. Retry a 409 indicating the task is still working with the same key. A ready task whose durable snapshot lacks the artifact returns a permanent 400. Each new execution on a replay-capable task replaces the preceding turn’s artifacts. Register proposals before forwarding another turn on the same task. If overlapping turns supersede an unregistered artifact, show that it could not be registered and ask the requester to propose the operation again. A changed payload is a conflict. Store the returned request ID and the original Slack thread association durably. Replaying the same proposal key returns the same request. Ordinary chat text does not enter this flow.

Direct callers use a Google or SIWE caller-session token. SIWE also supports a signed bearer for the bridge's configured public hostname. API keys, anonymous requests and owner-session tokens cannot participate. Operators authenticate with the credential registered for their own identity. For example, a listed SIWE wallet can use the bridge API to approve a Slack request, and a listed Google operator can review a wallet's proposal. [Cross-scheme account linking is tracked separately](https://github.com/planetarium/vicoop-bridge/issues/618).

For federation, the requester registers with a bearer carrying `a2a:task.read`. Each operator exchanges their own fresh platform proof using an agent-scoped platform exchange. A task-bound bearer can access only its own task. The operator's agent-scoped platform bearer needs `a2a:task.read` to review and `a2a:message.send` to decide. Task-continuation and read-only bearers cannot decide.

| Method and path under `/agents/:agent/operations` | Purpose |
| --- | --- |
| GET `/:id` | Requester or registered operator reads `id, taskId, operation, version, executorId, arguments, digest, expiresAt, state, result, canDecide`. Only show decision controls when this caller-specific `canDecide` is true. The decision endpoint independently verifies the operator and current state. |
| POST `/:id/decision` | Operator sends `{"decision":"approve","digest":"..."}` or `deny`. The first valid decision wins. |
| POST `/:id/cancel` | Requester can cancel unconsumed pending or approved work (federated bearers require `a2a:task.read` and `a2a:task.cancel`). |
| GET `/:id/audit` | Requester or operator reads timestamps, decision principals, actors, grants and state transitions. |

Poll the read endpoint for results to deliver back to the originating thread. States are `pending`, `approved`, `denied`, `cancelled`, `expired`, `executing`, `succeeded`, `failed` or `unknown`. Expiry is calculated from the server clock until claim. The host checks the deadline again immediately before submission. The persisted operation can outlive its A2A task. Direct callers can poll with a valid caller credential for the recorded grant. For background polling over federation, exchange a freshly signed task-continuation assertion for only `a2a:task.read`. When the task has been pruned, the original requester, connector actor, live grant and ownership revision must still match the operation ledger. The resulting bearer is restricted to this task's operation status reads. It cannot fetch A2A tasks, decide, cancel or retrieve the audit log. Removing and re-adding the requester grant permanently revokes recovery of those prior operations.

## Run the designated executor

The one-shot Node worker in [examples/operation-executor](../examples/operation-executor/) processes one item; run it periodically, using a scheduler account isolated from agent workloads. Configure `BRIDGE_URL`, `AGENT_ID`, `OPERATION`, `OPERATION_VERSION`, `EXECUTOR_TOKEN` and `OPERATION_HANDLER` (absolute path to the trusted executable). Use an HTTPS bridge origin; loopback HTTP is supported for local tests.

- For `merge-pr` version `1`, select `github-merge.mjs` and set `GITHUB_REPOSITORY`, `GITHUB_BASE_BRANCH` and a scoped `GITHUB_TOKEN`. The handler checks the PR number, open state, repository, base branch and head immediately before submitting the approved full head SHA to GitHub. GitHub’s merge endpoint atomically checks only the head SHA. Enforce repository rules that allow the executor identity to update only the approved base branch, including for a PR retargeted between the check and merge. The executor identity must have no ruleset bypass.
- For `argocd-sync` version `1`, select `argocd-sync.mjs` and register `application, namespace, project, revision` string arguments. Set `ARGOCD_URL`, `ARGOCD_TOKEN`, `ARGOCD_APPLICATION`, `ARGOCD_NAMESPACE`, `ARGOCD_PROJECT`, `ARGOCD_REPOSITORY`. Use a dedicated single-source Git Application with controller-managed configuration and project/RBAC restrictions on permitted repositories and destinations. The handler pins the full commit SHA. Its success result means the controller accepted the sync request. Rollout health is a later observation.
- For site-specific work such as withdrawal approval, install the site's trusted executable and define the immutable inputs, e.g. an internal withdrawal ID and expected revision. The site adapter must atomically verify the preconditions, enforce its own limits and use the operation ID for upstream idempotency or reconciliation. The repository does not contain a withdrawal-provider integration.

The worker authenticates `POST /operation-executors/:agent/:operation/claim`. An atomic SQL claim returns `{operation:null}` or a stored job exactly once. The handler receives that job as JSON on stdin and runs without a shell. It must return only a user-safe `{state,result}` on stdout, with a state of `succeeded`, `failed` or `unknown`. Keep internal artifacts and credentials out of the result; it will be shown to the requester. A timeout, malformed handler response, or uncertain upstream write leads to reconciliation. The host reports the result to `POST /operation-executors/:agent/:operation/:id/result`.

If a host dies after claim, or loses a response, inspect `GET /operation-executors/:agent/:operation/unresolved` with its credential for executing/unknown IDs. Check the actual provider before recording a result. Re-reporting the same final state and result is idempotent. An unknown outcome can be settled by ID. The bridge never reassigns consumed work.
