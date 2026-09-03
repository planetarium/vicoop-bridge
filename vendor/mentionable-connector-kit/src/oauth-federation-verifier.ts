// OAuth federation profile v0.1 — reference assertion verifier (#618, #619).
//
// The STS-side check an implementation (vicoop-bridge#487, or any other
// authorization server) can test itself against: it is what the conformance
// fixtures under fixtures/oauth-federation/v0.1/ are verified with. Exported
// from `@mentionable/connector-kit/signing` alongside the mint functions so
// issuer and verifier pin the exact same constants.
//
// THE documented STS entry point is `verifyTokenExchange(params, options)`:
// it runs the fetch-only shape gate, requires receiver-owned policy approval
// before any DID resolution, cryptographically verifies BOTH the subject
// assertion and the `private_key_jwt` client assertion, enforces
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
  isOAuthFederationAbsoluteUri,
  isOAuthFederationMethodUri,
  scopesRequireSubjectAssertion,
  type OAuthFederationScope,
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
  | 'invalid-lifetime'
  | 'ttl-exceeded'
  | 'not-yet-valid'
  | 'expired'
  | 'invalid-signature'
  | 'invalid-method'
  | 'replayed-jti'

export type AssertionVerifyOutcome =
  | { ok: true; payload: JWTPayload }
  | { ok: false; reason: AssertionRejectReason; detail?: string }

/**
 * Minimal DID-document shape the verifier consumes: `verificationMethod`
 * entries carrying an Ed25519 `publicKeyJwk` (`{ kty: "OKP", crv: "Ed25519",
 * x }`), and an `assertionMethod` relation listing AUTHORIZED string/id-only
 * references or full embedded methods. A referenced key present in
 * `verificationMethod` but absent from `assertionMethod` is NOT authorized to
 * sign assertions; embedded methods receive the same strict key checks.
 */
export type IssuerVerificationMethod = {
  id: string
  type?: string
  controller?: string
  publicKeyJwk?: Record<string, unknown>
  publicKeyMultibase?: unknown
  [key: string]: unknown
}

export type IssuerDidDocument = {
  id: string
  verificationMethod?: IssuerVerificationMethod[]
  assertionMethod?: (string | IssuerVerificationMethod)[]
  [key: string]: unknown
}

/**
 * Replay cache over the `(iss, jti)` tuple. Entries need to live for at
 * least the assertion's validity window plus skew (the profile caps that at
 * 600 s + 60 s); an unbounded set is acceptable only for fixture runs.
 */
export type AssertionReplayCache = {
  /**
   * Atomically register a tuple: true when newly recorded, false on replay.
   * Async results support shared database/Redis adapters.
   */
  register(tuple: { issuer: string; jti: string }): boolean | Promise<boolean>
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
  /**
   * Issuer DIDs eligible for resolution. This SSRF allowlist is checked
   * before any DID fetch, but is not caller authorization by itself; the
   * combined exchange path separately requires candidate policy approval.
   */
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

const authorizedAssertionMethod = (
  doc: IssuerDidDocument,
  kid: string,
): IssuerVerificationMethod | undefined => {
  if (!Array.isArray(doc.assertionMethod)) return undefined
  const relationship = doc.assertionMethod.find((entry) =>
    typeof entry === 'string'
      ? entry === kid
      : typeof entry === 'object' && entry !== null && entry.id === kid,
  )
  if (relationship === undefined) return undefined
  if (typeof relationship === 'object' && Object.keys(relationship).some((key) => key !== 'id')) {
    return relationship
  }
  return doc.verificationMethod?.find((method) => method.id === kid)
}

const audienceMatches = (aud: JWTPayload['aud'], expected: string): boolean => {
  if (typeof aud === 'string') return aud === expected
  if (Array.isArray(aud)) return aud.length === 1 && aud[0] === expected
  return false
}

const isIssuerFragmentDidUrl = (kid: string, issuer: string): boolean => {
  const delimiter = kid.indexOf('#')
  if (
    delimiter !== issuer.length ||
    kid.slice(0, delimiter) !== issuer ||
    delimiter === kid.length - 1 ||
    kid.indexOf('#', delimiter + 1) !== -1 ||
    !isOAuthFederationAbsoluteUri(kid)
  ) {
    return false
  }
  return kid.startsWith('did:')
}

const isPublicEd25519Jwk = (jwk: Record<string, unknown>): boolean =>
  jwk['kty'] === 'OKP' &&
  jwk['crv'] === 'Ed25519' &&
  typeof jwk['x'] === 'string' &&
  jwk['x'].length > 0 &&
  !Object.hasOwn(jwk, 'd')

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

  if (!isIssuerFragmentDidUrl(header.kid, issuer)) {
    return {
      ok: false,
      reason: 'kid-not-authorized',
      detail: `kid is not an absolute fragment DID URL under issuer: ${header.kid}`,
    }
  }

  // 4. kid must be a verification method the issuer DID document authorizes
  //    under `assertionMethod`.
  const doc = options.resolveIssuerDocument(issuer)
  if (doc === undefined || doc.id !== issuer) {
    return { ok: false, reason: 'untrusted-issuer', detail: `no issuer document: ${issuer}` }
  }
  const method = authorizedAssertionMethod(doc, header.kid)
  if (
    method === undefined ||
    method.controller !== issuer ||
    method.type !== 'JsonWebKey' ||
    method.publicKeyJwk === undefined ||
    !isPublicEd25519Jwk(method.publicKeyJwk) ||
    Object.hasOwn(method, 'publicKeyMultibase')
  ) {
    return {
      ok: false,
      reason: 'kid-not-authorized',
      detail: `verification method is not a public issuer-controlled JsonWebKey Ed25519 method: ${header.kid}`,
    }
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
  if (exp <= iat) {
    return { ok: false, reason: 'invalid-lifetime', detail: 'exp must be greater than iat' }
  }
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
    const methodClaim = payload[OAUTH_FEDERATION_CLAIM_METHOD]
    if (typeof methodClaim !== 'string' || methodClaim.length === 0) {
      return { ok: false, reason: 'missing-claim', detail: OAUTH_FEDERATION_CLAIM_METHOD }
    }
    if (!isOAuthFederationMethodUri(methodClaim)) {
      return { ok: false, reason: 'invalid-method', detail: methodClaim }
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
    if (!(await options.replayCache.register({ issuer, jti: payload.jti as string }))) {
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
 * ONLY by {@link verifyTokenExchange} after its required policy gate and
 * cryptographic checks, never by the fetch-only shape gate.
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

/**
 * Unverified, exact-string policy lookup key decoded before any issuer-owned
 * network fetch. It is safe only as input to receiver-owned allowlist/task
 * state lookup; cryptographic verification remains mandatory afterward.
 */
export type TokenExchangePolicyCandidate =
  | {
      readonly kind: 'platform'
      readonly issuer: string
      readonly subject: string
      readonly method: string
      readonly resource: string
      readonly scopes: readonly OAuthFederationScope[]
    }
  | {
      readonly kind: 'continuation'
      readonly issuer: string
      readonly subject: string
      readonly taskId: string
      readonly resource: string
      readonly scopes: readonly OAuthFederationScope[]
    }

export type VerifyTokenExchangeOptions = Omit<VerifyAssertionOptions, 'replayCache'> & {
  /**
   * REQUIRED replay cache for both assertion slots. Production adapters must
   * be atomic across instances. Unlike the standalone assertion verifier,
   * the combined STS path never permits a cache-less successful exchange.
   */
  replayCache: AssertionReplayCache
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
  /**
   * REQUIRED pre-network receiver policy gate. It receives exact raw strings
   * decoded from the unverified subject assertion and request after shape and
   * type-specific claim checks. The candidate object and its scope array are
   * frozen before the callback and before either assertion can trigger DID
   * resolution. Return false for a policy miss. Throws propagate so callers
   * can map policy-store/programming failures to `server_error`.
   *
   * A successful callback must also preserve its receiver-owned policy key
   * outside this verifier and bind that key to the issued access token/task;
   * the boolean result intentionally does not turn unverified data into an
   * authorization context.
   */
  authorizeCandidateBeforeFetch: (
    candidate: TokenExchangePolicyCandidate,
  ) => boolean | Promise<boolean>
}

export type TokenExchangeVerifyResult =
  | { ok: true; scopes: OAuthFederationScope[]; authorization: DerivedAuthorizationContext }
  | {
      ok: false
      stage: 'shape'
      error: TokenExchangeErrorCode
      reason: ExchangeRequestRejectReason
    }
  | {
      ok: false
      stage: 'policy'
      error: 'invalid_grant'
      reason: 'candidate-not-authorized'
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
 * binding, (2) decodes the exact platform tuple or continuation task key and
 * requires the receiver-owned `authorizeCandidateBeforeFetch` policy gate,
 * (3) cryptographically verifies the `private_key_jwt` client assertion
 * ({@link verifyClientAssertion}), (4) cryptographically verifies
 * the subject assertion ({@link verifyOAuthFederationAssertion}) — a
 * task-continuation assertion when the subject token declares that `typ`
 * (task-scope re-exchange, #618 v0.1 amendment 2), a platform-subject
 * assertion otherwise — (5) re-checks `subject_token.iss == client_id` AND
 * the typ/scope rule (a continuation subject covers task scopes ONLY) on the
 * VERIFIED claims, and only then (6) returns the
 * {@link DerivedAuthorizationContext} — including the verified
 * `mentionable_task_id` as `task_id` for a continuation exchange. Both
 * assertions bind to `tokenEndpoint` as `aud`; the REQUIRED `replayCache`
 * makes both single-use. Nothing short of an `ok: true` from THIS
 * function plus the receiver-owned policy key retained by the callback may
 * authorize token issuance.
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
  if (typeof options.authorizeCandidateBeforeFetch !== 'function') {
    throw new TypeError(
      'verifyTokenExchange: options.authorizeCandidateBeforeFetch is required — receiver policy must run before DID resolution',
    )
  }
  if (options.replayCache === undefined || typeof options.replayCache.register !== 'function') {
    throw new TypeError(
      'verifyTokenExchange: options.replayCache is required — the combined STS path must reject assertion replay',
    )
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

  // 2. Receiver-owned policy before network. Decode only enough unverified
  //    subject data to build the exact lookup key. Type-specific claims are
  //    validated before invoking the callback, so it never receives a
  //    partial candidate and malformed input never reaches a resolver.
  let subjectHeader
  let subjectPayload: JWTPayload
  try {
    subjectHeader = decodeProtectedHeader(subjectToken)
    subjectPayload = decodeJwt(subjectToken)
  } catch (error) {
    return { ok: false, stage: 'subject-assertion', reason: 'malformed', detail: String(error) }
  }
  const issuer = shape.unverifiedSubjectClaims.iss
  const subject = shape.unverifiedSubjectClaims.sub
  const resource = params.get('resource') as string
  const scopes = Object.freeze([...shape.scopes]) as readonly OAuthFederationScope[]
  let candidate: TokenExchangePolicyCandidate
  if (
    subjectHeader.typ !== OAUTH_FEDERATION_TYP_SUBJECT_ASSERTION &&
    subjectHeader.typ !== OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION
  ) {
    return {
      ok: false,
      stage: 'subject-assertion',
      reason: 'wrong-typ',
      detail: String(subjectHeader.typ),
    }
  }
  if (subjectHeader.typ === OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION) {
    const taskId = subjectPayload[OAUTH_FEDERATION_CLAIM_TASK_ID]
    if (typeof taskId !== 'string' || taskId.length === 0) {
      return {
        ok: false,
        stage: 'subject-assertion',
        reason: 'missing-claim',
        detail: OAUTH_FEDERATION_CLAIM_TASK_ID,
      }
    }
    candidate = Object.freeze({ kind: 'continuation', issuer, subject, taskId, resource, scopes })
  } else {
    const method = subjectPayload[OAUTH_FEDERATION_CLAIM_METHOD]
    if (typeof method !== 'string' || method.length === 0) {
      return {
        ok: false,
        stage: 'subject-assertion',
        reason: 'missing-claim',
        detail: OAUTH_FEDERATION_CLAIM_METHOD,
      }
    }
    if (!isOAuthFederationMethodUri(method)) {
      return { ok: false, stage: 'subject-assertion', reason: 'invalid-method', detail: method }
    }
    candidate = Object.freeze({ kind: 'platform', issuer, subject, method, resource, scopes })
  }
  if (!(await options.authorizeCandidateBeforeFetch(candidate))) {
    return {
      ok: false,
      stage: 'policy',
      error: 'invalid_grant',
      reason: 'candidate-not-authorized',
    }
  }

  const assertionOptions: VerifyAssertionOptions = {
    trustedIssuers: options.trustedIssuers,
    resolveIssuerDocument: options.resolveIssuerDocument,
    replayCache: options.replayCache,
  }

  // 3. Verify the client assertion (this authenticates client_id).
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

  // 4. Verify the subject assertion. The expected `typ` comes from the
  //    UNVERIFIED header — the verifier enforces an exact `typ` match, and the
  //    shape gate already rejected a continuation subject carrying message
  //    scopes, so a lie here can only produce a `wrong-typ` rejection.
  const subjectTyp =
    subjectHeader.typ === OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION
      ? OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION
      : OAUTH_FEDERATION_TYP_SUBJECT_ASSERTION
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

  // 5. Bindings on VERIFIED claims. The shape gate checked these on
  //    unverified bytes; these are the enforced, authenticated checks.
  //    5a. The subject assertion's issuer must be the authenticated client.
  if (subjectOutcome.payload.iss !== clientId) {
    return { ok: false, stage: 'binding', reason: 'issuer-client-mismatch' }
  }
  //    5b. Typ/scope rule (#618 v0.1 amendment 2): a continuation subject
  //    covers task-operation scopes ONLY — the verified typ is authoritative,
  //    so re-check here even though the shape gate screened the unverified
  //    header.
  if (isContinuation && scopesRequireSubjectAssertion(shape.scopes)) {
    return { ok: false, stage: 'binding', reason: 'message-scope-requires-subject-assertion' }
  }

  // 6. Derived authorization — fixed delegation semantics from VERIFIED
  //    claims. `sub` is a non-empty string (verifier's required-claim check);
  //    for a continuation exchange the VERIFIED `mentionable_task_id`
  //    (guaranteed a non-empty string by the claims profile) binds the task.
  return {
    ok: true,
    scopes: [...scopes],
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
