// Self-verifiable SIWE bearer tokens per
// https://github.com/planetarium/a2a-x402-wallet/tree/main/docs/siwe-bearer-auth/v0.1
//
// A SIWE bearer is base64url(JSON.stringify({ message, signature })) where
// `message` is an EIP-4361 SIWE message string. Unlike the opaque
// `vbc_caller_*` tokens issued by /auth/siwe/exchange (issue #31), these are
// stateless: every request re-runs signature recovery + TTL + domain checks.
// To avoid re-verifying the same bearer on every request from the same
// caller, we keep an in-process cache keyed by the bearer's SHA-256 digest
// (see `tokenCacheKey` below).

import { createHash } from 'node:crypto';
import { SiweMessage } from 'siwe';
import { verifySiweMessage } from '../siwe-token.js';

export interface DecodedSiweBearer {
  message: string;
  signature: string;
}

export function decodeSiweBearerToken(token: string): DecodedSiweBearer {
  let base64 = token.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (base64.length % 4)) % 4;
  base64 += '='.repeat(padLength);
  let json: string;
  try {
    json = Buffer.from(base64, 'base64').toString('utf-8');
  } catch {
    throw new Error('Failed to decode SIWE bearer token');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('SIWE bearer token is not valid JSON');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { message?: unknown }).message !== 'string' ||
    typeof (parsed as { signature?: unknown }).signature !== 'string'
  ) {
    throw new Error('SIWE bearer token missing message or signature');
  }
  return parsed as DecodedSiweBearer;
}

interface CacheEntry {
  address: string;
  domain: string;
  expiresAt: number;
}

// FIFO cache (Map insertion order). We don't promote on access, so this is
// not a true LRU — it bounds memory and TTL-evicts expired entries, which
// matches dba's siwe-token.ts and is sufficient for our usage pattern (a
// caller signs once and reuses the same token for the SIWE TTL).
//
// Cache keys are SHA-256 hex digests of the bearer token, not the raw
// token itself. SIWE bearers are base64url-encoded JSON with embedded
// signatures and can run several hundred bytes each; an attacker hammering
// the route with distinct tokens could otherwise pin up to MAX_ENTRIES *
// header_size bytes in memory until TTL eviction. The 64-char digest
// keeps each key fixed-size regardless of input.
//
// We cache the verified domain alongside the address so a cache hit can
// re-check it if the caller passes a different `opts.domain`. Without this
// re-check a token whose first verification accepted any domain (or domain
// undefined) would cache-bypass a stricter domain check on subsequent
// calls. In practice opts.domain is fixed (siweDomain from http.tsx), but
// the function is exported and could be reused.
const CACHE_MAX_ENTRIES = 10_000;
const CACHE_SWEEP_INTERVAL_MS = 60_000;
const verifyCache = new Map<string, CacheEntry>();
let lastSweep = 0;

function tokenCacheKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function maybeSweep() {
  const now = Date.now();
  if (now - lastSweep < CACHE_SWEEP_INTERVAL_MS && verifyCache.size <= CACHE_MAX_ENTRIES) return;
  lastSweep = now;
  for (const [k, v] of verifyCache) {
    if (v.expiresAt <= now) verifyCache.delete(k);
  }
  while (verifyCache.size > CACHE_MAX_ENTRIES) {
    const oldest = verifyCache.keys().next().value;
    if (oldest === undefined) break;
    verifyCache.delete(oldest);
  }
}

export interface VerifySiweBearerOptions {
  domain?: string;
}

export interface VerifiedSiweBearer {
  address: string;
}

// Decode + verify a SIWE bearer token. Returns the recovered Ethereum address
// (lowercased). Throws on any failure (decode, signature, TTL, domain, expiry).
export async function verifySiweBearerToken(
  token: string,
  opts: VerifySiweBearerOptions = {},
): Promise<VerifiedSiweBearer> {
  maybeSweep();
  const cacheKey = tokenCacheKey(token);
  const cached = verifyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (opts.domain && cached.domain !== opts.domain.toLowerCase()) {
      throw new Error(
        `SIWE domain mismatch: expected ${opts.domain}, got ${cached.domain}`,
      );
    }
    return { address: cached.address };
  }
  const { message, signature } = decodeSiweBearerToken(token);
  const address = await verifySiweMessage(message, signature, { domain: opts.domain });
  // verifySiweMessage already enforces presence and validity of expirationTime,
  // so re-parsing here is just to read the value back out for the cache TTL +
  // the verified domain (so a later call with a different opts.domain doesn't
  // pass on the cached result).
  const parsed = new SiweMessage(message);
  const expiresAt = new Date(parsed.expirationTime!).getTime();
  const lower = address.toLowerCase();
  verifyCache.set(cacheKey, {
    address: lower,
    domain: parsed.domain.toLowerCase(),
    expiresAt,
  });
  return { address: lower };
}

// Test-only: clear the in-memory cache so unit tests can exercise the
// verification path repeatedly with the same token without seeing stale
// hits. Not exported via index — call via the relative import.
export function _resetSiweBearerCacheForTests(): void {
  verifyCache.clear();
  lastSweep = 0;
}
