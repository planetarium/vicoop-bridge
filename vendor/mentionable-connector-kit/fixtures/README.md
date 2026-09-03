# OAuth federation profile v0.1 — conformance fixtures

Conformance fixtures for the DID-backed OAuth federation profile settled in
[planetarium/mentionable#618](https://github.com/planetarium/mentionable/issues/618)
and implemented (issuer/client half) in `@mentionable/connector-kit`
([#619](https://github.com/planetarium/mentionable/issues/619)). The profile
lets an A2A authorization server (STS) exchange a short-lived, DID-backed
Connector assertion for an agent-scoped access token via RFC 8693 token
exchange.

**v0.1 supports direct Connector delegation only** (the #618 scope
amendment): the assertion issuer, the OAuth `client_id`, and the derived
actor are the same Connector DID, `subject_token.iss == client_id` is
enforced, no `actor_token`/`actor_token_type` is sent, and relay-verified
exchanges have fixed delegation semantics — the STS derives the output
authorization context as principal = the platform subject, actor = the
authenticated Connector DID. Per **v0.1 amendment 2**, task-scope re-exchange
uses a TASK-CONTINUATION assertion (`sub` = the originating platform subject,
plus a mandatory `mentionable_task_id` binding; task scopes only; the derived
context gains `task_id` and the STS restricts operations to that task with
the principal matched against the task's bound principal) — the bare
Connector self-assertion is REMOVED. Gateways/brokers, independent actors,
arbitrary `actor_token` support, and actor-less authentication of relay
subjects are deferred to a later profile version.

The normative profile is
[`docs/spec/oauth-federation-v0.1.md`](../../../docs/spec/oauth-federation-v0.1.md).
The typed constants in `packages/connector-kit/src/oauth-federation.ts` plus
these fixtures pin its byte-level wire contract. STS implementations (e.g.
planetarium/vicoop-bridge#487) test against this directory offline; the fixture
JSON files are standalone artifacts consumable without any Mentionable package.

## Layout

- `manifest.json` — every fixture with its kind (`assertion` /
  `exchange-request` / `replay`), the expected outcome, and the
  machine-readable reject reason.
- `issuer/did.json` — the fixture issuer's DID document
  (`did:web:connector.oauth-fixtures.mentionable.dev`). Two verification
  methods, only ONE authorized under `assertionMethod` — the other backs the
  `kid-not-authorized` case.
- `issuer/keys.json` — the pinned test keypairs (seed-derived; see the
  embedded warning — TEST MATERIAL ONLY).
- `valid/` — accepted assertions (platform-subject, task-continuation, and
  the RFC 7523 `private_key_jwt` client assertion, whose `typ` is the
  profile-specific `mentionable-client-assertion+jwt`, NOT bare `JWT` —
  RFC 8725 §3.11 domain separation) and accepted exchange requests: a
  derived-delegation message-scope exchange (no `actor_token` on the wire;
  `expected.authorization` pins the context `verifyTokenExchange` derives —
  principal = platform subject, actor = Connector DID) and a task-scope-only
  exchange whose `subject_token` is a task-continuation assertion
  (`expected.authorization` additionally pins `task_id`).
- `invalid/` — security-failure cases: expired assertion, zero/negative or
  excessive lifetime, wrong `aud`, wrong
  `typ`, wrong `alg` (an unsigned `alg: "none"` token — RFC 8725
  alg-stripping), invalid `mentionable_method`, a `kid` outside the issuer
  fragment namespace or with malformed fragment-URI syntax, malformed issuer
  controller/type/public Ed25519 JWK
  (including private `d` or mixed multibase material), `kid` not authorized
  by the issuer DID, not-yet-valid, tampered signature, a subject assertion issued by a
  DIFFERENT Connector than the authenticated `client_id` (the
  stolen/forwarded-assertion case — `issuer-client-mismatch`; the same
  reason also covers a decodable subject token with NO `iss` claim, since
  equality cannot be established — see
  `invalid/exchange-subject-missing-iss.json`), an undecodable
  `subject_token` (non-JOSE bytes — rejected outright so an accepted
  exchange always carries its derived identity), resource substitution
  (`invalid_target`), a duplicated `resource` parameter (RFC 6749 §3.2 —
  array-valued fixture params encode wire repeats), a message-send-scope
  exchange using a task-continuation `subject_token` (#618 decision 8 as
  amended — a continuation can never send new messages as the subject), a
  continuation assertion missing its mandatory `mentionable_task_id` claim
  (`missing-claim`), a missing/empty scope, a missing/wrong
  `requested_token_type`, and a scope token outside the v0.1 registry
  (`invalid_scope` — the fixture's tab-embedded scope string is ONE unknown
  token after RFC 6749 space-splitting, closing a whitespace re-split
  smuggle).
- `replay/` — the same assertion presented twice: a verifier with a
  `(iss, jti)` replay cache accepts the first presentation and rejects the
  second; a cache-less verifier accepts both and must not claim replay
  safety.

Assertion fixtures carry `{ jwt, verification }`, where `verification` is
the receiver-side binding (`typ` expected in that presentation slot, the
token endpoint the `aud` must equal, and the receiver clock `verifiedAt`).
Verification-method policy fixtures additionally carry an `issuerDocument`
override whose deliberately malformed method must be used in place of the
shared `issuer/did.json`.
Exchange-request fixtures carry `{ params, evaluation }` — the exact
form-encoded request parameters plus the target's canonical resource —
and accept fixtures additionally pin `expected.authorization`, the context an
STS derives via the verified path. Two verification layers apply: the
fetch-only shape gate (`evaluateTokenExchangeRequest`) is UNVERIFIED and
returns only `{ scopes, unverifiedSubjectClaims }`, never an authorization
decision; the authenticated `verifyTokenExchange` — the required STS entry
point — requires its receiver-owned `authorizeCandidateBeforeFetch` callback
to approve the exact unverified platform tuple or continuation task key before
any DID resolution, verifies both subject and client assertions (each binding
to the token endpoint as `aud`, with `expectedResource` and a replay cache
mandatory), and only after policy plus verification produces `expected.authorization`
(`{ purpose: "delegation", principal, actor }`). The callback's caller must
separately retain the matched local policy key for access-token/task binding.
The reject reasons in `manifest.json` for `exchange-request` fixtures are
shape-gate reasons.

## Regenerating

The set is deterministic (seed-derived Ed25519 keys, pinned jtis and
timestamps; Ed25519 signing is deterministic per RFC 8032) — regenerating
yields byte-identical output, enforced by the drift-guard test:

```bash
pnpm -F @mentionable/connector-kit build
pnpm -F @mentionable/connector-kit generate:oauth-fixtures

# Conformance + drift suite:
pnpm -F @mentionable/connector-kit test
```

The reference verifier an STS can test itself against is
`verifyOAuthFederationAssertion` (and the request-shape evaluator
`evaluateTokenExchangeRequest`) in `@mentionable/connector-kit` — see
`packages/connector-kit/src/oauth-federation-fixtures.test.ts` for how the
manifest drives them.
