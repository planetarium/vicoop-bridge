// Principal string parsing and matching for agent_policies.allowed_callers.
//
// Format:
//   eth:0x<40 hex>              SIWE-authenticated Ethereum address
//   google:sub:<sub>            Specific Google account (stable numeric id)
//   google:email:<email>        Google account by email; pinned to sub on first match
//   google:domain:<domain>      Any verified Google Workspace account from <domain>

export type Principal = string;

export type ParsedPrincipal =
  | { kind: 'eth'; address: string }
  | { kind: 'google-sub'; sub: string }
  | { kind: 'google-email'; email: string }
  | { kind: 'google-domain'; domain: string };

export interface VerifiedCaller {
  principalId: string;       // e.g. 'google:<sub>' | 'eth:0x...'
  email?: string;
  emailVerified?: boolean;
  hostedDomain?: string;
}

const ETH_ADDR_RE = /^0x[0-9a-f]{40}$/i;
const DOMAIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

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
  }
}
