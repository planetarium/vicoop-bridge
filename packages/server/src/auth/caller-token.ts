import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from '../db.js';
import type { VerifiedCaller } from './principal.js';

// Bridge-issued opaque session tokens.
// Two distinct audiences with distinct prefixes (issue #79 PR D):
//
//   `vbc_caller_*` (audience='caller')
//     Used as Bearer at /agents/:id by a third-party A2A caller invoking
//     somebody else's agent. Matched against the agent's allowed_callers.
//
//   `vbc_owner_*`  (audience='owner_session')
//     Used as Bearer at /graphql and POST / by the resource owner for
//     self-service (admin chat, client/policy CRUD). Matched against
//     owner_principal under RLS.
//
// The two are intentionally non-substitutable: the call-site guards
// (agent-auth.ts / http.tsx / postgraphile.ts) reject the wrong prefix
// up front. Verification additionally enforces audience server-side
// against the persisted row in case a token is hand-crafted past the
// prefix check.

export const CALLER_TOKEN_PREFIX = 'vbc_caller_';
export const OWNER_SESSION_PREFIX = 'vbc_owner_';

export type Audience = 'caller' | 'owner_session';

// Provider label persisted on the row. Expands as new issuance methods
// are added (e.g. passkey, ssh-agent). Not enforced by schema.
//
//   'google' | 'siwe'  — interactive login flows; principal is the resolved
//                        identity ('google:<sub>' / 'eth:0x<addr>').
//   'apikey'           — owner-minted static key for non-interactive callers
//                        (CI, backend services); principal is 'apikey:<key-id>'
//                        and the row never carries an email.
export type CallerProvider = 'google' | 'siwe' | 'apikey';

export interface IssueSessionTokenInput {
  principalId: string;        // 'google:<sub>' | 'eth:0x<addr>' | 'apikey:<key-id>'
  provider: CallerProvider;
  audience: Audience;
  email?: string;
  label?: string;
  ttlMs?: number;             // default 90 days
}

export interface IssuedSessionToken {
  rawToken: string;           // shown once to the user
  callerId: string;
  expiresAt: Date;
}

const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// In-memory verification cache. Mirrors pattern in siwe-token.ts. Keyed by
// raw token; the prefix encodes audience so a single key space is fine.
// Values hold the VerifiedCaller plus an `expiresAt` (ms epoch) bounded to
// `now + CACHE_MAX_ENTRY_TTL_MS` so revocations take effect within ~60s
// without us having to do explicit invalidation.
interface VerifyCacheEntry {
  caller: VerifiedCaller;
  audience: Audience;
  expiresAt: number;
}

const verifyCache = new Map<string, VerifyCacheEntry>();
const CACHE_EVICT_INTERVAL_MS = 60_000;
const VERIFY_CACHE_MAX_ENTRIES = 10_000;
const CACHE_MAX_ENTRY_TTL_MS = 60_000;
let lastEvict = Date.now();

function evictExpired(): void {
  const now = Date.now();
  if (now - lastEvict < CACHE_EVICT_INTERVAL_MS && verifyCache.size <= VERIFY_CACHE_MAX_ENTRIES) {
    return;
  }
  lastEvict = now;
  for (const [key, entry] of verifyCache) {
    if (entry.expiresAt <= now) verifyCache.delete(key);
  }
  while (verifyCache.size > VERIFY_CACHE_MAX_ENTRIES) {
    const oldest = verifyCache.keys().next().value;
    if (oldest === undefined) break;
    verifyCache.delete(oldest);
  }
}

function prefixFor(audience: Audience): string {
  return audience === 'caller' ? CALLER_TOKEN_PREFIX : OWNER_SESSION_PREFIX;
}

function audienceFromRaw(rawToken: string): Audience | null {
  if (rawToken.startsWith(CALLER_TOKEN_PREFIX)) return 'caller';
  if (rawToken.startsWith(OWNER_SESSION_PREFIX)) return 'owner_session';
  return null;
}

// Generate an unguessable opaque token string. Does not touch DB.
export function generateSessionToken(audience: Audience): string {
  return prefixFor(audience) + randomBytes(32).toString('base64url');
}

// Backward-compat alias used by older callers; emits a `vbc_caller_*` token.
// New code should call generateSessionToken(audience) directly.
export function generateCallerToken(): string {
  return generateSessionToken('caller');
}

// Public identifier for an API key, embedded in the 'apikey:<key-id>'
// principal. Distinct from the bearer secret (the vbc_caller_* token): the id
// is shown in `agent apikey list` and used for revocation, while the token is
// shown once at mint time. 9 random bytes → 12 url-safe base64 chars; the
// alphabet matches API_KEY_ID_RE in principal.ts.
export function generateApiKeyId(): string {
  return randomBytes(9).toString('base64url');
}

// sha256 hex of the raw token, for DB lookup.
export function hashCallerToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// Issue a new token and persist to `callers`. Returns raw token (one-time).
export async function issueSessionToken(
  sql: Sql,
  input: IssueSessionTokenInput,
): Promise<IssuedSessionToken> {
  const rawToken = generateSessionToken(input.audience);
  const tokenHash = hashCallerToken(rawToken);
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);

  const rows = await sql<{ id: string; expires_at: Date }[]>`
    INSERT INTO callers (token_hash, principal_id, provider, audience, email, label, expires_at)
    VALUES (
      ${tokenHash},
      ${input.principalId},
      ${input.provider},
      ${input.audience},
      ${input.email ?? null},
      ${input.label ?? null},
      ${expiresAt}
    )
    RETURNING id, expires_at
  `;

  const row = rows[0];
  if (!row) {
    throw new Error('Failed to insert session token');
  }

  return {
    rawToken,
    callerId: row.id,
    expiresAt: row.expires_at,
  };
}

// Backward-compat alias — fixes audience to 'caller'. New code should use
// issueSessionToken directly with an explicit audience.
export async function issueCallerToken(
  sql: Sql,
  input: Omit<IssueSessionTokenInput, 'audience'>,
): Promise<IssuedSessionToken> {
  return issueSessionToken(sql, { ...input, audience: 'caller' });
}

export interface VerifyOptions {
  // When set, throws if the verified token's audience does not match.
  // Call sites that handle a single audience kind (e.g. agent-auth.ts only
  // accepts 'caller') pass this so a stolen token cannot be repurposed
  // across the eth-only-vs-Google split or the caller-vs-owner split.
  expectedAudience?: Audience;
}

// Verify a raw token. Checks revoked + expires_at + audience. Updates
// last_used_at on cache miss. Throws on any failure. Returns
// VerifiedCaller with principal and metadata.
export async function verifySessionToken(
  sql: Sql,
  rawToken: string,
  opts: VerifyOptions = {},
): Promise<VerifiedCaller> {
  const audience = audienceFromRaw(rawToken);
  if (audience === null) {
    throw new Error('Invalid session token format');
  }
  if (opts.expectedAudience && opts.expectedAudience !== audience) {
    throw new Error(
      `Token audience mismatch: this endpoint expects ${prefixFor(opts.expectedAudience)}* but got ${prefixFor(audience)}*`,
    );
  }

  evictExpired();

  const now = Date.now();
  const cached = verifyCache.get(rawToken);
  if (cached && cached.expiresAt > now) {
    if (opts.expectedAudience && cached.audience !== opts.expectedAudience) {
      throw new Error(
        `Token audience mismatch: cached audience ${cached.audience} does not satisfy ${opts.expectedAudience}`,
      );
    }
    // Deliberately do not touch last_used_at on cache hits to avoid
    // write amplification.
    return cached.caller;
  }

  const tokenHash = hashCallerToken(rawToken);
  const rows = await sql<
    {
      id: string;
      principal_id: string;
      audience: string;
      email: string | null;
      expires_at: Date;
      revoked: boolean;
    }[]
  >`
    SELECT id, principal_id, audience, email, expires_at, revoked
    FROM callers
    WHERE token_hash = ${tokenHash}
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) {
    throw new Error('Session token not found');
  }
  if (row.revoked) {
    throw new Error('Session token revoked');
  }
  if (row.expires_at.getTime() <= now) {
    throw new Error('Session token expired');
  }
  // Defense-in-depth: row's persisted audience must match the prefix we
  // saw on the wire. A mismatch indicates either DB corruption or someone
  // who changed the prefix on the wire to bypass call-site guards.
  if (row.audience !== audience) {
    throw new Error('Session token audience corruption');
  }
  if (opts.expectedAudience && opts.expectedAudience !== audience) {
    throw new Error(
      `Token audience mismatch: this endpoint expects ${prefixFor(opts.expectedAudience)}* but got ${prefixFor(audience)}*`,
    );
  }

  // Stamp last_used_at. Awaited for test determinism; the write is cheap
  // and only happens on cache misses (so at most once per 60s per token).
  await sql`UPDATE callers SET last_used_at = now() WHERE id = ${row.id}`;

  // email_verified inference: we only persist email at issue time when the
  // upstream provider (google-oauth) has already validated it, so a non-null
  // email here is known-verified.
  const caller: VerifiedCaller = {
    principalId: row.principal_id,
    email: row.email ?? undefined,
    emailVerified: row.email ? true : undefined,
  };

  const cacheExpiresAt = Math.min(row.expires_at.getTime(), now + CACHE_MAX_ENTRY_TTL_MS);
  verifyCache.set(rawToken, { caller, audience, expiresAt: cacheExpiresAt });

  return caller;
}

// Backward-compat alias for verifySessionToken({ expectedAudience: 'caller' }).
// Call sites that haven't been migrated to audience-aware verification still
// reach this; the explicit audience check is enforced.
export async function verifyCallerToken(
  sql: Sql,
  rawToken: string,
): Promise<VerifiedCaller> {
  return verifySessionToken(sql, rawToken, { expectedAudience: 'caller' });
}

// Mark a session token as revoked. Idempotent.
// NOTE: We intentionally do not invalidate the in-memory LRU here. Cache
// entries are bounded to `now + 60s` at insert time, so revocations take
// effect within ~60s without requiring us to track id → token mappings.
export async function revokeCallerToken(sql: Sql, callerId: string): Promise<void> {
  await sql`UPDATE callers SET revoked = true WHERE id = ${callerId}`;
}

// Revoke by raw token. Looks up the row by token_hash and flips revoked=true.
// Idempotent — silently no-ops for unknown / already-revoked tokens (RFC 7009
// §2.2: "an invalid token type hint value is ignored ... [the AS] responds
// with HTTP status code 200 if the token has been revoked successfully or if
// the client submitted an invalid token"). Returns true only when we actually
// flipped a row, so callers (admin tooling) can log a useful audit signal;
// the /oauth/revoke endpoint discards the boolean to honor RFC 7009's
// no-information-leak guarantee.
export async function revokeSessionTokenByRaw(
  sql: Sql,
  rawToken: string,
): Promise<boolean> {
  if (audienceFromRaw(rawToken) === null) return false;
  const tokenHash = hashCallerToken(rawToken);
  const rows = await sql<{ id: string }[]>`
    UPDATE callers SET revoked = true
    WHERE token_hash = ${tokenHash} AND revoked = false
    RETURNING id
  `;
  return rows.length > 0;
}

export interface CallerTokenRow {
  id: string;
  principalId: string;
  provider: string;
  audience: Audience;
  email: string | null;
  label: string | null;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revoked: boolean;
  createdAt: Date;
}

interface RawCallerRow {
  id: string;
  principal_id: string;
  provider: string;
  audience: string;
  email: string | null;
  label: string | null;
  expires_at: Date;
  last_used_at: Date | null;
  revoked: boolean;
  created_at: Date;
}

// List tokens with optional filters. Used by admin tools.
export async function listCallerTokens(
  sql: Sql,
  filter: { principalId?: string; email?: string; audience?: Audience; includeRevoked?: boolean },
): Promise<CallerTokenRow[]> {
  const conditions: ReturnType<Sql>[] = [];
  if (filter.principalId) {
    conditions.push(sql`principal_id = ${filter.principalId}`);
  }
  if (filter.email) {
    conditions.push(sql`email = ${filter.email}`);
  }
  if (filter.audience) {
    conditions.push(sql`audience = ${filter.audience}`);
  }
  if (!filter.includeRevoked) {
    conditions.push(sql`revoked = false`);
  }

  const where =
    conditions.length > 0
      ? sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`
      : sql``;

  const rows = await sql<RawCallerRow[]>`
    SELECT id, principal_id, provider, audience, email, label, expires_at, last_used_at, revoked, created_at
    FROM callers
    ${where}
    ORDER BY created_at DESC
  `;

  return rows.map((r) => ({
    id: r.id,
    principalId: r.principal_id,
    provider: r.provider,
    audience: r.audience as Audience,
    email: r.email,
    label: r.label,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revoked: r.revoked,
    createdAt: r.created_at,
  }));
}
