// OAuth federation profile v0.1 — reference assertion verifier (#618, #619).
//
// The STS-side check an implementation (vicoop-bridge#487, or any other
// authorization server) can test itself against: it is what the conformance
// fixtures under fixtures/oauth-federation/v0.1/ are verified with. Exported
// from `@mentionable/connector-kit/signing` alongside the mint functions so
// issuer and verifier pin the exact same constants.
//
// THE documented STS entry point is `verifyTokenExchange(params, options)`:
// it runs the fetch-only shape gate, cryptographically verifies BOTH the
// subject assertion and the `private_key_jwt` client assertion, enforces
// `subject_token.iss == client_id` on the VERIFIED claims, and only then
// returns a `DerivedAuthorizationContext`. It is the ONLY function here that
// yields an authorization decision. `evaluateTokenExchangeRequest` (fetch-only
// main entry) is a precondition, never a substitute — it authenticates
// nothing. `verifyOAuthFederationAssertion` / `verifyClientAssertion` verify
// one assertion each and are the shared building blocks.
//
// Layering mirrors the PlatformIdentityCredential v0.2 reference verifier
// (packages/platform-identity-fixtures/src/reference-verifier.ts):
//
//   1. structural decode (header + claims — no trust yet)
//   2. issuer trust before any resolution (SSRF defense: an untrusted `iss`
//      never causes a DID fetch)
//   3. explicit typing (`typ` exact match, `alg` = EdDSA — RFC 8725)
//   4. kid ∈ issuer DID document's `assertionMethod` (an authorized
//      verification method, not merely a present one)
//   5. claim profile: required claims, exact `aud`, TTL window at the
//      receiver clock with 60 s skew, per-typ subject rules
//   6. signature verification (jose `jwtVerify` over the method's
//      `publicKeyJwk`)
//   7. optional `(iss, jti)` replay cache
//
// Checks 1–5 run before the signature on purpose: every rejection is
// classified by its FIRST failing layer, so fixture expectations stay
// deterministic and an STS can compare error codes one-to-one.

import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from 'jose'

import {
  evaluateTokenExchangeRequest,
  type ExchangeRequestRejectReason,
} from './oauth-federation-exchange.js'
import {
  OAUTH_FEDERATION_ASSERTION_MAX_TTL_SECONDS,
  OAUTH_FEDERATION_CLAIM_METHOD,
  OAUTH_FEDERATION_CLAIM_TASK_ID,
  OAUTH_FEDERATION_CLOCK_SKEW_SECONDS,
  OAUTH_FEDERATION_JWT_ALG,
  OAUTH_FEDERATION_REQUIRED_CLAIMS,
  OAUTH_FEDERATION_TYP_CLIENT_ASSERTION,
  OAUTH_FEDERATION_TYP_SUBJECT_ASSERTION,
  OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION,
  scopesRequireSubjectAssertion,
  type TokenExchangeErrorCode,
} from './oauth-federation.js'

export type AssertionRejectReason =
  | 'malformed'
  | 'wrong-typ'
  | 'wrong-alg'
  | 'untrusted-issuer'
  | 'kid-not-authorized'
  | 'missing-claim'
  | 'wrong-audience'
  | 'subject-mismatch'
  | 'ttl-exceeded'
  | 'not-yet-valid'
  | 'expired'
  | 'invalid-signature'
  | 'replayed-jti'

export type AssertionVerifyOutcome =
  | { ok: true; payload: JWTPayload }
  | { ok: false; reason: AssertionRejectReason; detail?: string }

/**
 * Minimal DID-document shape the verifier consumes: `verificationMethod`
 * entries carrying an Ed25519 `publicKeyJwk` (`{ kty: "OKP", crv: "Ed25519",
 * x }`), and an `assertionMethod` relation listing the AUTHORIZED method ids.
 * A key present in `verificationMethod` but absent from `assertionMethod` is
 * NOT authorized to sign assertions.
 */
export type IssuerDidDocument = {
  id: string
  verificationMethod?: {
    id: string
    publicKeyJwk?: Record<string, unknown>
    [key: string]: unknown
  }[]
  assertionMethod?: (string | { id: string })[]
  [key: string]: unknown
}

/**
 * Replay cache over the `(iss, jti)` tuple. Entries need to live for at
 * least the assertion's validity window plus skew (the profile caps that at
 * 600 s + 60 s); an unbounded set is acceptable only for fixture runs.
 */
export type AssertionReplayCache = {
  /** Returns true when the tuple was newly recorded, false on replay. */
  register(tuple: { issuer: string; jti: string }): boolean
}

/** Test-scale replay cache — never evicts; see {@link AssertionReplayCache}. */
export const createInMemoryAssertionReplayCache = (): AssertionReplayCache => {
  const seen = new Set<string>()
  return {
    register({ issuer, jti }) {
      const key = `${issuer}\u0000${jti}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    },
  }
}

export type VerifyAssertionExpectations = {
  /** The exact `typ` this presentation slot accepts (one of the four profile types). */
  typ: string
  /** The STS's own token endpoint URL — the exact `aud` value. */
  tokenEndpoint: string
  /** Receiver clock at verification time (ISO 8601). */
  verifiedAt: string
}

export type VerifyAssertionOptions = {
  /** Exact issuer DIDs the receiver trusts. Checked before any resolution. */
  trustedIssuers: ReadonlySet<string>
  /**
   * Resolve a TRUSTED issuer's DID document (offline in fixture runs;
   * did:web resolution + caching in production). Only called after the
   * trust check passes.
   */
  resolveIssuerDocument: (issuerDid: string) => IssuerDidDocument | undefined
  /** Verifier posture: present = one-time replay rejection on `(iss, jti)`. */
  replayCache?: AssertionReplayCache
}

const SKEW_SECONDS = OAUTH_FEDERATION_CLOCK_SKEW_SECONDS
const MAX_TTL_SECONDS = OAUTH_FEDERATION_ASSERTION_MAX_TTL_SECONDS

const KNOWN_TYPS: ReadonlySet<string> = new Set([
  OAUTH_FEDERATION_TYP_SUBJECT_ASSERTION,
  OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION,
  OAUTH_FEDERATION_TYP_CLIENT_ASSERTION,
])

const assertionMethodIds = (doc: IssuerDidDocument): string[] => {
  if (!Array.isArray(doc.assertionMethod)) return []
  return doc.assertionMethod
    .map((entry) => (typeof entry === 'string' ? entry : entry.id))
    .filter((id) => typeof id === 'string' && id.length > 0)
}

const audienceMatches = (aud: JWTPayload['aud'], expected: string): boolean => {
  if (typeof aud === 'string') return aud === expected
  if (Array.isArray(aud)) return aud.length === 1 && aud[0] === expected
  return false
}

/**
 * Verify one profile assertion JWT against the expectations of a
 * presentation slot (`subject_token` or `client_assertion` — v0.1 sends no
 * `actor_token`; the STS derives the actor from the authenticated client per
 * the #618 scope amendment). Returns an outcome instead of throwing;
 * `reason` uses the conformance manifest's machine-readable codes.
 */
export async function verifyOAuthFederationAssertion(
  jwt: string,
  expectations: VerifyAssertionExpectations,
  options: VerifyAssertionOptions,
): Promise<AssertionVerifyOutcome> {
  // Receiver-side inputs are validated before anything else: a broken
  // expectations object is a programming error at the call site, not a
  // property of the presented JWT, so it throws instead of returning a
  // reject outcome.
  const verifiedAtMs = Date.parse(expectations.verifiedAt)
  if (Number.isNaN(verifiedAtMs)) {
    throw new TypeError(
      `verifyOAuthFederationAssertion: expectations.verifiedAt must be an ISO 8601 timestamp, got ${JSON.stringify(expectations.verifiedAt)}`,
    )
  }

  // 1. Structural decode — nothing here is trusted yet.
  let header
  let payload: JWTPayload
  try {
    header = decodeProtectedHeader(jwt)
    payload = decodeJwt(jwt)
  } catch (error) {
    return { ok: false, reason: 'malformed', detail: String(error) }
  }

  // 3 (before 2 costs nothing and both precede resolution): explicit typing.
  if (header.alg !== OAUTH_FEDERATION_JWT_ALG) {
    return { ok: false, reason: 'wrong-alg', detail: String(header.alg) }
  }
  if (header.typ !== expectations.typ || !KNOWN_TYPS.has(expectations.typ)) {
    return { ok: false, reason: 'wrong-typ', detail: String(header.typ) }
  }
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    return { ok: false, reason: 'kid-not-authorized', detail: 'missing kid header' }
  }

  // 2. Trusted-issuer-before-fetch. No resolution for unknown issuers.
  const issuer = payload.iss
  if (typeof issuer !== 'string' || issuer.length === 0) {
    return { ok: false, reason: 'missing-claim', detail: 'iss' }
  }
  if (!options.trustedIssuers.has(issuer)) {
    return { ok: false, reason: 'untrusted-issuer', detail: issuer }
  }

  // 4. kid must be a verification method the issuer DID document authorizes
  //    under `assertionMethod`.
  const doc = options.resolveIssuerDocument(issuer)
  if (doc === undefined || doc.id !== issuer) {
    return { ok: false, reason: 'untrusted-issuer', detail: `no issuer document: ${issuer}` }
  }
  if (!assertionMethodIds(doc).includes(header.kid)) {
    return { ok: false, reason: 'kid-not-authorized', detail: header.kid }
  }
  const method = doc.verificationMethod?.find((vm) => vm.id === header.kid)
  if (method?.publicKeyJwk === undefined) {
    return { ok: false, reason: 'kid-not-authorized', detail: `no publicKeyJwk: ${header.kid}` }
  }

  // 5. Claim profile. Presence checks enforce the claim's TYPE, not just
  //    that something is set — a numeric `sub` or object `jti` is as
  //    unusable as a missing one.
  for (const claim of OAUTH_FEDERATION_REQUIRED_CLAIMS) {
    const value = payload[claim]
    const wellTyped =
      claim === 'iat' || claim === 'exp'
        ? typeof value === 'number' && Number.isFinite(value)
        : claim === 'aud'
          ? typeof value === 'string' || Array.isArray(value)
          : typeof value === 'string' && value.length > 0
    if (!wellTyped) {
      return { ok: false, reason: 'missing-claim', detail: claim }
    }
  }
  if (!audienceMatches(payload.aud, expectations.tokenEndpoint)) {
    return { ok: false, reason: 'wrong-audience', detail: JSON.stringify(payload.aud ?? null) }
  }
  const iat = payload.iat as number
  const exp = payload.exp as number
  const verifiedAt = Math.floor(verifiedAtMs / 1000)
  if (exp - iat > MAX_TTL_SECONDS) {
    return { ok: false, reason: 'ttl-exceeded' }
  }
  if (iat - SKEW_SECONDS > verifiedAt) {
    return { ok: false, reason: 'not-yet-valid' }
  }
  // `nbf` is optional in this profile, but when a foreign issuer minted one
  // it must be honored — and classified here, not left to surface as a
  // signature failure. Boundary matches jose (`nbf > now + tolerance`).
  if (typeof payload.nbf === 'number' && payload.nbf - SKEW_SECONDS > verifiedAt) {
    return { ok: false, reason: 'not-yet-valid', detail: 'nbf' }
  }
  // Boundary matches jose 6.x exactly (`exp <= now - tolerance` throws
  // JWTExpired), so the exp+skew instant classifies as `expired` here
  // instead of falling through to layer 6 as `invalid-signature`.
  if (exp + SKEW_SECONDS <= verifiedAt) {
    return { ok: false, reason: 'expired' }
  }
  if (expectations.typ === OAUTH_FEDERATION_TYP_CLIENT_ASSERTION) {
    // Client assertion: the party speaks about itself.
    if (payload.sub !== issuer) {
      return { ok: false, reason: 'subject-mismatch', detail: String(payload.sub) }
    }
  } else if (expectations.typ === OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION) {
    // Task-continuation assertion (#618 v0.1 amendment 2): the subject is
    // the ORIGINATING platform principal (never the issuer itself), and the
    // task binding is mandatory.
    const taskId = payload[OAUTH_FEDERATION_CLAIM_TASK_ID]
    if (typeof taskId !== 'string' || taskId.length === 0) {
      return { ok: false, reason: 'missing-claim', detail: OAUTH_FEDERATION_CLAIM_TASK_ID }
    }
    if (payload.sub === issuer) {
      return { ok: false, reason: 'subject-mismatch', detail: 'sub equals iss' }
    }
  } else {
    // Platform-subject assertion: requires the method claim; the subject is
    // a platform principal, never the issuer itself.
    if (typeof payload[OAUTH_FEDERATION_CLAIM_METHOD] !== 'string') {
      return { ok: false, reason: 'missing-claim', detail: OAUTH_FEDERATION_CLAIM_METHOD }
    }
    if (payload.sub === issuer) {
      return { ok: false, reason: 'subject-mismatch', detail: 'sub equals iss' }
    }
  }

  // 6. Signature over the authorized method's key. Time/audience already
  //    checked above at the receiver clock; jose re-validates exp/nbf at
  //    `currentDate` with the same tolerance, which the layer-5 checks
  //    guarantee passes — any throw here is a signature failure.
  try {
    const key = await importJWK(method.publicKeyJwk, OAUTH_FEDERATION_JWT_ALG)
    await jwtVerify(jwt, key, {
      algorithms: [OAUTH_FEDERATION_JWT_ALG],
      typ: expectations.typ,
      currentDate: new Date(verifiedAtMs),
      clockTolerance: SKEW_SECONDS,
    })
  } catch (error) {
    return { ok: false, reason: 'invalid-signature', detail: String(error) }
  }

  // 7. Replay posture: only a caching verifier gets one-time semantics.
  //    (`jti` is guaranteed a non-empty string by the layer-5 claim checks.)
  if (options.replayCache !== undefined) {
    if (!options.replayCache.register({ issuer, jti: payload.jti as string })) {
      return { ok: false, reason: 'replayed-jti' }
    }
  }

  return { ok: true, payload }
}

// ---------------------------------------------------------------------------
// Client assertion verification (RFC 7523 private_key_jwt)
// ---------------------------------------------------------------------------

export type VerifyClientAssertionExpectations = {
  /** The `client_id` the assertion must speak for (`iss == sub == client_id`). */
  clientId: string
  /** The STS's own token endpoint URL — the exact `aud` value. */
  tokenEndpoint: string
  /** Receiver clock at verification time (ISO 8601). */
  verifiedAt: string
}

/**
 * Verify an RFC 7523 `private_key_jwt` client assertion. Reuses the full
 * assertion machinery of {@link verifyOAuthFederationAssertion} — DID
 * resolution, `kid` ∈ `assertionMethod`, `alg` = EdDSA, exact `typ`
 * (`mentionable-client-assertion+jwt`), `aud` = token endpoint, TTL/skew,
 * signature, and single-use `(iss, jti)` replay — rather than forking it,
 * then pins the RFC 7523 identity rule for this slot: `iss == sub ==
 * client_id`. (`sub == iss` is already enforced for the client-assertion
 * `typ`; this adds `iss == client_id`.) Same `AssertionVerifyOutcome` shape;
 * an `iss`/`client_id` mismatch reports `subject-mismatch`.
 */
export async function verifyClientAssertion(
  jwt: string,
  expectations: VerifyClientAssertionExpectations,
  options: VerifyAssertionOptions,
): Promise<AssertionVerifyOutcome> {
  const outcome = await verifyOAuthFederationAssertion(
    jwt,
    {
      typ: OAUTH_FEDERATION_TYP_CLIENT_ASSERTION,
      tokenEndpoint: expectations.tokenEndpoint,
      verifiedAt: expectations.verifiedAt,
    },
    options,
  )
  if (!outcome.ok) return outcome
  if (outcome.payload.iss !== expectations.clientId) {
    return {
      ok: false,
      reason: 'subject-mismatch',
      detail: `client assertion iss ${JSON.stringify(outcome.payload.iss)} != client_id ${JSON.stringify(expectations.clientId)}`,
    }
  }
  return outcome
}

// ---------------------------------------------------------------------------
// Combined token-exchange verification — THE STS entry point
// ---------------------------------------------------------------------------

/**
 * The authorization context an STS derives from a fully VERIFIED v0.1
 * exchange (#618 scope amendment). Relay exchanges have FIXED delegation
 * semantics: `principal` is the verified subject token's `sub` — always a
 * platform subject, for both the message path (subject assertion) and the
 * task path (task-continuation assertion, whose `sub` is the ORIGINATING
 * platform subject) — and `actor` is the authenticated `client_id`. Produced
 * ONLY by {@link verifyTokenExchange}, never by the fetch-only shape gate.
 *
 * `task_id` is present IFF the subject token was a task-continuation
 * assertion (taken from its VERIFIED `mentionable_task_id` claim). When it
 * is present the STS MUST additionally restrict every operation under the
 * issued token to that task.
 *
 * **Every task operation — regardless of whether the presented token carries
 * a task binding — MUST require `principal` == the task's bound principal in
 * addition to the actor match** (#618 v0.1 amendment 2, as clarified). A
 * message-path token (platform-subject assertion, no `task_id`) legitimately
 * carrying task scopes is NOT exempt: matching on the bound actor alone
 * would let one user of a Connector reach another user's task through the
 * message-path door. This supersedes amendment 1's actor-only continuity
 * wording; the principal/task pair is what makes per-user task isolation
 * enforceable at the STS.
 */
export type DerivedAuthorizationContext = {
  purpose: 'delegation'
  principal: string
  actor: string
  task_id?: string
}

export type VerifyTokenExchangeOptions = VerifyAssertionOptions & {
  /** The STS's own token endpoint — the `aud` both assertions must bind to. */
  tokenEndpoint: string
  /** Receiver clock at verification time (ISO 8601). */
  verifiedAt: string
  /**
   * The canonical resource of the target agent. REQUIRED (unlike the
   * fetch-only shape gate's optional field): confused-deputy / resource
   * substitution defense must never be silently skipped on the authenticated
   * path. Throws when absent or empty.
   */
  expectedResource: string
}

export type TokenExchangeVerifyResult =
  | { ok: true; scopes: string[]; authorization: DerivedAuthorizationContext }
  | {
      ok: false
      stage: 'shape'
      error: TokenExchangeErrorCode
      reason: ExchangeRequestRejectReason
    }
  | {
      ok: false
      stage: 'client-assertion' | 'subject-assertion'
      reason: AssertionRejectReason
      detail?: string
    }
  | {
      ok: false
      stage: 'binding'
      reason: 'issuer-client-mismatch' | 'message-scope-requires-subject-assertion'
    }

/**
 * THE required STS entry point for authorizing an RFC 8693 token exchange
 * under this profile. It (1) runs the fetch-only shape gate
 * ({@link evaluateTokenExchangeRequest}) with the mandatory `expectedResource`
 * binding, (2) cryptographically verifies the `private_key_jwt` client
 * assertion ({@link verifyClientAssertion}), (3) cryptographically verifies
 * the subject assertion ({@link verifyOAuthFederationAssertion}) — a
 * task-continuation assertion when the subject token declares that `typ`
 * (task-scope re-exchange, #618 v0.1 amendment 2), a platform-subject
 * assertion otherwise — (4) re-checks `subject_token.iss == client_id` AND
 * the typ/scope rule (a continuation subject covers task scopes ONLY) on the
 * VERIFIED claims, and only then (5) returns the
 * {@link DerivedAuthorizationContext} — including the verified
 * `mentionable_task_id` as `task_id` for a continuation exchange. Both
 * assertions bind to `tokenEndpoint` as `aud`; both are single-use when a
 * `replayCache` is supplied. Nothing short of an `ok: true` from THIS
 * function authorizes an exchange.
 *
 * `expectedResource` is required — an absent/empty value throws, because the
 * resource-substitution defense must not be skippable on the authenticated
 * path.
 */
export async function verifyTokenExchange(
  params: URLSearchParams,
  options: VerifyTokenExchangeOptions,
): Promise<TokenExchangeVerifyResult> {
  if (typeof options.expectedResource !== 'string' || options.expectedResource.length === 0) {
    throw new TypeError(
      'verifyTokenExchange: options.expectedResource is required — the resource-substitution defense must not be skippable',
    )
  }

  const assertionOptions: VerifyAssertionOptions = {
    trustedIssuers: options.trustedIssuers,
    resolveIssuerDocument: options.resolveIssuerDocument,
    ...(options.replayCache !== undefined ? { replayCache: options.replayCache } : {}),
  }

  // 1. Shape gate (unverified) — a required precondition, not authorization.
  const shape = evaluateTokenExchangeRequest(params, {
    expectedResource: options.expectedResource,
  })
  if (!shape.ok) {
    return { ok: false, stage: 'shape', error: shape.error, reason: shape.reason }
  }

  // Shape success guarantees these are present, single-valued, and non-empty.
  const clientId = params.get('client_id') as string
  const clientAssertion = params.get('client_assertion') as string
  const subjectToken = params.get('subject_token') as string

  // 2. Verify the client assertion (this authenticates client_id).
  const clientOutcome = await verifyClientAssertion(
    clientAssertion,
    { clientId, tokenEndpoint: options.tokenEndpoint, verifiedAt: options.verifiedAt },
    assertionOptions,
  )
  if (!clientOutcome.ok) {
    return {
      ok: false,
      stage: 'client-assertion',
      reason: clientOutcome.reason,
      ...(clientOutcome.detail !== undefined ? { detail: clientOutcome.detail } : {}),
    }
  }

  // 3. Verify the subject assertion. The expected `typ` comes from the
  //    UNVERIFIED header — the verifier enforces an exact `typ` match, and the
  //    shape gate already rejected a continuation subject carrying message
  //    scopes, so a lie here can only produce a `wrong-typ` rejection.
  let subjectTyp: string = OAUTH_FEDERATION_TYP_SUBJECT_ASSERTION
  try {
    if (
      decodeProtectedHeader(subjectToken).typ === OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION
    ) {
      subjectTyp = OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION
    }
  } catch {
    // Leave as subject-assertion; verification rejects a malformed token.
  }
  const subjectOutcome = await verifyOAuthFederationAssertion(
    subjectToken,
    { typ: subjectTyp, tokenEndpoint: options.tokenEndpoint, verifiedAt: options.verifiedAt },
    assertionOptions,
  )
  if (!subjectOutcome.ok) {
    return {
      ok: false,
      stage: 'subject-assertion',
      reason: subjectOutcome.reason,
      ...(subjectOutcome.detail !== undefined ? { detail: subjectOutcome.detail } : {}),
    }
  }
  const isContinuation = subjectTyp === OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION

  // 4. Bindings on VERIFIED claims. The shape gate checked these on
  //    unverified bytes; these are the enforced, authenticated checks.
  //    4a. The subject assertion's issuer must be the authenticated client.
  if (subjectOutcome.payload.iss !== clientId) {
    return { ok: false, stage: 'binding', reason: 'issuer-client-mismatch' }
  }
  //    4b. Typ/scope rule (#618 v0.1 amendment 2): a continuation subject
  //    covers task-operation scopes ONLY — the verified typ is authoritative,
  //    so re-check here even though the shape gate screened the unverified
  //    header.
  if (isContinuation && scopesRequireSubjectAssertion(shape.scopes)) {
    return { ok: false, stage: 'binding', reason: 'message-scope-requires-subject-assertion' }
  }

  // 5. Derived authorization — fixed delegation semantics from VERIFIED
  //    claims. `sub` is a non-empty string (verifier's required-claim check);
  //    for a continuation exchange the VERIFIED `mentionable_task_id`
  //    (guaranteed a non-empty string by the claims profile) binds the task.
  return {
    ok: true,
    scopes: shape.scopes,
    authorization: {
      purpose: 'delegation',
      principal: subjectOutcome.payload.sub as string,
      actor: clientId,
      ...(isContinuation
        ? { task_id: subjectOutcome.payload[OAUTH_FEDERATION_CLAIM_TASK_ID] as string }
        : {}),
    },
  }
}
