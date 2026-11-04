# Agent authentication discovery

The bridge derives authentication advertisements from the current agent caller
policy, rather than treating every restricted agent as a SIWE agent. The A2A
v0.3 and v1 cards and the Mentionable card refresh when callers are added or
removed; no client-daemon restart is required.

| Caller policy | Advertised authentication alternatives |
| --- | --- |
| API key only | Opaque `vbc_caller_*` Bearer token supplied by the operator; no wallet signing |
| Ethereum only | Opaque caller token, plus SIWE Bearer when `PUBLIC_URL` enables domain validation |
| Google only | Opaque caller token, plus Google device flow when its endpoints are configured |
| Exact federated callers only | `vbc_oauth_*` Bearer from OAuth token exchange, when the required caller-context/runtime capabilities are present |
| Mixed | The union of the applicable alternatives above |
| Empty policy, host runtime | Public; no authentication advertisement |
| Empty policy, caller-isolated runtime | A verified direct caller is required: opaque token, SIWE when available, and Google device flow when available |

Federation always requires an exact persisted grant. Caller runtimes also need
`caller-context-v2`, `execution-scope-v1`, `task-replay-v1`, and
`federated-execution-scope-v1` before federation is advertised. An unavailable
authentication path is not replaced with a SIWE advertisement. Authorization
still rejects credentials that do not match the policy.

## Authentication and extension negotiation

The A2A card's `security` (v0.3) or `securityRequirements` (v1) entries are OR
alternatives: satisfy one advertised method. `bearerAuth` describes an opaque
caller token, `siweBearer` describes SIWE, `oauthFederation` describes the
federated access token, and `deviceFlow` describes Google device authorization.
Consumers should inspect scheme contents instead of assuming `bearerAuth`
means SIWE. Before this change, that name was labeled SIWE whenever
`PUBLIC_URL` was configured, even for API-key-only policies.

SIWE and federation extensions describe how to acquire and use those
credentials. They are advertised with `required: false`: a caller using a
pre-issued API key does not need to negotiate either extension. This flag does
not make authentication optional or relax the allowed-caller check. The bridge
owns both advertisements and ignores client-supplied versions, including a
SIWE requirement in the hello card of a public agent.

## Mentionable v0.1 compatibility

The Mentionable projection preserves the A2A `securitySchemes` and `security`
fields at the top level and copies the authentication extensions into
`a2a.capabilities.extensions`. These fields retain every available alternative,
including opaque API keys and mixed authentication.

Mentionable v0.1's legacy `a2a.auth` union supports only `none`, `bearer-jwt`, and
`oauth2`; it cannot encode a non-JWT opaque bearer or a list of alternatives.
For compatibility the bridge keeps that field's existing device-flow mapping
(`oauth2` when available, otherwise `none`). Consumers must use the preserved
A2A security requirements and extensions to determine authentication; the
legacy field alone does not indicate that a restricted endpoint allows
anonymous requests. No new Mentionable auth enum is introduced.

References: [Mentionable card schema](https://github.com/planetarium/mentionable/blob/main/docs/spec/agent-card.md),
[Mentionable connector authentication discovery](https://github.com/planetarium/mentionable/blob/main/examples/slack-connector/src/a2a-auth-requirements.ts).
