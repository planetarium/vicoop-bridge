import {
  isTokenExchangeAuthorizationActive,
  loadTokenExchangeTaskAuthorization,
} from '../token-exchange/store.js';
import type {
  TokenExchangeOperationName,
  TokenExchangeResourceAuthorizationContext,
  TokenExchangeResourceProfile,
} from '../token-exchange/authorization.js';
import {
  OAUTH_FEDERATION_SCOPE_MESSAGE_SEND,
  OAUTH_FEDERATION_SCOPE_MESSAGE_STREAM,
  OAUTH_FEDERATION_SCOPE_TASK_CANCEL,
  OAUTH_FEDERATION_SCOPE_TASK_PUSH_CONFIG,
  OAUTH_FEDERATION_SCOPE_TASK_READ,
  OAUTH_FEDERATION_SCOPE_TASK_RESUBSCRIBE,
  MENTIONABLE_OAUTH_PROFILE_ID,
  type OAuthFederationScope,
} from './mentionable-v0.1.js';

const REQUIRED_SCOPE: Record<TokenExchangeOperationName, OAuthFederationScope> = {
  'message.send': OAUTH_FEDERATION_SCOPE_MESSAGE_SEND,
  'message.stream': OAUTH_FEDERATION_SCOPE_MESSAGE_STREAM,
  'task.read': OAUTH_FEDERATION_SCOPE_TASK_READ,
  'task.cancel': OAUTH_FEDERATION_SCOPE_TASK_CANCEL,
  'task.resubscribe': OAUTH_FEDERATION_SCOPE_TASK_RESUBSCRIBE,
  'task.push-config': OAUTH_FEDERATION_SCOPE_TASK_PUSH_CONFIG,
};

export async function authorizeMentionableOperation({
  sql,
  agentId,
  caller,
  operation,
}: TokenExchangeResourceAuthorizationContext) {
  const tokenExchange = caller.tokenExchange!;
  if (!operation) return { ok: false as const, reason: 'unknown_operation' };
  if (!tokenExchange.scopes.includes(REQUIRED_SCOPE[operation.name])) {
    return { ok: false as const, reason: 'insufficient_scope' };
  }
  if (operation.kind === 'task-list') {
    return { ok: false as const, reason: 'federated_task_list_not_supported' };
  }
  if (operation.kind === 'message' && operation.taskId === undefined) {
    if (tokenExchange.taskId !== undefined) {
      return { ok: false as const, reason: 'token_task_mismatch' };
    }
    return { ok: true as const };
  }
  if (!operation.taskId) return { ok: false as const, reason: 'missing_task_id' };
  if (tokenExchange.taskId !== undefined && tokenExchange.taskId !== operation.taskId) {
    return { ok: false as const, reason: 'token_task_mismatch' };
  }

  const task = await loadTokenExchangeTaskAuthorization(sql, agentId, operation.taskId);
  if (!task) return { ok: true as const };
  if (task.profileId !== MENTIONABLE_OAUTH_PROFILE_ID) {
    return { ok: false as const, reason: 'task_profile_mismatch' };
  }
  if (!task.actorId || task.actorId !== tokenExchange.actorId || !task.authorizationKey) {
    return { ok: false as const, reason: 'task_actor_mismatch' };
  }
  if (!task.principalId || task.principalId !== caller.principalId) {
    return { ok: false as const, reason: 'task_principal_mismatch' };
  }
  if (tokenExchange.allowedCaller !== task.authorizationKey) {
    return { ok: false as const, reason: 'task_grant_mismatch' };
  }
  if (!(await isTokenExchangeAuthorizationActive(sql, agentId, task.authorizationKey))) {
    return { ok: false as const, reason: 'task_grant_revoked' };
  }
  return { ok: true as const };
}

export function createMentionableResourceProfile(): TokenExchangeResourceProfile {
  return { id: MENTIONABLE_OAUTH_PROFILE_ID, authorize: authorizeMentionableOperation };
}
