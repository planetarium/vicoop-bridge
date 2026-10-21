/** Canonical environment/grant identity; lengths count UTF-8 bytes. */
export interface FederatedPrincipalInput { issuer: string; method: string; subject: string; }
const utf8Length = (value: string): number => new TextEncoder().encode(value).length;
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
    consumedBytes += utf8Length(ch);
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
  const component = (value: string): string => `${utf8Length(value)}:${value}`;
  const encoded = FEDERATED_PREFIX + component(issuer) + component(method) + component(subject);
  return utf8Length(encoded) <= MAX_FEDERATED_PRINCIPAL_BYTES ? encoded : null;
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


export function executionScopePolicy(principalId: string): 'direct-principal-v1' | 'federated-principal-v1' {
  return parseFederatedPrincipal(principalId) ? 'federated-principal-v1' : 'direct-principal-v1';
}
/** Shared hash preimage; callers compute SHA-256 without pulling node:crypto into browser bundles. */
export function executionScopePreimage(agentId: string, principalId: string): string {
  return JSON.stringify(['vicoop-execution-scope', executionScopePolicy(principalId), agentId, principalId]);
}
