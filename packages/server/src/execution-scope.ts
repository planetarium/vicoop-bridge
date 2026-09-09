import { createHash } from 'node:crypto';
import { ExecutionScopeV1, supportsExecutionScopeV1 } from '@vicoop-bridge/protocol';

/** Input is the executor's authenticated HTTP handoff, NOT public metadata. */
export function resolveDirectExecutionScope(input: {
  agentId: string;
  principalId?: string;
  actorId?: string;
  authorizationKey?: string;
  authorizationProfile?: string;
  capabilities?: readonly string[];
}): ExecutionScopeV1 | undefined {
  if (!supportsExecutionScopeV1(input.capabilities)) return undefined;
  // Token exchange/grant boundaries need a separate policy, even when actor
  // and principal happen to match. Attestations never enter this function.
  if (!input.principalId || input.actorId !== undefined ||
      input.authorizationKey !== undefined || input.authorizationProfile !== undefined) return undefined;
  const policy = 'direct-principal-v1' as const;
  const id = createHash('sha256')
    .update(JSON.stringify(['vicoop-execution-scope', policy, input.agentId, input.principalId]))
    .digest('hex');
  const parsed = ExecutionScopeV1.safeParse({
    policy, id, agentId: input.agentId, principalId: input.principalId,
  });
  return parsed.success ? parsed.data : undefined;
}
