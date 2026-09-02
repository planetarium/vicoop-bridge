import type { CallerAttestationV2 } from '@vicoop-bridge/protocol';

// Principal string parsing and matching for agents.allowed_callers.
//
// Format:
//   eth:0x<40 hex>              SIWE-authenticated Ethereum address
//   google:sub:<sub>            Specific Google account (stable numeric id)
//   google:email:<email>        Google account by email; pinned to sub on first match
//   google:domain:<domain>      Any verified Google Workspace account from <domain>
//   apikey:<key-id>             Static API key (provider='apikey' callers row);
//                               the <key-id> is the public identifier, the bearer
//                               secret is the vbc_caller_* token itself
//   federated:v1:<length-prefixed issuer/method/subject tuple>
//                               Exact Mentionable OAuth federation grant. The
//                               tuple is receiver-owned policy; a verified DID
//                               signature alone never creates this entry.

export type Principal = string;

export type ParsedPrincipal =
  | { kind: 'eth'; address: string }
  | { kind: 'google-sub'; sub: string }
  | { kind: 'google-email'; email: string }
  | { kind: 'google-domain'; domain: string }
  | { kind: 'apikey'; keyId: string }
  | { kind: 'federated'; issuer: string; method: string; subject: string };

export interface FederatedPrincipalInput {
  issuer: string;
  method: string;
  subject: string;
}

export interface VerifiedCaller {
  principalId: string;       // e.g. 'google:<sub>' | 'eth:0x...'
  // Present only for federated delegation, where the platform subject is the
  // effective principal and the independently authenticated Connector DID is
  // retained as actor.
  actorId?: string;
  tokenExchange?: {
    tokenId: string;
    profileId: string;
    agentId: string;
    resource: string;
    actorId: string;
    scopes: string[];
    allowedCaller: string;
    taskId?: string;
    attestations?: CallerAttestationV2[];
  };
  email?: string;
  emailVerified?: boolean;
  hostedDomain?: string;
}

const ETH_ADDR_RE = /^0x[0-9a-f]{40}$/i;
const DOMAIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
// API key ids are minted from randomBytes(...).toString('base64url'), so the
// alphabet is url-safe base64. Case-sensitive — a key id is an opaque token,
// not a human-typed identifier.
const API_KEY_ID_RE = /^[A-Za-z0-9_-]+$/;
const FEDERATED_PREFIX = 'federated:v1:';
const MAX_FEDERATED_PRINCIPAL_BYTES = 512;

function takeLengthPrefixed(input: string): { value: string; rest: string } | null {
  const colon = input.indexOf(':');
  if (colon <= 0) return null;
  const rawLength = input.slice(0, colon);
  if (!/^(?:0|[1-9][0-9]*)$/.test(rawLength)) return null;
  const byteLength = Number(rawLength);
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) return null;

  const body = input.slice(colon + 1);
  let consumedBytes = 0;
  let end = 0;
  for (const ch of body) {
    consumedBytes += Buffer.byteLength(ch);
    if (consumedBytes > byteLength) return null;
    end += ch.length;
    if (consumedBytes === byteLength) break;
  }
  if (consumedBytes !== byteLength) return null;
  return { value: body.slice(0, end), rest: body.slice(end) };
}

/**
 * Collision-safe, reversible encoding for an exact federated caller tuple.
 * Lengths are UTF-8 byte lengths, so delimiters inside DIDs, URNs, and
 * platform subjects remain ordinary data rather than parser syntax.
 */
export function formatFederatedPrincipal(input: FederatedPrincipalInput): string | null {
  const issuer = input.issuer.trim();
  const method = input.method.trim();
  const subject = input.subject.trim();
  if (issuer !== input.issuer || method !== input.method || subject !== input.subject) return null;
  if (!issuer.startsWith('did:web:') || !method || !subject) return null;
  if (/\s/.test(issuer)) return null;
  if (issuer.length > 512 || method.length > 256 || subject.length > 512) return null;
  const component = (value: string): string => `${Buffer.byteLength(value)}:${value}`;
  const encoded = FEDERATED_PREFIX + component(issuer) + component(method) + component(subject);
  return Buffer.byteLength(encoded) <= MAX_FEDERATED_PRINCIPAL_BYTES ? encoded : null;
}

export function parseFederatedPrincipal(value: string): FederatedPrincipalInput | null {
  if (!value.startsWith(FEDERATED_PREFIX)) return null;
  let rest = value.slice(FEDERATED_PREFIX.length);
  const issuer = takeLengthPrefixed(rest);
  if (!issuer) return null;
  rest = issuer.rest;
  const method = takeLengthPrefixed(rest);
  if (!method) return null;
  rest = method.rest;
  const subject = takeLengthPrefixed(rest);
  if (!subject || subject.rest !== '') return null;
  const canonical = formatFederatedPrincipal({
    issuer: issuer.value,
    method: method.value,
    subject: subject.value,
  });
  return canonical === value
    ? { issuer: issuer.value, method: method.value, subject: subject.value }
    : null;
}

// Parse a stored principal string. Returns null for invalid input.
export function parsePrincipal(s: string): ParsedPrincipal | null {
  if (typeof s !== 'string' || s.length === 0) return null;

  if (s.startsWith('eth:')) {
    const addr = s.slice(4);
    if (!ETH_ADDR_RE.test(addr)) return null;
    return { kind: 'eth', address: addr.toLowerCase() };
  }

  if (s.startsWith('google:sub:')) {
    const sub = s.slice('google:sub:'.length);
    if (sub.length === 0) return null;
    return { kind: 'google-sub', sub };
  }

  if (s.startsWith('google:email:')) {
    const email = s.slice('google:email:'.length);
    if (email.length === 0) return null;
    const atIdx = email.indexOf('@');
    if (atIdx === -1) return null;
    // Exactly one '@'
    if (email.indexOf('@', atIdx + 1) !== -1) return null;
    const local = email.slice(0, atIdx);
    const domain = email.slice(atIdx + 1);
    if (local.length === 0 || domain.length === 0) return null;
    return { kind: 'google-email', email: email.toLowerCase() };
  }

  if (s.startsWith('google:domain:')) {
    const domain = s.slice('google:domain:'.length);
    if (domain.length === 0) return null;
    const lower = domain.toLowerCase();
    if (!DOMAIN_RE.test(lower)) return null;
    return { kind: 'google-domain', domain: lower };
  }

  if (s.startsWith('apikey:')) {
    const keyId = s.slice('apikey:'.length);
    if (!API_KEY_ID_RE.test(keyId)) return null;
    return { kind: 'apikey', keyId };
  }

  const federated = parseFederatedPrincipal(s);
  if (federated) return { kind: 'federated', ...federated };

  return null;
}

// Validate user-supplied principal string (from admin tool input). Normalizes
// case where appropriate. Plain '0x<40 hex>' is auto-prefixed with 'eth:'.
// Returns null if invalid.
export function validatePrincipal(raw: string): Principal | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Plain Ethereum address => auto-prefix
  if (ETH_ADDR_RE.test(trimmed)) {
    return 'eth:' + trimmed.toLowerCase();
  }

  const parsed = parsePrincipal(trimmed);
  if (!parsed) return null;

  switch (parsed.kind) {
    case 'eth':
      return 'eth:' + parsed.address;
    case 'google-sub':
      return 'google:sub:' + parsed.sub;
    case 'google-email':
      return 'google:email:' + parsed.email;
    case 'google-domain':
      return 'google:domain:' + parsed.domain;
    case 'apikey':
      return 'apikey:' + parsed.keyId;
    case 'federated':
      return formatFederatedPrincipal(parsed);
  }
}

// Returns true if the verified caller satisfies the given allowed_callers entry.
// google:domain:* requires emailVerified=true.
export function matchPrincipal(entry: Principal, caller: VerifiedCaller): boolean {
  const parsed = parsePrincipal(entry);
  if (!parsed) return false;

  switch (parsed.kind) {
    case 'eth': {
      if (!caller.principalId.startsWith('eth:')) return false;
      const callerAddr = caller.principalId.slice(4).toLowerCase();
      return callerAddr === parsed.address;
    }
    case 'google-sub': {
      return caller.principalId === 'google:' + parsed.sub;
    }
    case 'google-email': {
      if (caller.emailVerified !== true) return false;
      if (!caller.email) return false;
      return caller.email.toLowerCase() === parsed.email;
    }
    case 'google-domain': {
      if (caller.emailVerified !== true) return false;
      const target = parsed.domain;
      if (caller.hostedDomain && caller.hostedDomain.toLowerCase() === target) {
        return true;
      }
      if (caller.email) {
        const suffix = '@' + target;
        if (caller.email.toLowerCase().endsWith(suffix)) {
          return true;
        }
      }
      return false;
    }
    case 'apikey': {
      // The verified caller's principal is set at issue time to
      // 'apikey:<key-id>'; matching is exact identity on the key id. No
      // email/domain semantics — possession of the bearer token is the proof.
      return caller.principalId === 'apikey:' + parsed.keyId;
    }
    case 'federated': {
      return caller.tokenExchange?.allowedCaller === entry;
    }
  }
}
