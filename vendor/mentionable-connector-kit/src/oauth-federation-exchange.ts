// OAuth federation profile v0.1 — RFC 8693 token-exchange client (#618, #619).
//
// The Connector-side half of the exchange: build the form-encoded request
// (assertions are minted separately under the
// `@mentionable/connector-kit/signing` subpath and passed in as strings, so
// this module stays fetch-only), POST it to the token endpoint with
// `private_key_jwt` client authentication, and parse the response into a
// typed success or a typed OAuth error.
//
// v0.1 topology (the #618 scope amendment, "direct Connector delegation
// only", supersedes the earlier decision-9 gateway/broker generalization):
// the assertion issuer IS the OAuth client IS the derived actor. The request
// carries no `actor_token`/`actor_token_type`; the STS derives the RFC 8693
// `act` from the authenticated `client_id` and applies fixed delegation
// semantics to relay-verified message-scope exchanges (output authorization
// context: principal = platform subject, actor = Connector DID). A
// platform-subject assertion whose `iss` differs from the authenticated
// `client_id` — the stolen / forwarded-assertion case — is rejected.
//
// Retry semantics: this client NEVER retries. Every recognized OAuth error
// code except a 5xx `server_error` is a client fault (`retryable: false`) — in particular
// `invalid_request` (e.g. issuer/client inequality) and `invalid_grant`
// (expired/replayed assertion) mean the request itself must change;
// re-sending the same bytes cannot succeed. Only transport-level failures
// (5xx, unparseable bodies) are marked retryable for the CALLER to back off
// on.
//
// The STS-side reference evaluator (`evaluateTokenExchangeRequest`) lives
// here too: it is pure (no crypto — assertion signatures are verified
// separately by the reference verifier in the signing subpath) and gives a
// consuming STS the profile's request-shape / issuer-equality / resource
// rules to test against, mirroring the conformance fixtures.

// `jose`'s decode helpers are pure base64url/JSON parsing (no crypto, no
// node built-ins), so importing them here keeps this module edge/worker safe.
import { decodeJwt, decodeProtectedHeader } from 'jose'

import {
  OAUTH_CLIENT_ASSERTION_TYPE_JWT_BEARER,
  OAUTH_FEDERATION_SCOPES,
  OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION,
  OAUTH_GRANT_TYPE_TOKEN_EXCHANGE,
  OAUTH_TOKEN_TYPE_ACCESS_TOKEN,
  OAUTH_TOKEN_TYPE_JWT,
  isTokenExchangeErrorCode,
  scopesRequireSubjectAssertion,
  type OAuthFederationScope,
  type TokenExchangeErrorCode,
} from './oauth-federation.js'

/** The v0.1 scope registry as a set — unknown scopes fail closed. */
const KNOWN_SCOPES: ReadonlySet<string> = new Set(OAUTH_FEDERATION_SCOPES)

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

export type TokenExchangeRequest = {
  /**
   * Assertion JWT presented as `subject_token` (platform-subject for
   * message-scope exchanges; task-continuation for task-scope-only
   * re-exchange). Its `iss` MUST be the same DID as `clientId` — the v0.1
   * direct-Connector topology; an STS rejects the request otherwise.
   */
  subjectToken: string
  /** Defaults to `urn:ietf:params:oauth:token-type:jwt` — the only v0.1 type. */
  subjectTokenType?: typeof OAUTH_TOKEN_TYPE_JWT
  /** Exactly one canonical resource (RFC 8707) — the agent's advertised A2A endpoint URL. */
  resource: string
  /**
   * Requested scopes (space-joined on the wire). v0.1 requires at least one
   * member of the closed profile registry.
   */
  scope: readonly OAuthFederationScope[]
  /** Defaults to `urn:ietf:params:oauth:token-type:access_token`. */
  requestedTokenType?: typeof OAUTH_TOKEN_TYPE_ACCESS_TOKEN
  /** OAuth client id — the Connector DID. */
  clientId: string
  /** RFC 7523 client assertion JWT (`private_key_jwt`). */
  clientAssertion: string
}

/**
 * Build the `application/x-www-form-urlencoded` body for an RFC 8693 token
 * exchange with `private_key_jwt` client authentication. Pure; exported so
 * fixtures and consuming tests can pin the exact wire shape.
 */
export function buildTokenExchangeBody(request: TokenExchangeRequest): URLSearchParams {
  if (
    request.scope === undefined ||
    request.scope.length === 0 ||
    request.scope.some((scope) => !KNOWN_SCOPES.has(scope))
  ) {
    throw new TypeError(
      'buildTokenExchangeBody: scope must contain at least one known OAuth federation v0.1 scope',
    )
  }
  if (request.subjectTokenType !== undefined && request.subjectTokenType !== OAUTH_TOKEN_TYPE_JWT) {
    throw new TypeError(`buildTokenExchangeBody: subjectTokenType must be ${OAUTH_TOKEN_TYPE_JWT}`)
  }
  if (
    request.requestedTokenType !== undefined &&
    request.requestedTokenType !== OAUTH_TOKEN_TYPE_ACCESS_TOKEN
  ) {
    throw new TypeError(
      `buildTokenExchangeBody: requestedTokenType must be ${OAUTH_TOKEN_TYPE_ACCESS_TOKEN}`,
    )
  }
  const body = new URLSearchParams()
  body.set('grant_type', OAUTH_GRANT_TYPE_TOKEN_EXCHANGE)
  body.set('subject_token', request.subjectToken)
  body.set('subject_token_type', request.subjectTokenType ?? OAUTH_TOKEN_TYPE_JWT)
  body.set('resource', request.resource)
  body.set('scope', request.scope.join(' '))
  body.set('requested_token_type', request.requestedTokenType ?? OAUTH_TOKEN_TYPE_ACCESS_TOKEN)
  body.set('client_id', request.clientId)
  body.set('client_assertion_type', OAUTH_CLIENT_ASSERTION_TYPE_JWT_BEARER)
  body.set('client_assertion', request.clientAssertion)
  return body
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export type TokenExchangeSuccess = {
  ok: true
  accessToken: string
  /** RFC 8693 `issued_token_type` — `urn:ietf:params:oauth:token-type:access_token` in v0.1. */
  issuedTokenType: typeof OAUTH_TOKEN_TYPE_ACCESS_TOKEN
  /** RFC 6749 `token_type` — `Bearer` in v0.1 (DPoP is reserved). */
  tokenType: 'Bearer'
  /** Lifetime in seconds, when the STS provided `expires_in`. */
  expiresIn?: number
  /** Granted scopes (split from the space-delimited `scope`), when returned. */
  scope?: string[]
  /** The full parsed response body. */
  raw: Record<string, unknown>
}

export type TokenExchangeFailure = {
  ok: false
  /** HTTP status of the token-endpoint response. */
  status: number
  /**
   * OAuth error code when the STS returned one; `invalid_response` when the
   * body was not a parseable OAuth error/success document.
   */
  error: TokenExchangeErrorCode | 'invalid_response'
  errorDescription?: string
  errorUri?: string
  /**
   * `false` for client-fault OAuth errors. `true` for a 5xx `server_error`
   * or an unparseable 5xx response the caller may back off on. This client
   * does not perform the retry itself.
   */
  retryable: boolean
  /** The parsed response body when there was one. */
  raw?: Record<string, unknown>
}

export type TokenExchangeResult = TokenExchangeSuccess | TokenExchangeFailure

// ---------------------------------------------------------------------------
// Exchange client
// ---------------------------------------------------------------------------

export type ExchangeTokenOptions = {
  /** RFC 8414 `token_endpoint` URL. */
  tokenEndpoint: string
  /** Injected fetch (tests / bespoke transports). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseSuccess(status: number, body: Record<string, unknown>): TokenExchangeResult {
  const accessToken = body['access_token']
  const issuedTokenType = body['issued_token_type']
  const tokenType = body['token_type']
  if (
    typeof accessToken !== 'string' ||
    accessToken.length === 0 ||
    issuedTokenType !== OAUTH_TOKEN_TYPE_ACCESS_TOKEN ||
    tokenType !== 'Bearer'
  ) {
    return {
      ok: false,
      status,
      error: 'invalid_response',
      errorDescription: 'token endpoint returned a malformed or unsupported access-token response',
      retryable: false,
      raw: body,
    }
  }
  const out: TokenExchangeSuccess = {
    ok: true,
    accessToken,
    issuedTokenType,
    tokenType,
    raw: body,
  }
  const expiresIn = body['expires_in']
  if (expiresIn !== undefined) {
    if (typeof expiresIn !== 'number' || !Number.isInteger(expiresIn) || expiresIn <= 0) {
      return {
        ok: false,
        status,
        error: 'invalid_response',
        errorDescription: 'token endpoint returned malformed expires_in',
        retryable: false,
        raw: body,
      }
    }
    out.expiresIn = expiresIn
  }
  const scope = body['scope']
  if (scope !== undefined) {
    if (typeof scope !== 'string' || scope.length === 0) {
      return {
        ok: false,
        status,
        error: 'invalid_response',
        errorDescription: 'token endpoint returned malformed scope',
        retryable: false,
        raw: body,
      }
    }
    const scopes = scope.split(' ')
    if (scopes.some((token) => token.length === 0 || !KNOWN_SCOPES.has(token))) {
      return {
        ok: false,
        status,
        error: 'invalid_response',
        errorDescription: 'token endpoint returned malformed or unknown scope',
        retryable: false,
        raw: body,
      }
    }
    out.scope = scopes
  }
  return out
}

function parseFailure(status: number, body: unknown): TokenExchangeFailure {
  if (isPlainObject(body) && isTokenExchangeErrorCode(body['error'])) {
    const out: TokenExchangeFailure = {
      ok: false,
      status,
      error: body['error'],
      retryable: body['error'] === 'server_error' && status >= 500,
      raw: body,
    }
    if (typeof body['error_description'] === 'string') {
      out.errorDescription = body['error_description']
    }
    if (typeof body['error_uri'] === 'string') out.errorUri = body['error_uri']
    return out
  }
  const out: TokenExchangeFailure = {
    ok: false,
    status,
    error: 'invalid_response',
    retryable: status >= 500,
  }
  if (isPlainObject(body)) out.raw = body
  return out
}

/**
 * POST one RFC 8693 token-exchange request. Network-level failures (fetch
 * rejection, abort) propagate as exceptions; every HTTP response — success
 * or OAuth error — resolves to a typed {@link TokenExchangeResult}. The
 * client performs no retries under any circumstance (see module header);
 * callers renew tokens by re-exchanging with freshly minted assertions.
 */
export async function exchangeToken(
  request: TokenExchangeRequest,
  options: ExchangeTokenOptions,
): Promise<TokenExchangeResult> {
  const doFetch = options.fetch ?? globalThis.fetch
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: buildTokenExchangeBody(request).toString(),
  }
  if (options.signal !== undefined) init.signal = options.signal
  const response = await doFetch(options.tokenEndpoint, init)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return {
      ok: false,
      status: response.status,
      error: 'invalid_response',
      errorDescription: 'token endpoint did not return JSON',
      retryable: response.status >= 500,
    }
  }
  if (response.ok) {
    if (!isPlainObject(body)) {
      return {
        ok: false,
        status: response.status,
        error: 'invalid_response',
        errorDescription: 'token endpoint returned non-object JSON',
        retryable: false,
      }
    }
    return parseSuccess(response.status, body)
  }
  return parseFailure(response.status, body)
}

// ---------------------------------------------------------------------------
// STS-side SHAPE evaluation — UNVERIFIED, NOT an authorization decision
// ---------------------------------------------------------------------------
//
// `evaluateTokenExchangeRequest` is a FETCH-ONLY, crypto-free gate: it checks
// the request's protocol shape and reads UNVERIFIED JOSE claims. It does NOT
// verify any signature, resolve any DID, or authenticate the client, so its
// output is NOT an authorization decision and MUST NOT be used to mint a
// token. The authenticated, authorization-bearing path is
// `verifyTokenExchange` on the `@mentionable/connector-kit/signing` subpath —
// that is where signatures, DID resolution, `aud`/resource binding, and the
// derived authorization context live. A passing shape verdict is a
// precondition for calling the verifier, never a substitute for it.

export type ExchangeRequestRejectReason =
  | 'duplicate-parameter'
  | 'wrong-grant-type'
  | 'missing-subject-token'
  | 'undecodable-subject-token'
  | 'unsupported-subject-token-type'
  | 'missing-requested-token-type'
  | 'unsupported-requested-token-type'
  | 'missing-resource'
  | 'resource-substitution'
  | 'missing-client-id'
  | 'missing-client-assertion'
  | 'undecodable-client-assertion'
  | 'unsupported-client-assertion-type'
  | 'client-assertion-subject-mismatch'
  | 'unexpected-actor-token'
  | 'issuer-client-mismatch'
  | 'message-scope-requires-subject-assertion'
  | 'missing-scope'
  | 'unknown-scope'

/**
 * The subject token's `iss`/`sub`, read by `decodeJwt` WITHOUT verifying the
 * signature. Deliberately NOT named or shaped like an authorization decision
 * (no `principal`/`actor`/`purpose`): these are unauthenticated inputs, safe
 * only for logging, routing, and as a precondition the verifier re-checks on
 * VERIFIED claims. Both fields are present on a passing shape verdict — an
 * undecodable subject token, or one missing `iss`/`sub`, is rejected.
 */
export type UnverifiedSubjectClaims = {
  iss: string
  sub: string
}

export type ExchangeRequestEvaluation =
  | { ok: true; scopes: string[]; unverifiedSubjectClaims: UnverifiedSubjectClaims }
  | { ok: false; error: TokenExchangeErrorCode; reason: ExchangeRequestRejectReason }

export type ExchangeRequestExpectations = {
  /**
   * The canonical resource of the target agent. When set, a differing
   * `resource` parameter is rejected as `invalid_target`
   * (resource-substitution defense). OPTIONAL here because this is the
   * SHAPE gate; the authenticated `verifyTokenExchange` path makes it
   * REQUIRED so confused-deputy defense can never be silently skipped.
   */
  expectedResource?: string
}

/**
 * Every request parameter this profile reads. RFC 6749 §3.2: request and
 * response parameters MUST NOT be included more than once — a duplicated
 * parameter is rejected outright, because `URLSearchParams.get` returns the
 * FIRST value while other stacks parse last-value-wins, and that split is
 * exactly what a `resource=<canonical>&resource=<attacker>` substitution
 * smuggle exploits.
 */
const SINGLE_VALUED_PARAMS = [
  'grant_type',
  'subject_token',
  'subject_token_type',
  'resource',
  'scope',
  'requested_token_type',
  'client_id',
  'client_assertion',
  'client_assertion_type',
] as const

/** Decode a JWT's protected header without verifying anything; null when undecodable. */
function tryDecodeHeader(jwt: string): { typ?: string } | null {
  try {
    const header = decodeProtectedHeader(jwt)
    return typeof header.typ === 'string' ? { typ: header.typ } : {}
  } catch {
    return null
  }
}

/**
 * SHAPE ONLY, NOT AUTHENTICATED — do not use the result for authorization
 * until the assertions are verified via `verifyTokenExchange` on the signing
 * subpath. This fetch-only gate checks an RFC 8693 request's protocol shape
 * against the v0.1 profile: one-value-per-parameter (RFC 6749 §3.2),
 * grant/token/assertion types, exactly-one-resource, the direct-Connector
 * rules of the #618 scope amendment (any `actor_token`/`actor_token_type`
 * present → `invalid_request`; the subject token's UNVERIFIED `iss` MUST
 * equal the request's `client_id`, so a stolen/forwarded assertion is
 * rejected before any crypto), the decision-8 freshness rule as amended
 * by #618 v0.1 amendment 2 (message-send scopes require a platform-subject
 * assertion — a task-continuation `subject_token` covers task scopes ONLY
 * and is rejected when any message scope is requested), and the scope
 * registry (any requested scope outside the known v0.1 vocabulary →
 * `invalid_scope` / `unknown-scope`).
 *
 * On a passing shape verdict it returns the parsed `scopes` and the
 * `unverifiedSubjectClaims` (`iss`/`sub` read WITHOUT signature verification)
 * — never an authorization decision. Assertions whose JOSE segments cannot be
 * decoded, or that lack `iss`/`sub`, are rejected here
 * (`undecodable-subject-token` / `invalid_request`,
 * `undecodable-client-assertion` / `invalid_client`) so a passing verdict
 * always carries the two claims — but a passing verdict is a PRECONDITION for
 * verification, not a substitute: signatures, DID resolution, `aud` binding,
 * and the resource-binding requirement all live in `verifyTokenExchange`.
 *
 * Error-code mapping: issuer/client inequality (`issuer-client-mismatch`)
 * maps to `invalid_request`, consistent with the profile's other
 * fail-closed request-shape rules — it also covers a decodable subject
 * token with NO `iss` claim (equality cannot be established; the assertion
 * verifier reports the precise missing-claim reason). Client-assertion
 * identity problems map to `invalid_client`.
 */
export function evaluateTokenExchangeRequest(
  params: URLSearchParams,
  expectations: ExchangeRequestExpectations = {},
): ExchangeRequestEvaluation {
  for (const name of SINGLE_VALUED_PARAMS) {
    if (params.getAll(name).length > 1) {
      return { ok: false, error: 'invalid_request', reason: 'duplicate-parameter' }
    }
  }
  if (params.get('grant_type') !== OAUTH_GRANT_TYPE_TOKEN_EXCHANGE) {
    return { ok: false, error: 'unsupported_grant_type', reason: 'wrong-grant-type' }
  }
  const subjectToken = params.get('subject_token')
  if (subjectToken === null || subjectToken.length === 0) {
    return { ok: false, error: 'invalid_request', reason: 'missing-subject-token' }
  }
  if (params.get('subject_token_type') !== OAUTH_TOKEN_TYPE_JWT) {
    return { ok: false, error: 'invalid_request', reason: 'unsupported-subject-token-type' }
  }
  const subjectHeader = tryDecodeHeader(subjectToken)
  if (subjectHeader === null) {
    return { ok: false, error: 'invalid_request', reason: 'undecodable-subject-token' }
  }
  const requestedTokenType = params.get('requested_token_type')
  if (requestedTokenType === null || requestedTokenType.length === 0) {
    return { ok: false, error: 'invalid_request', reason: 'missing-requested-token-type' }
  }
  if (requestedTokenType !== OAUTH_TOKEN_TYPE_ACCESS_TOKEN) {
    return { ok: false, error: 'invalid_request', reason: 'unsupported-requested-token-type' }
  }
  // v0.1 sends NO actor token — the actor is derived from the authenticated
  // client. Any actor_token/actor_token_type present is a deferred-feature
  // request and fails closed rather than being silently ignored.
  if (params.get('actor_token') !== null || params.get('actor_token_type') !== null) {
    return { ok: false, error: 'invalid_request', reason: 'unexpected-actor-token' }
  }
  const resource = params.get('resource')
  if (resource === null || resource.length === 0) {
    return { ok: false, error: 'invalid_target', reason: 'missing-resource' }
  }
  if (expectations.expectedResource !== undefined && resource !== expectations.expectedResource) {
    return { ok: false, error: 'invalid_target', reason: 'resource-substitution' }
  }
  // The authenticated client identity anchors the whole v0.1 topology
  // (issuer == client_id == derived actor), so client_id is required.
  const clientId = params.get('client_id')
  if (clientId === null || clientId.length === 0) {
    return { ok: false, error: 'invalid_client', reason: 'missing-client-id' }
  }
  const clientAssertion = params.get('client_assertion')
  if (clientAssertion === null || clientAssertion.length === 0) {
    return { ok: false, error: 'invalid_client', reason: 'missing-client-assertion' }
  }
  if (params.get('client_assertion_type') !== OAUTH_CLIENT_ASSERTION_TYPE_JWT_BEARER) {
    return { ok: false, error: 'invalid_client', reason: 'unsupported-client-assertion-type' }
  }
  if (tryDecodeHeader(clientAssertion) === null) {
    return { ok: false, error: 'invalid_client', reason: 'undecodable-client-assertion' }
  }
  // RFC 7523 §3: the client assertion's `iss` and `sub` are the client_id.
  // A decodable assertion naming a DIFFERENT party than the request's
  // client_id is a presenter/issuer split this profile does not allow; an
  // UNDECODABLE one is rejected outright — it could never pass full
  // verification, and skipping the identity check here would leave a hole.
  try {
    const claims = decodeJwt(clientAssertion)
    if (claims.iss !== clientId || claims.sub !== clientId) {
      return { ok: false, error: 'invalid_client', reason: 'client-assertion-subject-mismatch' }
    }
  } catch {
    return { ok: false, error: 'invalid_client', reason: 'undecodable-client-assertion' }
  }
  // #618 v0.1 amendment: subject_token.iss MUST equal the authenticated
  // client_id — a platform-subject assertion stolen from (or forwarded by)
  // another Connector cannot be exchanged. Checked on the UNVERIFIED
  // payload; full verification separately. An undecodable subject token is
  // rejected here (not deferred): acceptance must always carry the derived
  // authorization identity.
  let subjectClaims: { iss?: string; sub?: string }
  try {
    const decoded = decodeJwt(subjectToken)
    subjectClaims = {
      ...(typeof decoded.iss === 'string' ? { iss: decoded.iss } : {}),
      ...(typeof decoded.sub === 'string' ? { sub: decoded.sub } : {}),
    }
  } catch {
    return { ok: false, error: 'invalid_request', reason: 'undecodable-subject-token' }
  }
  // Also covers a decodable subject token with NO `iss` claim: equality
  // cannot be established, so it fails closed here; the assertion verifier
  // reports the precise missing-claim reason.
  if (subjectClaims.iss !== clientId) {
    return { ok: false, error: 'invalid_request', reason: 'issuer-client-mismatch' }
  }
  // A decodable token with no usable `sub` cannot name a principal — same
  // treatment as an undecodable one.
  if (subjectClaims.sub === undefined || subjectClaims.sub.length === 0) {
    return { ok: false, error: 'invalid_request', reason: 'undecodable-subject-token' }
  }
  const scope = params.get('scope')
  if (scope === null || scope.length === 0) {
    return { ok: false, error: 'invalid_scope', reason: 'missing-scope' }
  }
  const scopes = scope.split(' ')
  // Requested scopes are restricted to the known v0.1 registry. This kills a
  // smuggling class: e.g. "a2a:message.send\ta2a:task.read" splits (on the
  // RFC 6749 space delimiter) into ONE unknown token that would otherwise
  // sail past the message-scope gate here and then confuse a downstream
  // server that re-splits on generic whitespace.
  for (const token of scopes) {
    if (!KNOWN_SCOPES.has(token)) {
      return { ok: false, error: 'invalid_scope', reason: 'unknown-scope' }
    }
  }
  // #618 decision 8 (as amended by v0.1 amendment 2): subject-assertion
  // freshness constrains message-send scopes — a task-continuation
  // subject_token only covers task-operation scopes. Checked on the
  // UNVERIFIED typ header; verifyTokenExchange re-checks on the VERIFIED
  // typ.
  if (scopesRequireSubjectAssertion(scopes)) {
    if (subjectHeader.typ === OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION) {
      return {
        ok: false,
        error: 'invalid_request',
        reason: 'message-scope-requires-subject-assertion',
      }
    }
  }
  return {
    ok: true,
    scopes,
    // UNVERIFIED — the signing-subpath verifier re-derives the authorization
    // identity from VERIFIED claims. `subjectClaims.iss === clientId` was
    // just enforced; `sub` is a non-empty string by the check above.
    unverifiedSubjectClaims: { iss: clientId, sub: subjectClaims.sub },
  }
}
