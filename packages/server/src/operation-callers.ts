import {
  CALLER_RUNTIME_V1_CAPABILITY,
  HOST_OPERATIONS_V1_CAPABILITY,
  FEDERATED_EXECUTION_SCOPE_V1_CAPABILITY,
  OPERATION_APPROVAL_EXTENSION_URI,
  supportsExecutionScopeV1,
} from '@vicoop-bridge/protocol';
import type { OperationDefinition } from './operations.js';
import type { ClientConnection } from './registry.js';

export type OperationCallerScheme = 'google' | 'siwe' | 'federated';

export function operationCallerScheme(caller: {
  principalId: string;
  actorId?: string | undefined;
}): OperationCallerScheme | undefined {
  const { principalId, actorId } = caller;
  if (!principalId || principalId.length > 512) return undefined;
  // A connector can assert an opaque platform subject. Its issuer distinguishes
  // that identity even when the subject happens to look like a direct account.
  if (actorId !== undefined) return /^did:web:[^\s]+$/.test(actorId) ? 'federated' : undefined;
  // Google subs are opaque. Caller-policy selectors belong in allowed_callers,
  // while the operation registry identifies an individual verified account.
  if (principalId.startsWith('google:') && principalId.length > 'google:'.length &&
      !/^google:(?:sub|email|domain):/.test(principalId)) return 'google';
  if (/^eth:0x[0-9a-f]{40}$/.test(principalId)) return 'siwe';
  return undefined;
}

export function operationOperatorMethod(operator: { actorId?: string; method?: string }): string | undefined {
  if (operator.actorId) return operator.method ?? 'urn:mentionable:auth:slack-workspace-member:v0.1';
  return undefined;
}

export function matchingOperationNames(
  conn: ClientConnection,
  policies: readonly OperationDefinition[],
  scheme: OperationCallerScheme,
): string[] {
  const capabilities = conn.protocolCapabilities;
  const hostOperations = capabilities?.includes(HOST_OPERATIONS_V1_CAPABILITY) &&
    (conn.backendKind === 'claude' || conn.backendKind === 'codex');
  if (!capabilities || !(hostOperations || capabilities.includes(CALLER_RUNTIME_V1_CAPABILITY)) ||
      !supportsExecutionScopeV1(capabilities) ||
      (scheme === 'federated' && !capabilities.includes(FEDERATED_EXECUTION_SCOPE_V1_CAPABILITY))) return [];
  const declared = conn.agentCard.capabilities?.extensions
    ?.find(e => e.uri === OPERATION_APPROVAL_EXTENSION_URI)?.params?.operations;
  if (!Array.isArray(declared)) return [];
  return policies.filter(p => p.agentId === conn.agentId && p.ownerPrincipal === conn.ownerPrincipal &&
    p.ownerRevision === conn.ownerRevision && declared.includes(p.operation)).map(p => p.operation);
}

export function operationGrantIsActive(grantKey: string, allowedCallers: readonly string[]): boolean {
  return grantKey === 'public' ? allowedCallers.length === 0 : allowedCallers.includes(grantKey);
}
