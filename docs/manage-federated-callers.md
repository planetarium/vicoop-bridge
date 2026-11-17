# Manage Mentionable federated callers

This guide is for an agent owner who needs to allow a Mentionable Connector to
call one vicoop-bridge agent on behalf of one exact platform subject. It covers
the operator-facing policy commands; for the assertion, token-exchange, and
task-continuity protocol, see
[`oauth-federation.md`](./oauth-federation.md).

## What the command authorizes

One federated caller is the exact tuple:

```text
(Connector issuer DID, authentication method, platform subject)
```

For example:

```text
(did:web:connector.example,
 urn:mentionable:auth:slack-workspace-member:v0.1,
 slack:T123/U456)
```

This permits only Connector `did:web:connector.example` to present the exact
subject `slack:T123/U456` under the exact named method. There are no issuer,
workspace, method, or subject wildcards. Register each allowed subject as a
separate tuple.

`add-federated` configures receiver-owned authorization policy. It does not
issue an access token, register the Connector globally, resolve its DID, or
contact Mentionable. DID and assertion verification happen later, on each
OAuth token exchange.

## Before you begin

You need:

- a bridge release that exposes Mentionable OAuth federation;
- a `vicoop-client` release that includes `agent callers add-federated`;
- an owner session for the bridge;
- the id of an agent you own;
- the exact issuer, method, and subject values supplied by the Connector or
  platform integration.

The target agent must be connected with `caller-context-v2`, and the server
must have `PUBLIC_URL` configured, before its Agent Card advertises federation.
The caller-policy mutation itself is hot-reloaded and does not require an agent
daemon restart in the normal case. The database and the server instance that
handles the mutation update immediately. Other server instances converge via
best-effort PostgreSQL `LISTEN`/`NOTIFY`; recovery steps for a failed
cross-instance notification are listed under troubleshooting.

Check the installed CLI and find the agent id:

```bash
vicoop-client agent callers add-federated --help
vicoop-client agent list
```

For a self-hosted bridge, set its public HTTP URL for the examples below:

```bash
BRIDGE_URL=https://bridge.example
AGENT_ID=my-agent
```

Do not use the daemon's WebSocket URL here. Owner login and admin commands use
the bridge's `https://` URL.

## 1. Sign in as the agent owner

The command requires an owner-session bearer (`vbc_owner_*`), not the
per-agent server token used by the daemon. When the bridge has Google OAuth
device flow enabled, the CLI can obtain and save one directly:

```bash
vicoop-client auth login --server "$BRIDGE_URL"
```

The saved owner session is used automatically by later commands. For CI, set
`VICOOP_BRIDGE` and `VICOOP_OWNER_TOKEN`, or pass `--server` and `--token`
explicitly. The CLI rejects either flag on its own and never combines an
explicit server with a bearer loaded from disk or the environment.

`auth login` calls `/oauth/device/code`, which is not mounted on a self-hosted
bridge without Google OAuth. On a SIWE-only deployment, sign a fresh SIWE
message and exchange it for an owner-session bearer instead. The complete
signing example is in
[`remote-testing.md`](./remote-testing.md#step-1--siwe-exchange); after it
produces a JSON file containing `message` and `signature`, use:

```bash
VICOOP_OWNER_TOKEN=$(curl -fsS -X POST "$BRIDGE_URL/auth/siwe/exchange" \
  -H 'Content-Type: application/json' \
  --data "$(jq -c '. + {intent: "owner_session"}' /path/to/siwe.json)" \
  | jq -er '.access_token')
export VICOOP_BRIDGE="$BRIDGE_URL" VICOOP_OWNER_TOKEN
```

The SIWE domain must match the hostname derived from the bridge's
`PUBLIC_URL`. SIWE nonces are single-use.

## 2. Inspect the current caller policy

```bash
vicoop-client agent callers list "$AGENT_ID" --json
```

Check `is_public` and `allowed_callers` before changing anything:

- an empty `allowed_callers` array means the agent is public;
- adding the first caller changes a public agent into a restricted agent;
- adding a federated caller to an already restricted agent preserves its
  other allowed callers.

Plan the complete caller list before changing a production agent. Adding the
first tuple can immediately stop callers that previously relied on public
access.

## 3. Add one exact federated caller

Use values copied from the Connector's configuration or assertion contract:

```bash
ISSUER=did:web:connector.example
METHOD=urn:mentionable:auth:slack-workspace-member:v0.1
SUBJECT=slack:T123/U456

vicoop-client agent callers add-federated "$AGENT_ID" \
  --issuer "$ISSUER" \
  --method "$METHOD" \
  --subject "$SUBJECT"
```

The fields mean:

| Input | Meaning | Must match at token exchange |
|---|---|---|
| `AGENT_ID` | The receiving vicoop agent | The absolute URL in the Agent Card extension's `params.resource`, for example `https://bridge.example/agents/AGENT_ID` |
| `--issuer` | Connector `did:web` identifier and OAuth client id | Subject assertion `iss` and authenticated client |
| `--method` | How the Connector authenticated the subject | Mentionable authentication-method claim |
| `--subject` | Canonical platform identity | Subject assertion `sub` |

The values are case-sensitive and are not normalized. Do not substitute a
display name or email address for a platform's canonical subject. In the Slack
example, both the workspace id (`T123`) and user id (`U456`) are part of the
identity.

The bridge stores the tuple as a collision-safe internal `federated:v1:`
principal in the existing `allowed_callers` policy. Operators must never build
or edit that encoded value by hand.

Adding the same tuple again is safe and does not create a duplicate. The
command succeeds with `Principal already in allowed callers`.

## 4. Verify the policy and Agent Card

List callers again without `--json` for the decoded table:

```bash
vicoop-client agent callers list "$AGENT_ID"
```

The output includes a section like:

```text
FEDERATED CALLERS
ISSUER                     METHOD                                             SUBJECT
did:web:connector.example  urn:mentionable:auth:slack-workspace-member:v0.1  slack:T123/U456
```

When the agent is connected and eligible, its v0.3 Agent Card advertises the
federation extension:

```bash
curl -fsS \
  "$BRIDGE_URL/agents/$AGENT_ID/.well-known/agent-card.json" \
  | jq '.capabilities.extensions'
```

Look for:

```text
https://mentionable.dev/ns/oauth-federation/v0.1
```

Its parameters identify the authorization server and the exact agent resource
the Connector must request. Registration alone does not prove that token
exchange works; an end-to-end check must use Connector-generated subject and
client assertions. The smoke matrix is in
[`oauth-federation.md`](./oauth-federation.md#smoke-test-checklist).

## Rotate or remove a caller

For a safe tuple rotation, add and verify the replacement before removing the
old tuple:

```bash
vicoop-client agent callers add-federated "$AGENT_ID" \
  --issuer did:web:new-connector.example \
  --method "$METHOD" \
  --subject "$SUBJECT"

vicoop-client agent callers remove-federated "$AGENT_ID" \
  --issuer "$ISSUER" \
  --method "$METHOD" \
  --subject "$SUBJECT"
```

Removal is committed atomically with permanent credential and task revocation.
New exchanges for that tuple are rejected, all access tokens issued under it
are marked revoked, and historical task bindings receive a revocation
timestamp. Re-adding the same tuple authorizes future exchanges only: it does
not reactivate an old token or restore authority over an old task.

Removing a tuple that is already absent is idempotent and reports `Principal
not in allowed callers`.

> **Access-state warning:** removing the last entry from `allowed_callers`
> makes the agent public for new messages. If the agent must remain restricted,
> add a replacement federated or ordinary caller before removing the last one.
> Existing federated tasks remain token-protected.

## Use the HTTP API directly

Automation that does not install `vicoop-client` can call the same
owner-scoped endpoint. Keep the owner token secret; the tuple itself is policy
data, not a credential.

```bash
curl -fsS -X POST \
  "$BRIDGE_URL/admin-api/agents/$AGENT_ID/federated-callers" \
  -H "Authorization: Bearer $VICOOP_OWNER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$(jq -nc \
    --arg issuer "$ISSUER" \
    --arg method "$METHOD" \
    --arg subject "$SUBJECT" \
    '{issuer: $issuer, method: $method, subject: $subject}')"
```

Use the same body with `-X DELETE` to remove the tuple. The API rejects extra
JSON fields.

## Input rules

The server accepts a tuple only when:

- `issuer` starts with `did:web:` and contains no whitespace;
- `method` and `subject` are non-empty;
- none of the values has leading or trailing whitespace;
- issuer and subject lengths are at most 512 each;
- method length is at most 256;
- the complete UTF-8 encoded principal is at most 512 bytes.

The method and subject are opaque exact-match values. Obtain them from the
integration's profile rather than inventing or normalizing them locally.

## Troubleshooting

### `No owner-session bearer found`

On a bridge with Google device flow, run
`vicoop-client auth login --server "$BRIDGE_URL"` again. On a SIWE-only
bridge, repeat the SIWE exchange in Step 1 and export both `VICOOP_BRIDGE` and
`VICOOP_OWNER_TOKEN`. A daemon `server_token` cannot authorize this command.

### `Invalid federated caller`

Check the `did:web:` prefix, leading or trailing whitespace, empty values, and
the size limits above. Quote all three shell values.

### `Agent not found or not authorized`

Confirm `AGENT_ID`, then verify that the owner session belongs to the agent's
owner and to the same bridge deployment.

### The tuple is listed, but the Agent Card has no federation extension

Confirm all of the following:

- the agent daemon is currently connected;
- it advertises `caller-context-v2`;
- the bridge has a correct public `PUBLIC_URL`;
- the persisted caller list contains the federated tuple;
- you fetched the target agent's card, not the root admin Agent Card.

On a multi-instance bridge, also check server logs for
`caller_policy_notify_failed`, `caller_policy_watch_failed`, or
`caller_policy_refresh_failed`. Authorization of federated tokens and tasks
reads the database directly, but an Agent Card or another cached caller-policy
view can remain stale on the instance holding the agent WebSocket when a
notification fails. Retry the mutation after restoring PostgreSQL
notifications, or reconnect the agent to rebuild that instance's cache.

### Token exchange returns `invalid_grant` for an unauthorized subject

Compare the assertion's issuer, method, and subject byte-for-byte with
`agent callers list "$AGENT_ID" --json`. Common causes are a different Slack
workspace id, case changes, and registering a display identity instead of the
canonical platform subject. The response says `subject is not authorized for
this resource`; the corresponding server audit reason is
`caller_not_allowed`.

### Token exchange fails after the tuple matches

Tuple authorization is only the first gate. Check DID reachability and its
`assertionMethod`, EdDSA keys, assertion audience, type, timestamps, `jti`,
requested resource, and scopes. See the protocol checks in
[`oauth-federation.md`](./oauth-federation.md#discovery-and-exchange).
The bridge retries a key miss or signature mismatch once with a bounded forced
DID refresh. DNS, timeout, and upstream failures during either lookup return a
retryable OAuth `server_error`; restore DID endpoint reachability before
retrying with freshly minted assertions.

## Delegate user authorization to a Router

An owner can explicitly trust one exact Connector issuer and authentication
method for an agent. This allows that Connector to authorize individual subjects
without pre-registering every subject. Use this only for a Router that enforces
its own user eligibility and resource policy before signing each assertion.

```sh
vicoop-client agent callers add-delegation AGENT_ID \
  --issuer did:web:router.example \
  --method urn:vicoop:auth:verse8-user:v1
vicoop-client agent callers list AGENT_ID --json
vicoop-client agent callers remove-delegation AGENT_ID \
  --issuer did:web:router.example \
  --method urn:vicoop:auth:verse8-user:v1
```

The owner API exposes `POST` and `DELETE
/admin-api/agents/:id/federated-delegations` with `{ "issuer": "did:web:router.example",
"method": "urn:vicoop:auth:verse8-user:v1" }`. Both require the same owner session
and ownership checks as exact caller management. `callers` inspection includes
`federated_delegations` (id, issuer, method, policy) and `federation_restricted`.
The structured API emits a `federated_delegation_changed` audit log with operator,
agent, action and policy generation. No user source tokens are recorded.

Delegations are explicitly typed `federated-delegation:v1:` policy entries in
`allowed_callers`, separate from `federated:v1:` exact subjects. They contain a
server-generated immutable UUID. Repeated addition is idempotent; removal and
re-addition creates a new generation. Generic caller add/remove rejects these
entries. Do not edit encoded records manually. Exact grants take precedence for
new exchanges; a task's original authorization key is pinned. Removing an exact
grant cannot transfer its tasks to an overlapping delegation.

This is a Bridge receiver-policy extension using the existing Mentionable v0.1
assertion wire format, not a new subject wildcard in the exact-grant format.
Discovery advertises federation when an active exact grant or delegation is
present; it does not publish trusted issuers or subjects. Existing connectors
continue to submit signed client and subject assertions. All signature, type,
audience, resource, scope, lifetime and replay checks remain in force.

The Router DID is issuer/client/actor; the individual subject remains principal.
Execution scopes use the full issuer/method/subject tuple, not the shared policy
ID, so two users never share a workspace. Stable users retain their workspace
across token renewal. Task and context access also checks the original policy,
principal and actor. A re-added policy does not revive historical task/context
bindings even though the same user's workspace identity remains stable.

After the first delegation is configured, the sticky
`federation-restricted:v1` marker keeps the agent restricted even after every
active rule is removed. The database preserves it through policy replacement;
it is not an authorizing principal and cannot be removed through generic caller
commands. This deliberately differs from the legacy exact-only empty-list
public convention. Rollback to an older server remains fail-closed for these
unknown entries; delegation requires the upgraded server. No automatic public
conversion or downgrade migration is provided.

Revocation and token issuance serialize on the agent policy row. Resource-token
checks and task-policy checks read PostgreSQL on each request, independently of
best-effort registry notifications. The anonymous fast path refreshes an empty
registry policy from the database before admitting requests. Database lookup
errors fail closed. Cards may remain stale until notification/reconnect, but
stale discovery cannot authorize an exchange or resource request. Already
admitted operations and streams are not automatically canceled.

Bridge access tokens last at most 300 seconds. Individual Verse8 agreement
removal is Router's responsibility: Router stops admitting that user and issuing
new assertions within its documented verification/cache bounds. Existing Bridge
tokens may remain usable for their remaining lifetime unless the entire
delegation is revoked. Bridge never receives the raw Verse8 token or queries
agreements. Removing a delegation revokes its tokens and tombstones task bindings
transactionally. See planetarium/vicoop-router#174 for the corresponding ingress
contract and interoperability test.
