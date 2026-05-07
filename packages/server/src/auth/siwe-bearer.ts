// Self-verifiable SIWE bearer tokens per
// https://github.com/planetarium/a2a-x402-wallet/tree/main/docs/siwe-bearer-auth/v0.1
//
// A SIWE bearer is base64url(JSON.stringify({ message, signature })) where
// `message` is an EIP-4361 SIWE message string. Unlike the opaque
// `vbc_caller_*` tokens issued by /auth/siwe/exchange (issue #31), these are
// stateless: every request re-runs signature recovery + TTL + domain checks.
// We cache by raw token string to avoid re-verifying the same bearer on
// every request from the same caller.

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
  expiresAt: number;
}

const CACHE_MAX_ENTRIES = 10_000;
const CACHE_SWEEP_INTERVAL_MS = 60_000;
const verifyCache = new Map<string, CacheEntry>();
let lastSweep = 0;

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
  const cached = verifyCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return { address: cached.address };
  }
  const { message, signature } = decodeSiweBearerToken(token);
  const address = await verifySiweMessage(message, signature, { domain: opts.domain });
  const parsed = new SiweMessage(message);
  const expiresAt = parsed.expirationTime
    ? new Date(parsed.expirationTime).getTime()
    : Date.now() + 60_000;
  verifyCache.set(token, { address: address.toLowerCase(), expiresAt });
  return { address: address.toLowerCase() };
}

// Test-only: clear the in-memory cache so unit tests can exercise the
// verification path repeatedly with the same token without seeing stale
// hits. Not exported via index — call via the relative import.
export function _resetSiweBearerCacheForTests(): void {
  verifyCache.clear();
  lastSweep = 0;
}
