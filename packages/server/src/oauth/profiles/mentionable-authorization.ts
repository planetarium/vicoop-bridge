import type { Sql } from '../../db.js';
import type { VerifiedCaller } from '../../auth/principal.js';
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
import {
  agentHasTokenExchangeTaskBindings,
  isTokenExchangeAuthorizationActive,
  loadTokenExchangeTaskAuthorization,
} from '../token-exchange/store.js';

export interface FederatedOperation {
  scope: OAuthFederationScope;
  kind: 'message' | 'task' | 'task-list';
  taskId?: string;
}

export type FederatedAuthorizationResult = { ok: true } | { ok: false; reason: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function taskIdFromMessage(params: Record<string, unknown> | undefined): string | undefined {
  const message = record(params?.message);
  return stringField(message?.taskId);
}

function taskIdFromParams(params: Record<string, unknown> | undefined): string | undefined {
  return stringField(params?.id) ?? stringField(params?.taskId);
}

const JSON_RPC_OPERATIONS: Record<string, Omit<FederatedOperation, 'taskId'>> = {
  'message/send': {
    scope: OAUTH_FEDERATION_SCOPE_MESSAGE_SEND,
    kind: 'message',
  },
  SendMessage: { scope: OAUTH_FEDERATION_SCOPE_MESSAGE_SEND, kind: 'message' },
  'message/stream': {
    scope: OAUTH_FEDERATION_SCOPE_MESSAGE_STREAM,
    kind: 'message',
  },
  SendStreamingMessage: {
    scope: OAUTH_FEDERATION_SCOPE_MESSAGE_STREAM,
    kind: 'message',
  },
  'tasks/get': { scope: OAUTH_FEDERATION_SCOPE_TASK_READ, kind: 'task' },
  GetTask: { scope: OAUTH_FEDERATION_SCOPE_TASK_READ, kind: 'task' },
  'tasks/list': { scope: OAUTH_FEDERATION_SCOPE_TASK_READ, kind: 'task-list' },
  ListTasks: { scope: OAUTH_FEDERATION_SCOPE_TASK_READ, kind: 'task-list' },
  'tasks/cancel': { scope: OAUTH_FEDERATION_SCOPE_TASK_CANCEL, kind: 'task' },
  CancelTask: { scope: OAUTH_FEDERATION_SCOPE_TASK_CANCEL, kind: 'task' },
  'tasks/resubscribe': {
    scope: OAUTH_FEDERATION_SCOPE_TASK_RESUBSCRIBE,
    kind: 'task',
  },
  SubscribeToTask: {
    scope: OAUTH_FEDERATION_SCOPE_TASK_RESUBSCRIBE,
    kind: 'task',
  },
  'tasks/pushNotificationConfig/set': {
    scope: OAUTH_FEDERATION_SCOPE_TASK_PUSH_CONFIG,
    kind: 'task',
  },
  'tasks/pushNotificationConfig/get': {
    scope: OAUTH_FEDERATION_SCOPE_TASK_PUSH_CONFIG,
    kind: 'task',
  },
  'tasks/pushNotificationConfig/list': {
    scope: OAUTH_FEDERATION_SCOPE_TASK_PUSH_CONFIG,
    kind: 'task',
  },
  'tasks/pushNotificationConfig/delete': {
    scope: OAUTH_FEDERATION_SCOPE_TASK_PUSH_CONFIG,
    kind: 'task',
  },
  CreateTaskPushNotificationConfig: {
    scope: OAUTH_FEDERATION_SCOPE_TASK_PUSH_CONFIG,
    kind: 'task',
  },
  GetTaskPushNotificationConfig: {
    scope: OAUTH_FEDERATION_SCOPE_TASK_PUSH_CONFIG,
    kind: 'task',
  },
  ListTaskPushNotificationConfigs: {
    scope: OAUTH_FEDERATION_SCOPE_TASK_PUSH_CONFIG,
    kind: 'task',
  },
  DeleteTaskPushNotificationConfig: {
    scope: OAUTH_FEDERATION_SCOPE_TASK_PUSH_CONFIG,
    kind: 'task',
  },
};

export function parseFederatedJsonRpcOperation(body: unknown): FederatedOperation | undefined {
  const request = record(body);
  const method = stringField(request?.method);
  if (!method) return undefined;
  const base = JSON_RPC_OPERATIONS[method];
  if (!base) return undefined;
  const params = record(request?.params);
  const taskId = base.kind === 'message' ? taskIdFromMessage(params) : taskIdFromParams(params);
  return { ...base, ...(taskId !== undefined ? { taskId } : {}) };
}

export function parseFederatedHttpJsonOperation(
  method: string,
  path: string,
  body: unknown,
): FederatedOperation | undefined {
  if (method === 'POST' && path.endsWith('/message:send')) {
    return {
      scope: OAUTH_FEDERATION_SCOPE_MESSAGE_SEND,
      kind: 'message',
      ...(taskIdFromMessage(record(body)) ? { taskId: taskIdFromMessage(record(body)) } : {}),
    };
  }
  if (method === 'POST' && path.endsWith('/message:stream')) {
    return {
      scope: OAUTH_FEDERATION_SCOPE_MESSAGE_STREAM,
      kind: 'message',
      ...(taskIdFromMessage(record(body)) ? { taskId: taskIdFromMessage(record(body)) } : {}),
    };
  }
  if (method === 'GET' && /\/tasks$/.test(path)) {
    return { scope: OAUTH_FEDERATION_SCOPE_TASK_READ, kind: 'task-list' };
  }
  const taskMatch = path.match(
    /\/tasks\/([^/:]+)(?::(cancel|subscribe))?(?:\/pushNotificationConfigs(?:\/[^/]+)?)?$/,
  );
  if (!taskMatch) return undefined;
  const taskId = decodeURIComponent(taskMatch[1]!);
  const action = taskMatch[2];
  if (action === 'cancel') {
    return { scope: OAUTH_FEDERATION_SCOPE_TASK_CANCEL, kind: 'task', taskId };
  }
  if (action === 'subscribe') {
    return {
      scope: OAUTH_FEDERATION_SCOPE_TASK_RESUBSCRIBE,
      kind: 'task',
      taskId,
    };
  }
  if (path.includes('/pushNotificationConfigs')) {
    return {
      scope: OAUTH_FEDERATION_SCOPE_TASK_PUSH_CONFIG,
      kind: 'task',
      taskId,
    };
  }
  if (method === 'GET') {
    return { scope: OAUTH_FEDERATION_SCOPE_TASK_READ, kind: 'task', taskId };
  }
  return undefined;
}

export async function authorizeFederatedOperation(
  sql: Sql,
  agentId: string,
  caller: VerifiedCaller | undefined,
  operation: FederatedOperation | undefined,
): Promise<FederatedAuthorizationResult> {
  const tokenExchange = caller?.tokenExchange;
  if (!tokenExchange) {
    // Removing the last allowed caller makes an agent public under the
    // bridge's long-standing empty-list semantics. Do not let that expose
    // tasks that were created under a federated delegation: their task-local
    // binding still requires a federation token even when new anonymous
    // messages are now allowed.
    if (operation?.kind === 'task-list') {
      if (await agentHasTokenExchangeTaskBindings(sql, agentId)) {
        return { ok: false, reason: 'federated_task_list_not_supported' };
      }
    } else if (operation?.taskId) {
      const task = await loadTokenExchangeTaskAuthorization(sql, agentId, operation.taskId);
      if (task?.authorizationKey) {
        return { ok: false, reason: 'federated_task_requires_token' };
      }
    }
    return { ok: true };
  }
  if (tokenExchange.profileId !== MENTIONABLE_OAUTH_PROFILE_ID) {
    return { ok: false, reason: 'unsupported_token_profile' };
  }
  if (!operation) return { ok: false, reason: 'unknown_operation' };
  if (!tokenExchange.scopes.includes(operation.scope)) {
    return { ok: false, reason: 'insufficient_scope' };
  }
  // Listing cannot be bound to one task and the current TaskStore API has no
  // request-scoped actor filter. Keep it closed in v0.1 rather than returning
  // another caller's tasks. The profile's continuity requirement covers get,
  // cancel, and resubscribe; actor-filtered listing can be added separately.
  if (operation.kind === 'task-list') {
    return { ok: false, reason: 'federated_task_list_not_supported' };
  }
  if (operation.kind === 'message' && operation.taskId === undefined) {
    if (tokenExchange.taskId !== undefined) return { ok: false, reason: 'token_task_mismatch' };
    return { ok: true };
  }
  if (!operation.taskId) return { ok: false, reason: 'missing_task_id' };
  if (tokenExchange.taskId !== undefined && tokenExchange.taskId !== operation.taskId) {
    return { ok: false, reason: 'token_task_mismatch' };
  }

  const task = await loadTokenExchangeTaskAuthorization(sql, agentId, operation.taskId);
  // Preserve the protocol's canonical not-found response; an unknown id is
  // not proof and grants nothing because the downstream handler still sees no
  // task. Existing task identifiers are checked below.
  if (!task) return { ok: true };
  if (task.profileId !== MENTIONABLE_OAUTH_PROFILE_ID) {
    return { ok: false, reason: 'task_profile_mismatch' };
  }
  if (!task.actorId || task.actorId !== tokenExchange.actorId || !task.authorizationKey) {
    return { ok: false, reason: 'task_actor_mismatch' };
  }
  // Universal v0.1 rule: every task operation matches both the originating
  // platform principal and Connector actor. This also applies to a
  // message-path token that happens to carry task scopes.
  if (!task.principalId || task.principalId !== caller?.principalId) {
    return { ok: false, reason: 'task_principal_mismatch' };
  }
  if (tokenExchange.allowedCaller !== task.authorizationKey) {
    return { ok: false, reason: 'task_grant_mismatch' };
  }
  if (!(await isTokenExchangeAuthorizationActive(sql, agentId, task.authorizationKey))) {
    return { ok: false, reason: 'task_grant_revoked' };
  }
  return { ok: true };
}
