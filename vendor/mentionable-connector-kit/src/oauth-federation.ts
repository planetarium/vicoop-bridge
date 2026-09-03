// DID-backed OAuth federation profile v0.1 — wire constants (#618, #619).
//
// The normative profile is docs/spec/oauth-federation-v0.1.md. The typed
// constants below pin its byte-level wire registry for both the Connector
// issuer/client half (this package) and consuming STS / resource-server
// implementations (planetarium/vicoop-bridge#487) import. Keep it
// dependency-free and runtime-neutral — no node:crypto, no fetch; issuance
// lives under the `@mentionable/connector-kit/signing` subpath, the exchange
// client and discovery helpers next door in this package's main entry.
//
// Profile summary (settled in #618: two decision comments + the v0.1 scope
// amendment "direct Connector delegation only", which supersedes the earlier
// decision-9 gateway/broker generalization for v0.1):
//   - Input assertions are JWT-only (`urn:ietf:params:oauth:token-type:jwt`),
//     EdDSA over the Connector's Ed25519 keys; the JWT `kid` header references
//     a verification method authorized by the issuer DID.
//   - Client authentication is `private_key_jwt` (RFC 7523), `client_id` =
//     Connector DID, signed with the same keys.
//   - v0.1 topology is a directly connected Connector:
//     `subject_token.iss == authenticated client_id == derived actor`. No
//     `actor_token`/`actor_token_type` is sent; the STS derives the RFC 8693
//     `act` from the authenticated client (RFC 8693 keeps `actor_token`
//     optional, so this stays protocol-compatible). Relay-verified methods
//     have FIXED delegation semantics — the output authorization context is
//     principal = platform subject, actor = Connector DID. Gateways/brokers,
//     presenter ≠ issuer, independent actors, arbitrary actor_token support,
//     and actor-less authentication of relay subjects are all deferred to a
//     later profile version.
//   - Subject-assertion freshness constrains only message-send scopes. A
//     task-scope-only re-exchange uses a TASK-CONTINUATION assertion as
//     `subject_token` (#618 v0.1 amendment 2 — the bare self-assertion is
//     REMOVED): `sub` = the originating platform subject captured at the
//     task's origin message, plus a `mentionable_task_id` binding. The STS
//     restricts operations to that task and checks the principal against
//     the task's bound principal, making per-user task isolation
//     STS-enforceable. Continuation assertions cover task scopes ONLY —
//     they can never send new messages as the subject. Renewal is
//     re-exchange with a freshly minted continuation — no refresh tokens.
//   - Canonical resource = the agent's advertised A2A endpoint URL (RFC 8707);
//     `acct:` / DID forms are aliases resolved via the Agent Card.
//   - Bearer tokens only in this milestone; DPoP is reserved.

// ---------------------------------------------------------------------------
// Extension URI (Agent Card capability gate)
// ---------------------------------------------------------------------------

/**
 * Agent Card extension URI advertising that the agent's A2A endpoint is
 * protected by (and reachable through) this OAuth federation profile.
 * Declared in `a2a.capabilities.extensions[]` with params
 * `{ authorization_server, resource }` — see
 * {@link OAUTH_FEDERATION_PARAM_AUTHORIZATION_SERVER} /
 * {@link OAUTH_FEDERATION_PARAM_RESOURCE}.
 */
export const OAUTH_FEDERATION_EXTENSION_URI = 'https://mentionable.dev/ns/oauth-federation/v0.1'

/**
 * Exact-match recognition set for the capability gate — same pattern as the
 * PlatformIdentityCredential v0.2 gate (`https://mentionable.dev/ns/identity/v0.2`).
 * A future v0.2 of this profile appends here; nothing else ever matches.
 */
export const KNOWN_OAUTH_FEDERATION_EXTENSION_URIS: ReadonlySet<string> = new Set([
  OAUTH_FEDERATION_EXTENSION_URI,
])

/**
 * Extension `params` key carrying the RFC 8414 authorization-server metadata
 * URL (the document itself lists the token endpoint, supported grant types,
 * subject token types, client auth methods, and scopes).
 */
export const OAUTH_FEDERATION_PARAM_AUTHORIZATION_SERVER = 'authorization_server'

/**
 * Extension `params` key carrying the canonical resource identifier — the
 * exact string a client sends as the RFC 8707 `resource` parameter. Per #618
 * decision 6 this is the agent's advertised A2A endpoint URL.
 */
export const OAUTH_FEDERATION_PARAM_RESOURCE = 'resource'

// ---------------------------------------------------------------------------
// RFC 8693 / RFC 7523 protocol identifiers
// ---------------------------------------------------------------------------

/** RFC 8693 §2.1 — the token-exchange grant type. */
export const OAUTH_GRANT_TYPE_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange'

/** RFC 8693 §3 — the only accepted `subject_token_type` in v0.1. */
export const OAUTH_TOKEN_TYPE_JWT = 'urn:ietf:params:oauth:token-type:jwt'

/** RFC 8693 §3 — the `requested_token_type` a Connector asks for. */
export const OAUTH_TOKEN_TYPE_ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token'

/** RFC 7523 §2.2 — `client_assertion_type` for `private_key_jwt` client auth. */
export const OAUTH_CLIENT_ASSERTION_TYPE_JWT_BEARER =
  'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

/** RFC 8414 metadata value for RFC 7523 JWT client authentication. */
export const OAUTH_TOKEN_ENDPOINT_AUTH_METHOD_PRIVATE_KEY_JWT = 'private_key_jwt'

// ---------------------------------------------------------------------------
// JWT typing (RFC 8725 §3.11 explicit typing)
// ---------------------------------------------------------------------------

/** JWS `alg` for every assertion in this profile — EdDSA over Ed25519. */
export const OAUTH_FEDERATION_JWT_ALG = 'EdDSA'

/**
 * `typ` header of a platform-subject assertion: the Connector asserting a
 * platform principal (`sub` = canonical platform subject URI) for an exchange
 * that includes message-send scopes.
 */
export const OAUTH_FEDERATION_TYP_SUBJECT_ASSERTION = 'mentionable-subject-assertion+jwt'

/**
 * `typ` header of a task-continuation assertion (#618 v0.1 amendment 2 —
 * supersedes the removed bare self-assertion): the Connector continuing
 * already-authorized work on one task. `sub` = the ORIGINATING platform
 * subject (same canonical URI form as the subject assertion), and the
 * {@link OAUTH_FEDERATION_CLAIM_TASK_ID} claim names the bound task.
 * Accepted as `subject_token` for exchanges requesting ONLY task-operation
 * scopes; re-minted by the Connector at each renewal (short TTL + fresh
 * single-use `jti` each time) — its justification is the task's origin
 * event plus the Connector's persisted poller binding, not subject
 * freshness, so re-minting does not weaken decision 8.
 */
export const OAUTH_FEDERATION_TYP_TASK_CONTINUATION_ASSERTION =
  'mentionable-task-continuation-assertion+jwt'

/**
 * `typ` header of the RFC 7523 `private_key_jwt` client assertion. This
 * profile assigns it a DISTINCT explicit type rather than the bare `JWT`
 * RFC 7523 examples use: per RFC 8725 §3.11, explicit typing domain-separates
 * the assertion slots so a token minted for one slot (subject / continuation /
 * client) can never be replayed into another even if its claims otherwise
 * line up.
 * The verifier requires this exact `typ` for the `client_assertion` slot.
 *
 * Interop tradeoff: a generic RFC 7523 authorization server expecting bare
 * `JWT` for `private_key_jwt` will reject this `typ`. That is acceptable in
 * v0.1 — the STS is the Mentionable-profile verifier, which requires it — and
 * is called out here so a future profile version can revisit it if
 * off-the-shelf STS interop becomes a goal.
 */
export const OAUTH_FEDERATION_TYP_CLIENT_ASSERTION = 'mentionable-client-assertion+jwt'

// ---------------------------------------------------------------------------
// Claim names
// ---------------------------------------------------------------------------

/**
 * Profile-specific claim on a platform-subject assertion carrying the
 * auth-method URN (e.g. `urn:mentionable:auth:slack-workspace-member:v0.1`) —
 * the same vocabulary as PlatformIdentityCredential v0.2
 * `credentialSubject.method`.
 */
export const OAUTH_FEDERATION_CLAIM_METHOD = 'mentionable_method'

const isIpv4Address = (value: string): boolean => {
  const pieces = value.split('.')
  return (
    pieces.length === 4 &&
    pieces.every(
      (piece) =>
        /^(?:0|[1-9][0-9]{0,2})$/.test(piece) && Number(piece) >= 0 && Number(piece) <= 255,
    )
  )
}

const isIpv6Address = (value: string): boolean => {
  let address = value
  const lastColon = address.lastIndexOf(':')
  const ipv4Tail = address.slice(lastColon + 1)
  if (ipv4Tail.includes('.')) {
    if (!isIpv4Address(ipv4Tail) || lastColon < 0) return false
    address = `${address.slice(0, lastColon)}:0:0`
  }
  if (!/^[0-9A-Fa-f:]+$/.test(address)) return false
  const compression = address.indexOf('::')
  if (compression !== -1 && address.indexOf('::', compression + 2) !== -1) return false
  const groups = address.split(':').filter((piece) => piece.length > 0)
  if (groups.some((piece) => piece.length > 4)) return false
  const groupCount = groups.length
  return compression === -1 ? groupCount === 8 : groupCount < 8
}

const isValidAuthorityPort = (value: string): boolean =>
  /^[0-9]+$/.test(value) && Number(value) <= 65_535

const hasValidAuthoritySyntax = (remainder: string): boolean => {
  if (!remainder.startsWith('//')) {
    return !remainder.includes('[') && !remainder.includes(']')
  }
  const authorityEndOffset = remainder.slice(2).search(/[/?#]/)
  const authorityEnd = authorityEndOffset === -1 ? remainder.length : authorityEndOffset + 2
  const authority = remainder.slice(2, authorityEnd)
  if (/[[\]]/.test(remainder.slice(authorityEnd))) return false

  const firstAt = authority.indexOf('@')
  if (firstAt !== authority.lastIndexOf('@')) return false
  if (firstAt !== -1) {
    const userInfo = authority.slice(0, firstAt)
    if (!/^(?:[A-Za-z0-9._~!$&'()*+,;=:]|%[0-9A-Fa-f]{2})*$/.test(userInfo)) return false
  }
  const hostAndPort = authority.slice(firstAt + 1)
  if (!hostAndPort.includes('[') && !hostAndPort.includes(']')) {
    const firstColon = hostAndPort.indexOf(':')
    if (firstColon !== hostAndPort.lastIndexOf(':')) return false
    const host = firstColon === -1 ? hostAndPort : hostAndPort.slice(0, firstColon)
    const port = firstColon === -1 ? undefined : hostAndPort.slice(firstColon + 1)
    if (!/^(?:[A-Za-z0-9._~!$&'()*+,;=-]|%[0-9A-Fa-f]{2})+$/.test(host)) return false
    return port === undefined || isValidAuthorityPort(port)
  }

  const closingBracket = hostAndPort.indexOf(']')
  if (
    !hostAndPort.startsWith('[') ||
    closingBracket <= 1 ||
    hostAndPort.indexOf('[', 1) !== -1 ||
    hostAndPort.indexOf(']', closingBracket + 1) !== -1
  ) {
    return false
  }
  const port = hostAndPort.slice(closingBracket + 1)
  if (port.length > 0 && (!port.startsWith(':') || !isValidAuthorityPort(port.slice(1)))) {
    return false
  }

  const literal = hostAndPort.slice(1, closingBracket)
  return isIpv6Address(literal)
}

/**
 * True when `value` is in the conservative absolute-URI lexical subset used
 * by this profile. It accepts RFC 3986 ASCII URI characters and valid `%HH`
 * escapes without WHATWG normalization, permits at most one fragment
 * delimiter, and permits brackets only around an IPv6 host in an authority.
 * Raw authority userinfo/host/port syntax is checked before parsing. A
 * non-empty scheme-specific part is required. URL parsing is used only as a
 * final structure check after the raw lexical checks have passed.
 */
export function isOAuthFederationAbsoluteUri(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/.exec(value)
  if (schemeMatch === null) return false
  const remainder = schemeMatch[2]!
  const schemeSpecificPart = remainder.split(/[?#]/, 1)[0]!
  if (schemeSpecificPart.length === 0) return false
  if ((remainder.match(/#/g)?.length ?? 0) > 1) return false
  if (!/^(?:[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=-]|%[0-9A-Fa-f]{2})+$/.test(remainder)) {
    return false
  }
  if (!hasValidAuthoritySyntax(remainder)) return false
  try {
    const parsed = new URL(value)
    return !remainder.startsWith('//') || parsed.host.length > 0
  } catch {
    return false
  }
}

/** Profile-specific alias documenting where the shared URI syntax is used. */
export function isOAuthFederationMethodUri(value: unknown): value is string {
  return isOAuthFederationAbsoluteUri(value)
}

/**
 * Profile-specific claim on a task-continuation assertion naming the bound
 * task id (non-empty string). The STS MUST restrict operations under a
 * continuation exchange to this task and MUST verify the derived principal
 * equals the task's bound principal (#618 v0.1 amendment 2).
 */
export const OAUTH_FEDERATION_CLAIM_TASK_ID = 'mentionable_task_id'

/**
 * Registered claims every assertion in this profile MUST carry. `iss` is the
 * issuer DID; `sub` is the canonical platform subject URI
 * (subject/continuation assertions) or the issuer DID itself (client
 * assertion); `aud` is the token endpoint URL; `jti` is the replay
 * identifier.
 */
export const OAUTH_FEDERATION_REQUIRED_CLAIMS = ['iss', 'sub', 'aud', 'iat', 'exp', 'jti'] as const

// ---------------------------------------------------------------------------
// Assertion TTL / clock-skew profile (mirrors PlatformIdentityCredential v0.2 §9.2)
// ---------------------------------------------------------------------------

/** Default assertion lifetime (`exp - iat`), seconds. */
export const OAUTH_FEDERATION_ASSERTION_DEFAULT_TTL_SECONDS = 300

/** Maximum accepted assertion lifetime, seconds. Longer windows are rejected. */
export const OAUTH_FEDERATION_ASSERTION_MAX_TTL_SECONDS = 600

/** Clock-skew allowance for `iat` / `exp` evaluation, seconds. */
export const OAUTH_FEDERATION_CLOCK_SKEW_SECONDS = 60

// ---------------------------------------------------------------------------
// Scope vocabulary
// ---------------------------------------------------------------------------

/** Send one A2A message (`message/send`). */
export const OAUTH_FEDERATION_SCOPE_MESSAGE_SEND = 'a2a:message.send'
/** Send one A2A message with streamed updates (`message/stream`). */
export const OAUTH_FEDERATION_SCOPE_MESSAGE_STREAM = 'a2a:message.stream'
/** Read task state (`tasks/get`). */
export const OAUTH_FEDERATION_SCOPE_TASK_READ = 'a2a:task.read'
/** Cancel a task (`tasks/cancel`). */
export const OAUTH_FEDERATION_SCOPE_TASK_CANCEL = 'a2a:task.cancel'
/** Resubscribe to a task's update stream (`tasks/resubscribe`). */
export const OAUTH_FEDERATION_SCOPE_TASK_RESUBSCRIBE = 'a2a:task.resubscribe'
/**
 * Configure push notifications (`tasks/pushNotificationConfig/*`). Optional
 * per deployment — support is advertised via `scopes_supported` in the AS
 * metadata (#618 decision 2).
 */
export const OAUTH_FEDERATION_SCOPE_TASK_PUSH_CONFIG = 'a2a:task.push-config'

/** The complete v0.1 scope registry, in canonical order. */
export const OAUTH_FEDERATION_SCOPES = [
  OAUTH_FEDERATION_SCOPE_MESSAGE_SEND,
  OAUTH_FEDERATION_SCOPE_MESSAGE_STREAM,
  OAUTH_FEDERATION_SCOPE_TASK_READ,
  OAUTH_FEDERATION_SCOPE_TASK_CANCEL,
  OAUTH_FEDERATION_SCOPE_TASK_RESUBSCRIBE,
  OAUTH_FEDERATION_SCOPE_TASK_PUSH_CONFIG,
] as const

export type OAuthFederationScope = (typeof OAUTH_FEDERATION_SCOPES)[number]

/**
 * Message-send scopes: an exchange requesting any of these requires a FRESH
 * platform-subject assertion as `subject_token` (#618 decision 8).
 */
export const OAUTH_FEDERATION_MESSAGE_SCOPES: ReadonlySet<string> = new Set([
  OAUTH_FEDERATION_SCOPE_MESSAGE_SEND,
  OAUTH_FEDERATION_SCOPE_MESSAGE_STREAM,
])

/**
 * Task-operation scopes: an exchange requesting ONLY these MAY use a
 * task-continuation assertion as `subject_token` (#618 v0.1 amendment 2) —
 * the assertion's task binding plus the server-side task/principal check are
 * the continuity mechanism.
 */
export const OAUTH_FEDERATION_TASK_SCOPES: ReadonlySet<string> = new Set([
  OAUTH_FEDERATION_SCOPE_TASK_READ,
  OAUTH_FEDERATION_SCOPE_TASK_CANCEL,
  OAUTH_FEDERATION_SCOPE_TASK_RESUBSCRIBE,
  OAUTH_FEDERATION_SCOPE_TASK_PUSH_CONFIG,
])

/**
 * True when `scopes` includes a message-send scope, i.e. when the exchange's
 * `subject_token` must be a fresh platform-subject assertion — a
 * task-continuation assertion covers task-operation scopes ONLY.
 */
export function scopesRequireSubjectAssertion(scopes: Iterable<string>): boolean {
  for (const scope of scopes) {
    if (OAUTH_FEDERATION_MESSAGE_SCOPES.has(scope)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// OAuth error vocabulary (RFC 6749 §5.2 + RFC 8693 §2.2.2)
// ---------------------------------------------------------------------------

/**
 * Token-endpoint error codes a conforming STS returns. All except
 * `server_error` are client faults: a Connector MUST NOT retry the same
 * request — in particular
 * never on `invalid_request` (e.g. a subject-token issuer that is not the
 * authenticated client, per the #618 v0.1 amendment) or `invalid_grant`
 * (e.g. an expired or replayed assertion); it must surface the failure and
 * mint a corrected request instead.
 */
export const TOKEN_EXCHANGE_ERROR_CODES = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  /** RFC 8693 §2.2.2 — unknown/unacceptable `resource` or `audience`. */
  'invalid_target',
  /** Profile error used for transient STS-side failures. */
  'server_error',
] as const

export type TokenExchangeErrorCode = (typeof TOKEN_EXCHANGE_ERROR_CODES)[number]

export function isTokenExchangeErrorCode(value: unknown): value is TokenExchangeErrorCode {
  return (
    typeof value === 'string' && (TOKEN_EXCHANGE_ERROR_CODES as readonly string[]).includes(value)
  )
}
