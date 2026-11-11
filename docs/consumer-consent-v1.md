# Consumer consent for paid operations (v1)

Issue [#575](https://github.com/planetarium/vicoop-bridge/issues/575) introduces
an explicit A2A consumer decision contract. It is independent of native
Claude/Codex tool permissions (#71), human operational approval (#544), and
completion-triggered continuation (#574).

A trusted supplier host adapter registers a proposal against a real authenticated
A2A task. The bridge snapshots the task's caller, actor, authorization grant,
context and source execution. The consumer inspects the stored request and sends
an explicit authenticated decision. A host executor can then claim exactly one
attempt and receives the stored request to execute. No chat message, model
statement, silence, timeout, or ordinary permission to call an agent grants
consent.

## Authentication and authority

The host endpoints below accept the agent's current owner's `vbc_owner_*`
session. Keep that credential in the host adapter, never in the model's prompt,
container, artifact or tool arguments. The original owner and ownership revision
are captured; transfer away and back cannot restore authority over a proposal.
V1 deliberately does not delegate host execution to another principal or grant
administrators an implicit override.

Consumer endpoints accept existing `vbc_caller_*`, federated `vbc_oauth_*`, or
SIWE bearer authentication (when the bridge has a public SIWE domain). They do
not require the runtime or a native backend permission callback to stay alive.
Anonymous and owner-session requests cannot act as consumer decisions.

The consumer must match the proposal's original authenticated principal and,
for federation, actor, authorization profile and exact grant. A task-bound
federation token must target the source task and have `a2a:task.read`; that scope
proves identity/access only. Approval authority comes separately from the
owner's explicit `approverPolicy: {"kind":"originating-consumer"}` on the
specific immutable proposal. V1 supports that exact-origin policy only; it
never infers arbitrary third-party delegation from caller permission.

The source task must still exist with the original identity/context and must
not be canceled or authorization-revoked. Current caller policy is checked at
read/decision/claim time. A persisted caller-policy revision invalidates all
pending proposals after any `allowed_callers` change, including remove/re-add.
This conservative v1 behavior avoids resurrecting old consent. A newly issued
proposal is needed after changing policy. Owner/caller tokens are checked
without the normal authentication cache. Revocation of the credential used to
approve invalidates unclaimed approval, even after a server restart. Ordinary
expiry of that credential does not erase an already recorded decision; a valid
credential is still required for every new HTTP request.

## Registration and A2A presentation

`POST /admin-api/agents/:id/consent-proposals`:

```json
{
  "operationId": "<new UUID>",
  "sourceTaskId": "<A2A task id>",
  "sourceExecutionId": "<server-written executionId>",
  "expiresAt": "<ISO timestamp in the next seven days>",
  "approverPolicy": {"kind": "originating-consumer"},
  "maxAttempts": 1,
  "request": {
    "prompt": "Requested pose and variation",
    "references": [{"id": "reference.png", "sha256": "<64 lowercase hex characters>"}],
    "provider": "provider identifier",
    "model": "model identifier",
    "settings": {"size": "1024x1024", "quality": "medium"},
    "output": {"count": 1, "format": "png"},
    "limitations": ["Candidate; visual quality is not guaranteed"],
    "externalUpload": {"required": true, "destinations": ["https://provider.example"]},
    "cost": {
      "kind": "estimate", "currency": "USD", "amount": "0.04",
      "terms": "Variable token price; this is not a guaranteed maximum"
    }
  }
}
```

The host does not supply the caller or context. Registration derives both from
the persisted task and verifies its current server-owned execution marker.
Subsequent turns may advance that marker; the proposal retains its immutable
source snapshot rather than becoming executable under the later turn's identity.

`cost.kind` is `estimate`, `variable`, or `cap`. A variable price carries
`currency` and `terms`, not an amount presented as a maximum. A cap also requires
an `enforcedBy` description. The registered executor is responsible for actually
enforcing it; the bridge does not control a provider's billing. Never label an
estimate as a cap. The full request, references, cost terms, source identifiers,
expiry, attempt allowance and approver policy are included in the canonical
SHA-256 `payloadDigest`. The bridge sorts JSON object keys; array order matters.

The response is `{proposal, part, status}` while awaiting approval. `proposal`
contains `operationId`, `version: 1`, `payloadDigest`, `agentId`, `contextId`,
source task/execution, request and machine-readable `state`. `part` is a concrete
A2A DataPart with extension type, the stored proposal, `statusUrl` and
`decisionUrl`. `status` is a ready-to-publish `input-required` status with that
DataPart. The host adapter publishes this exact returned object through its
existing authenticated task output, for example:

```ts
// Host adapter, while handling the source task. ownerToken remains on host.
const presentation = await registerProposal(registration);
emit({ type: 'task.complete', taskId, status: presentation.status });
```

This is a deterministic adapter contract, not an instruction for a model to
invent approval JSON. The bridge does not silently rewrite an already-completed
A2A task. A supplier that completes a separate proposal-publication turn can
publish `part` as its artifact and use the proposal's explicit state as the
compatible waiting representation. Native Claude/Codex adapters do not infer
proposal status from natural-language answers; a host integration must register
and publish it. This server feature does not add an LLM tool or new runtime
credentials. The Agent Card advertises the optional extension and lookup/decision
URL templates whenever the durable server database is available:

`https://github.com/planetarium/vicoop-bridge/blob/main/docs/consumer-consent-v1.md`

All later responses include `{proposal, part}`; only pending responses include
`status`. Approval/claim does not claim that image generation is completed.

The same operation ID and exact registration are idempotent. Every change to
the prompt, reference bytes/hash, provider/model, settings, output, terms, policy
or expiry requires a new operation ID and consent. V1 proposals have immutable
`version: 1`; there is no editing endpoint or approval transfer to a replacement.

## Consumer decision and status

- `GET /agents/:id/consent-proposals/:operationId`
- `POST /agents/:id/consent-proposals/:operationId/decision`
- `POST /agents/:id/consent-proposals/:operationId/cancel` (no body)

Decision body:

```json
{
  "contextId": "<original context>",
  "version": 1,
  "payloadDigest": "<stored digest>",
  "decisionId": "<UUID retained across retries>",
  "decision": "approve"
}
```

`decision` may be `approve` or `reject`. The first decision wins. Re-delivery of
the same decision ID, contents and identity is idempotent, including after
execution, and never creates a second attempt. A conflicting/new decision on
a decided proposal returns 409. Wrong context/digest returns 409; an unknown
schema version or malformed body returns 400. Missing/invalid credentials
return 401; inaccessible proposals return 404 without disclosing other callers'
requests. Responses expose reviewable request details only to the source
consumer or original current owner. No authorization grant, bearer token,
credential digest, or conversation history appears in the projection.

States are `awaiting_approval`, `approved`, `rejected`, `expired`, `canceled`,
`invalidated`, `claimed`, `succeeded`, `failed`, and `unknown`. Expiry and policy
invalidation are persisted on the next status/decision/claim access, and are
checked before any claim can succeed. There is no timeout-based approval.

## Host execution and reconciliation

Host endpoints additionally provide:

- `GET /admin-api/agents/:id/consent-proposals/:operationId`
- `GET /admin-api/agents/:id/consent-proposals/:operationId/audit`
- `POST /admin-api/agents/:id/consent-proposals/:operationId/cancel` (no body)
- `POST /admin-api/agents/:id/consent-proposals/:operationId/claim`
- `POST /admin-api/agents/:id/consent-proposals/:operationId/result`

Claim body is `{version: 1, payloadDigest, claimId: "<UUID>"}`. The database
atomically changes an approved proposal to `claimed`. Only the winner receives
`{execute: true, proposal, request}`. The executor must use this returned stored
request, verify the actual reference bytes against its hashes, enforce output
and spending constraints, and perform no reference upload or provider request
before the claim. A changed/missing reference or unenforceable cap fails the
attempt; do not substitute bytes or silently loosen terms.

A duplicate claim with the same ID returns `{execute: false, proposal}`. Another
claim ID returns 409. **A retry response is never permission to submit again.**
If the first claim response or provider response is lost, reconcile the original
attempt through stored execution/claim identity and provider idempotency/status.
If its outcome cannot be established, leave it `claimed` or report `unknown`;
do not repeat a paid request. The bridge does not promise exactly-once effects
across network failures, and it does not automatically retry provider calls.

Result body:

```json
{
  "version": 1,
  "payloadDigest": "<stored digest>",
  "claimId": "<winning claim UUID>",
  "outcome": "succeeded",
  "providerJobId": "<optional original provider job id>",
  "result": {"artifactSha256": "<optional result details>"}
}
```

`outcome` is `succeeded`, `failed`, or `unknown`. An identical result is
idempotent; a known terminal result cannot change. An `unknown` outcome can be
reconciled to known success/failure for the same claim and provider job, without
releasing another execution allowance. Every paid retry/edit needs new consent.
Cancellation succeeds before claim only. Once claimed, a provider may already
be acting; report/reconcile the result rather than falsely claiming cancellation
prevented the effect. Authority revocation blocks future claims; it cannot undo
an already-submitted external request.

For #574 integration the winning claim supplies
`{operationId, version, payloadDigest, sourceTaskId, sourceExecutionId}` to the
trusted deferred-job registration adapter. Completion and conversation resume
belong to that separate contract. Proposal inspection and result status do not
need a permanently running model process.

## Persistence, privacy and verification

PostgreSQL stores immutable request snapshots, state and an append-only event
trail in server-private `infra.consumer_consent*` tables. They are not exposed
to GraphQL roles. Event entries record decision/claim IDs, actor attribution,
digest and state; they omit request contents and credentials. Public artifact
manifests must not copy private decision records or conversation logs. The
reviewable proposal itself must never contain service keys or private data
unrelated to the operation.

The host adapter/executor is trusted to enforce what it claims. A supplier with
an independent unrestricted credential can bypass this protocol; deploying the
consumer consent gate requires routing the paid operation through the trusted
executor. Credential isolation/proxying alone (#576) does not enforce consent.

`consumer-consent.test.ts` uses real PostgreSQL and HTTP request handlers to
cover exact caller/federated identity, immutable payload binding, expiry,
cancellation, task removal, policy/owner revocation and ABA changes, token
revocation, concurrent claims, restart recovery and ambiguous-result
reconciliation. These server tests are backend-neutral; they do not claim live
Claude/Codex or paid provider execution coverage. The combined #574/#575 E2E
separately exercises real A2A HTTP/WebSocket transport and an isolated provider
fixture, including delivered artifact bytes.
