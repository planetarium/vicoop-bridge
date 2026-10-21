import { createHash } from 'node:crypto';
import { ExecutionScopeV1, supportsExecutionScopeV1, FEDERATED_EXECUTION_SCOPE_V1_CAPABILITY, parseFederatedPrincipal, executionScopePolicy, executionScopePreimage } from '@vicoop-bridge/protocol';

/** Input is the executor's authenticated HTTP handoff, NOT public metadata. */
export function resolveExecutionScope(input: {
  agentId: string;
  principalId?: string;
  actorId?: string;
  authorizationKey?: string;
  authorizationProfile?: string;
  capabilities?: readonly string[];
}): ExecutionScopeV1 | undefined {
  if (!supportsExecutionScopeV1(input.capabilities)) return undefined;
  if (!input.principalId) return undefined;
  let principalId = input.principalId;
  if (input.actorId !== undefined || input.authorizationKey !== undefined || input.authorizationProfile !== undefined) {
    // Only the authenticated OAuth handoff can select a federated environment.
    // Presented attestations and arbitrary delegation never participate.
    if (!input.capabilities?.includes(FEDERATED_EXECUTION_SCOPE_V1_CAPABILITY) ||
        input.authorizationProfile !== 'https://mentionable.dev/ns/oauth-federation/v0.1' ||
        !input.authorizationKey) return undefined;
    const tuple = parseFederatedPrincipal(input.authorizationKey);
    if (!tuple || tuple.issuer !== input.actorId || tuple.subject !== input.principalId) return undefined;
    principalId = input.authorizationKey;
  } else if (parseFederatedPrincipal(principalId)) {
    // A direct identity may not impersonate a federated environment key.
    return undefined;
  }
  const policy = executionScopePolicy(principalId);
  const id = createHash('sha256').update(executionScopePreimage(input.agentId, principalId)).digest('hex');
  const parsed = ExecutionScopeV1.safeParse({
    policy, id, agentId: input.agentId, principalId,
  });
  return parsed.success ? parsed.data : undefined;
}
