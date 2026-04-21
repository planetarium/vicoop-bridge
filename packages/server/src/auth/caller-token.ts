import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from '../db.js';
import type { VerifiedCaller } from './principal.js';

// Bridge-issued opaque token for A2A caller auth.
// Wire format: 'vbc_caller_' + 43-char base64url (32 bytes of entropy).

export const CALLER_TOKEN_PREFIX = 'vbc_caller_';

// Provider label persisted on the `callers` row. Expands as new issuance
// methods are added (e.g. passkey, ssh-agent). Not enforced by schema.
export type CallerProvider = 'google' | 'siwe';

export interface IssueCallerTokenInput {
  principalId: string;        // 'google:<sub>' | 'eth:0x<addr>'
  provider: CallerProvider;
  email?: string;
  label?: string;
  ttlMs?: number;             // default 90 days
}

export interface IssuedCallerToken {
  rawToken: string;           // shown once to the user
  callerId: string;
  expiresAt: Date;
}

const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// In-memory verification cache. Mirrors pattern in siwe-token.ts.
// Keyed by raw token. Values hold the VerifiedCaller plus an `expiresAt`
// (ms epoch) bounded to `now + CACHE_MAX_ENTRY_TTL_MS` so revocations
// take effect within ~60s without us having to do explicit invalidation.
interface VerifyCacheEntry {
  caller: VerifiedCaller;
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

// Generate a new unguessable opaque token string. Does not touch DB.
export function generateCallerToken(): string {
  return CALLER_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

// sha256 hex of the raw token, for DB lookup.
export function hashCallerToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// Issue a new token and persist to `callers`. Returns raw token (one-time).
export async function issueCallerToken(
  sql: Sql,
  input: IssueCallerTokenInput,
): Promise<IssuedCallerToken> {
  const rawToken = generateCallerToken();
  const tokenHash = hashCallerToken(rawToken);
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);

  const rows = await sql<{ id: string; expires_at: Date }[]>`
    INSERT INTO callers (token_hash, principal_id, provider, email, label, expires_at)
    VALUES (
      ${tokenHash},
      ${input.principalId},
      ${input.provider},
      ${input.email ?? null},
      ${input.label ?? null},
      ${expiresAt}
    )
    RETURNING id, expires_at
  `;

  const row = rows[0];
  if (!row) {
    throw new Error('Failed to insert caller token');
  }

  return {
    rawToken,
    callerId: row.id,
    expiresAt: row.expires_at,
  };
}

// Verify a raw token. Checks revoked + expires_at. Updates last_used_at.
// Throws on any failure. Returns VerifiedCaller with principal and metadata.
export async function verifyCallerToken(
  sql: Sql,
  rawToken: string,
): Promise<VerifiedCaller> {
  if (!rawToken.startsWith(CALLER_TOKEN_PREFIX)) {
    throw new Error('Invalid caller token format');
  }

  evictExpired();

  const now = Date.now();
  const cached = verifyCache.get(rawToken);
  if (cached && cached.expiresAt > now) {
    // Deliberately do not touch last_used_at on cache hits to avoid
    // write amplification.
    return cached.caller;
  }

  const tokenHash = hashCallerToken(rawToken);
  const rows = await sql<
    {
      id: string;
      principal_id: string;
      email: string | null;
      expires_at: Date;
      revoked: boolean;
    }[]
  >`
    SELECT id, principal_id, email, expires_at, revoked
    FROM callers
    WHERE token_hash = ${tokenHash}
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) {
    throw new Error('Caller token not found');
  }
  if (row.revoked) {
    throw new Error('Caller token revoked');
  }
  if (row.expires_at.getTime() <= now) {
    throw new Error('Caller token expired');
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
  verifyCache.set(rawToken, { caller, expiresAt: cacheExpiresAt });

  return caller;
}

// Mark a caller token as revoked. Idempotent.
// NOTE: We intentionally do not invalidate the in-memory LRU here. Cache
// entries are bounded to `now + 60s` at insert time, so revocations take
// effect within ~60s without requiring us to track id → token mappings.
export async function revokeCallerToken(sql: Sql, callerId: string): Promise<void> {
  await sql`UPDATE callers SET revoked = true WHERE id = ${callerId}`;
}

export interface CallerTokenRow {
  id: string;
  principalId: string;
  provider: string;
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
  filter: { principalId?: string; email?: string; includeRevoked?: boolean },
): Promise<CallerTokenRow[]> {
  const conditions: ReturnType<Sql>[] = [];
  if (filter.principalId) {
    conditions.push(sql`principal_id = ${filter.principalId}`);
  }
  if (filter.email) {
    conditions.push(sql`email = ${filter.email}`);
  }
  if (!filter.includeRevoked) {
    conditions.push(sql`revoked = false`);
  }

  const where =
    conditions.length > 0
      ? sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`
      : sql``;

  const rows = await sql<RawCallerRow[]>`
    SELECT id, principal_id, provider, email, label, expires_at, last_used_at, revoked, created_at
    FROM callers
    ${where}
    ORDER BY created_at DESC
  `;

  return rows.map((r) => ({
    id: r.id,
    principalId: r.principal_id,
    provider: r.provider,
    email: r.email,
    label: r.label,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revoked: r.revoked,
    createdAt: r.created_at,
  }));
}
