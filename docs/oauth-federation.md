# Mentionable OAuth federation v0.1

The bridge implements the direct-Connector delegation profile defined by
Mentionable issue #618 and its connector-kit reference implementation. It is
an opt-in authorization path for restricted agents; the existing SIWE, Google,
API-key, and context-only PlatformIdentityCredential paths are unchanged.

## Implementation layers

The bridge keeps RFC 8693 token exchange separate from the Mentionable wire
profile:

- `oauth/token-exchange` owns the shared `/oauth/token` route, RFC 8414
  metadata aggregation, canonical resource selection, opaque access-token
  issuance and revocation, profile-qualified replay storage, and the standard
  token response;
- `oauth/profiles/mentionable-v0.1` owns assertion `typ` and claims, EdDSA and
  DID verification, trust-before-fetch, Mentionable scopes, direct-Connector
  principal/actor derivation, and task-continuation policy.

Installed profiles are selected explicitly and their identifier is persisted
with every access token. Resource-server policy checks that identifier before
applying Mentionable authorization semantics, so tokens from a future profile
cannot be interpreted under this one.

## Trust and identity model

One federated allowed caller is an exact tuple:

```text
(Connector issuer DID, authentication method URN, platform subject)
```

The server stores that tuple in `agents.allowed_callers` using a reversible,
UTF-8 length-prefixed `federated:v1:` encoding. Operators use the structured
API or CLI and do not need to construct that encoding.

For v0.1, every accepted relay exchange has fixed delegation semantics:

```text
subject_token.iss == client_id == actor (Connector DID)
principal         == subject_token.sub (platform subject)
```

`actor_token` is rejected. Gateway/broker presentation, independent actors,
actor-less relay authentication, subject patterns, and a general identity
policy language are deferred. The existing message-bound identity VC remains
context-only and cannot authorize an exchange.

The bridge parses unverified assertion claims only to select one exact
receiver-owned allowed-caller entry. A miss is rejected before DID resolution.
On a hit, it verifies EdDSA, explicit `typ`, the DID `assertionMethod`
relationship, `iss`/`sub`/`aud`/`iat`/`exp`/`jti`, method, lifetime, and replay.
A DID signature alone never grants access.

## Operator configuration

The target agent must be connected with `caller-context-v2`, and the bridge
must have `PUBLIC_URL` configured. Add or remove one exact caller with an owner
session:

```bash
vicoop-client agent callers add-federated AGENT_ID \
  --issuer did:web:connector.example \
  --method urn:mentionable:auth:slack-workspace-member:v0.1 \
  --subject slack:T123/U456

vicoop-client agent callers list AGENT_ID --json

vicoop-client agent callers remove-federated AGENT_ID \
  --issuer did:web:connector.example \
  --method urn:mentionable:auth:slack-workspace-member:v0.1 \
  --subject slack:T123/U456
```

The deterministic owner-scoped HTTP equivalents are:

```text
POST   /admin-api/agents/:id/federated-callers
DELETE /admin-api/agents/:id/federated-callers

{"issuer":"did:web:connector.example","method":"urn:mentionable:auth:slack-workspace-member:v0.1","subject":"slack:T123/U456"}
```

The ordinary callers response includes both the canonical `allowed_callers`
array and a decoded `federated_callers` array. Mutations hot-reload the live
agent card. Removing the tuple immediately makes message tokens fail their
database policy check and makes follow-up task operations fail their persisted
authorization-key check across server instances.

As elsewhere in the bridge, an empty `allowed_callers` array means the agent
is public for new messages. Add a replacement caller before removing the last
federated tuple if the agent must remain restricted. Previously created
federated tasks remain token-protected even when the agent becomes public.

## Discovery and exchange

An eligible Agent Card advertises
`https://mentionable.dev/ns/oauth-federation/v0.1` with:

```json
{
  "authorization_server": "https://bridge.example/.well-known/oauth-authorization-server",
  "resource": "https://bridge.example/agents/AGENT_ID"
}
```

The RFC 8414 document names the existing `/oauth/token` endpoint, RFC 8693 token exchange,
`private_key_jwt`, EdDSA, and the supported A2A scopes. The token endpoint
accepts form-encoded requests up to 64 KiB. Message scopes require a fresh
`mentionable-subject-assertion+jwt`; task-only scopes may use a
`mentionable-task-continuation-assertion+jwt`, whose subject is the originating
platform principal and whose `mentionable_task_id` binds one task. Bare
Connector self-assertions are not accepted. Client assertions use
`typ: mentionable-client-assertion+jwt`. Assertions have a maximum 10-minute
lifetime and 60-second clock tolerance. Issued opaque
`vbc_oauth_*` bearer tokens live for five minutes and are bound to one exact
agent resource and scope set. Continuation-derived tokens are additionally
bound to one task; renewal is re-exchange, not refresh.

## Task continuity and data handling

When a message creates or continues a task, the server persists only:

- the normalized platform principal;
- the Connector actor DID;
- the token-exchange profile identifier;
- the exact federated allowed-caller key.

Later get, cancel, resubscribe, and push-configuration operations require the
corresponding scope, both the same task-bound principal and actor, and an
authorization key still present in the agent's live database policy. This
principal check also applies when a message-path token carries task scopes;
one user of a Connector cannot operate another user's task. Federated task listing is closed
in v0.1 because the current task-store interface has no request-scoped actor
filter.
To avoid mixed-mode leakage, task listing is also rejected for ordinary or
anonymous callers while the agent has any federated task binding.

Raw assertions, access tokens, JWS proofs, and private profile fields are not
written to task JSON, logs, WebSocket task frames, or backend prompts. The
backend receives `caller-context-v2` with the platform subject as `principal`,
the Connector DID as `actor`, and a normalized attestation whose credential id
is a one-way digest of the assertion identity.

## Smoke-test checklist

1. Connect an agent that advertises `caller-context-v2` and add one exact
   federated caller as above.
2. Confirm the Agent Card extension, then fetch the advertised authorization
   server metadata.
3. Exchange valid subject and client assertions for `a2a:message.send`; use the
   resulting token on the advertised resource and record the returned task id.
4. Mint a task-continuation assertion with the originating platform subject
   and returned task id, re-exchange it for `a2a:task.read`, and read that task.
   A different subject or Connector must receive 403 even if it knows the task id.
5. Remove the exact federated caller. The existing message token and task-only
   follow-up must both fail without reconnecting the agent.
6. Repeat message send and task read through v0.3 JSON-RPC, v1 JSON-RPC, and v1
   HTTP+JSON. Wrong resource, audience, method, issuer/client equality, replayed
   `jti`, expired assertion, unsupported scope, and any `actor_token` must fail.
