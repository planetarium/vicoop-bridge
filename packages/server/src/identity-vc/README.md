# Mentionable identity VC verification

This directory implements the verifier and HTTP-boundary integration for
vicoop-bridge issue #467. The client sends exact receiver-local issuer trust
on its authenticated hello. When caller-context capability, non-empty trust,
Postgres replay storage, and a configured public URL are all available, the
bridge advertises the identity extension and maps successful verification into
the canonical caller context. A `caller-context-v2` client receives those
claims as `TaskAssignFrame.caller.attestations`; a v1-only client receives the
same values under the legacy `caller.presented` field. Authentication and
authorization remain unchanged: verification never promotes an attestation
subject to `principal`.

The server selects `caller-context-v2` before `caller-context-v1` from the
authenticated hello. Both versions are serialized from one canonical
`principal` / `actor` / `attestations` representation. The current verifier
can add attestations but cannot create a federated principal or actor; that
requires the explicit receiver-owned policy tracked in #487.

The verifier accepts only the VC 2.0 `PlatformIdentityCredential` profile from
planetarium/mentionable#613, checks exact receiver-local issuer trust before
resolution, resolves only `did:web`, verifies `eddsa-jcs-2022`, enforces the
recipient/message/time bindings, atomically consumes the replay tuple, and
returns an allowlisted presentation object. `extractAndStripIdentityCarrier`
is the boundary adapter: its sanitized metadata result is the only metadata
that may proceed toward task persistence or a backend.

Generic VC 2.0 envelope, proof-purpose, controller authorization, and Data
Integrity verification are delegated to pinned Digital Bazaar packages. The
bridge retains only profile and receiver policy checks. Its closed document
loader exposes only the already safety-resolved DID document and verification
method; it cannot perform context, DID, or arbitrary URL fetches.

## Fixtures

The black-box conformance suite vendors Mentionable PR #614's published v0.2
fixtures at merge commit `988a0922cfd9a77211790aa387f543f180f33e5b` and checks
every file against a SHA-256 lock before verification. `test-fixtures.ts`
remains only for focused mutation tests.

The receiver defaults match the published profile: a 10-minute maximum TTL
and 60-second clock skew. Both remain overridable through
`PlatformIdentityVerifier` options for focused tests.
