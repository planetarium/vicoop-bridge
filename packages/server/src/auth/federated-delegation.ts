import { formatFederatedPrincipal, parseFederatedPrincipal } from '@vicoop-bridge/protocol';

/** Policy records, not caller principals. Only the structured owner API writes these. */
export const FEDERATED_DELEGATION_PREFIX = 'federated-delegation:v1:';
/** Once delegated, an empty allow list must never reopen the resource to the public. */
export const FEDERATION_RESTRICTED = 'federation-restricted:v1';
export interface FederatedDelegation { id: string; issuer: string; method: string; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function formatFederatedDelegation(input: FederatedDelegation): string | null {
  if (!UUID.test(input.id)) return null;
  const tuple = formatFederatedPrincipal({ issuer: input.issuer, method: input.method, subject: input.id });
  return tuple ? FEDERATED_DELEGATION_PREFIX + tuple : null;
}
export function parseFederatedDelegation(value: string): FederatedDelegation | null {
  if (!value.startsWith(FEDERATED_DELEGATION_PREFIX)) return null;
  const tuple = parseFederatedPrincipal(value.slice(FEDERATED_DELEGATION_PREFIX.length));
  if (!tuple || !UUID.test(tuple.subject)) return null;
  const result = { id: tuple.subject, issuer: tuple.issuer, method: tuple.method };
  return formatFederatedDelegation(result) === value ? result : null;
}

/** Exact grants win. A task continues only with its original persisted key. */
export function selectFederatedAuthorization(callers: string[], input: { issuer: string; method: string; subject: string }): string | undefined {
  const exact = formatFederatedPrincipal(input);
  if (!exact) return undefined;
  if (callers.includes(exact)) return exact;
  const matches = callers.filter((key) => {
    const policy = parseFederatedDelegation(key);
    return policy?.issuer === input.issuer && policy.method === input.method;
  });
  return matches.length === 1 ? matches[0] : undefined;
}
