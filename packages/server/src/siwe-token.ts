import { SiweMessage } from 'siwe';

export const MAX_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Tolerance for clock skew between signer and server when validating `issuedAt`.
// Without this, a SIWE message with `issuedAt` set in the future could pass the
// `expirationTime - issuedAt <= MAX_TOKEN_TTL_MS` cap while still having an
// effective lifetime (relative to now) far greater than the intended 7-day max.
const ISSUED_AT_SKEW_MS = 2 * 60 * 1000;

// Clients often compute issuedAt and expirationTime from separate time reads
// (`new Date().toISOString()` followed by `new Date(Date.now() + 7d)`), so
// `expires - issued` can land a handful of milliseconds over a nominal 7-day
// target. Allow a small slop here so honest clients aiming for exactly 7 days
// aren't rejected by sub-millisecond scheduling jitter. 1 second is far below
// the granularity of anything that would meaningfully extend the cap.
const TTL_CAP_SLOP_MS = 1000;

// Verify a SIWE (message, signature) pair and return the recovered wallet
// address. Throws on any failure (malformed fields, TTL over cap, future
// issuedAt, signature mismatch, domain mismatch).
export async function verifySiweMessage(
  message: string,
  signature: string,
  opts?: { domain?: string },
): Promise<string> {
  const siweMessage = new SiweMessage(message);

  if (!siweMessage.expirationTime) {
    throw new Error('SIWE message must have an expirationTime');
  }
  if (!siweMessage.issuedAt) {
    throw new Error('SIWE message must have an issuedAt');
  }
  const issued = new Date(siweMessage.issuedAt).getTime();
  const expires = new Date(siweMessage.expirationTime).getTime();
  if (Number.isNaN(issued) || Number.isNaN(expires)) {
    throw new Error('SIWE message has invalid date format');
  }
  if (expires <= issued) {
    throw new Error('SIWE message expirationTime must be after issuedAt');
  }
  if (expires - issued > MAX_TOKEN_TTL_MS + TTL_CAP_SLOP_MS) {
    throw new Error('SIWE message TTL exceeds maximum allowed duration');
  }
  if (issued > Date.now() + ISSUED_AT_SKEW_MS) {
    throw new Error('SIWE message issuedAt is in the future');
  }

  const result = await siweMessage.verify({ signature });
  if (!result.success) {
    throw result.error ?? new Error('SIWE signature verification failed');
  }

  if (opts?.domain && siweMessage.domain.toLowerCase() !== opts.domain.toLowerCase()) {
    throw new Error(`SIWE domain mismatch: expected ${opts.domain}, got ${siweMessage.domain}`);
  }

  return siweMessage.address;
}
