import { SiweMessage } from 'siwe';

export interface SiweToken {
  message: string;
  signature: string;
}

export const MAX_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Tolerance for clock skew between signer and server when validating `issuedAt`.
// Without this, a SIWE message with `issuedAt` set in the future could pass the
// `expirationTime - issuedAt <= MAX_TOKEN_TTL_MS` cap while still having an
// effective lifetime (relative to now) far greater than the intended 7-day max.
export const ISSUED_AT_SKEW_MS = 2 * 60 * 1000;

export function encodeSiweToken(message: string, signature: string): string {
  const json = JSON.stringify({ message, signature });
  return Buffer.from(json, 'utf-8').toString('base64url');
}

export function decodeSiweToken(token: string): SiweToken {
  try {
    let base64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (base64.length % 4)) % 4;
    base64 += '='.repeat(padLength);
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    const parsed = JSON.parse(json);
    if (typeof parsed.message !== 'string' || typeof parsed.signature !== 'string') {
      throw new Error('Invalid SIWE token structure');
    }
    return parsed as SiweToken;
  } catch {
    throw new Error('Failed to decode SIWE token');
  }
}

interface VerifyCacheEntry {
  address: string;
  expiresAt: number;
}

const verifyCache = new Map<string, VerifyCacheEntry>();
const CACHE_EVICT_INTERVAL_MS = 60_000;
const VERIFY_CACHE_MAX_ENTRIES = 10_000;
let lastEvict = Date.now();

function evictExpired() {
  const now = Date.now();
  if (now - lastEvict < CACHE_EVICT_INTERVAL_MS && verifyCache.size <= VERIFY_CACHE_MAX_ENTRIES) return;
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

export async function verifySiweToken(token: string, opts?: { domain?: string }): Promise<string> {
  evictExpired();

  const cacheKey = opts?.domain ? `${token}\0${opts.domain.toLowerCase()}` : token;
  const cached = verifyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.address;
  }

  const { message, signature } = decodeSiweToken(token);
  const siweMessage = new SiweMessage(message);

  if (!siweMessage.expirationTime) {
    throw new Error('SIWE token must have an expirationTime');
  }
  if (!siweMessage.issuedAt) {
    throw new Error('SIWE token must have an issuedAt');
  }
  const issued = new Date(siweMessage.issuedAt).getTime();
  const expires = new Date(siweMessage.expirationTime).getTime();
  if (Number.isNaN(issued) || Number.isNaN(expires)) {
    throw new Error('SIWE token has invalid date format');
  }
  if (expires <= issued) {
    throw new Error('SIWE token expirationTime must be after issuedAt');
  }
  if (expires - issued > MAX_TOKEN_TTL_MS) {
    throw new Error('SIWE token TTL exceeds maximum allowed duration');
  }
  if (issued > Date.now() + ISSUED_AT_SKEW_MS) {
    throw new Error('SIWE token issuedAt is in the future');
  }

  const result = await siweMessage.verify({ signature });
  if (!result.success) {
    throw result.error ?? new Error('SIWE signature verification failed');
  }

  if (opts?.domain && siweMessage.domain.toLowerCase() !== opts.domain.toLowerCase()) {
    throw new Error(`SIWE domain mismatch: expected ${opts.domain}, got ${siweMessage.domain}`);
  }

  verifyCache.set(cacheKey, { address: siweMessage.address, expiresAt: expires });
  return siweMessage.address;
}
