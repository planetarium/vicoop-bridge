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

## Slack setup: obtain and verify the identifiers

A `google:domain:example.com` grant authorizes verified Google callers from
that domain. It does not authorize those people through Slack federation,
even if their Slack email addresses match. Each Slack grant matches one exact
Connector/workspace/user/method combination, not the whole workspace.

Collect the following before Step 3:

1. **Connector issuer and method:** ask the operator of the Connector serving
   your Slack integration for its configured OAuth client/issuer `did:web`
   and the exact authentication-method value from its deployed assertion
   profile. Request the non-secret `iss`, `sub`, and authentication-method
   claim values from a subject assertion for the intended Slack user and
   workspace. Compare `iss` with the configured client DID. The receiving
   bridge's Agent Card identifies the receiver, not the Connector issuer;
   do not derive the issuer from the bridge URL or Slack workspace name.
   Method names are deployment-specific: the URN in this guide is an example,
   not a default. If the operator cannot provide these values, resolve that
   before registering a grant. Do not share bearer tokens, signed assertions,
   or private keys in support messages.
2. **Slack workspace ID:** open the target workspace in a browser. In a URL
   such as `https://app.slack.com/client/T123/C456`, the `T123` component is the
   workspace ID. An Enterprise organization ID beginning with `E` is not a
   substitute for the workspace ID in a workspace-scoped subject. If your URL
   shows an organization, obtain the target workspace ID from the Connector
   operator and verify it against that integration's Slack installation.
   See [Slack's workspace ID instructions](https://slack.com/help/articles/221769328-Locate-your-Slack-URL-or-ID).
3. **Slack user ID:** open the intended person's Slack profile, choose
   **More → Copy member ID**, and retain the exact value, including case.
   See [Slack's member ID instructions](https://slack.com/help/articles/360003827751-Create-a-link-to-a-members-profile).
   Confirm it is the person being authorized, not the integration's bot user.
4. **Canonical subject:** for a Connector using the `slack:WORKSPACE/USER`
   contract, combine the verified workspace and member IDs, then compare the
   result byte-for-byte with the Connector's assertion `sub`. Confirm this
   mapping with the Connector operator for Enterprise or shared-channel
   integrations; do not substitute an organization ID, channel ID, email,
   or display name.

If the Connector operator uses Slack's
[`auth.test`](https://docs.slack.dev/reference/methods/auth.test/) to check an
installation, `team_id` and `user_id` identify the token's workspace and user.
A bot token's user is not the human caller; it must not be used as that
person's member ID.

For example, **only if your deployment confirms these exact values**:

```bash
ISSUER=did:web:connector.example
METHOD=urn:mentionable:auth:slack-workspace-member:v0.1
SLACK_WORKSPACE_ID=T123
SLACK_USER_ID=U456
SUBJECT="slack:$SLACK_WORKSPACE_ID/$SLACK_USER_ID"
```

Use the [owner session from Step 1](#1-sign-in-as-the-agent-owner) and inspect
existing callers as in Step 2. Add the tuple with Step 3, then use Step 4 to
compare the decoded tuple and check the Agent Card. Finally, make a test call
through the actual Slack integration as that user in that workspace; a listed
tuple alone does not verify the Connector's token exchange. If it fails,
compare all three assertion fields with the saved tuple before changing policy.

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
