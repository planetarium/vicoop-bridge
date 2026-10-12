import { InvalidParamsError } from '@a2x/sdk';
import { PUBLIC_TASK_PROFILE } from '../../task-access.js';
import type { VerifiedCaller } from '../../auth/principal.js';
import type { Sql } from '../../db.js';
import {
  agentHasTokenExchangeTaskBindings,
  loadTokenExchangeTaskAuthorization,
} from './store.js';

export type TokenExchangeOperationName =
  | 'agent.card'
  | 'message.send'
  | 'message.stream'
  | 'task.read'
  | 'task.cancel'
  | 'task.resubscribe'
  | 'task.push-config';

export interface TokenExchangeOperation {
  name: TokenExchangeOperationName;
  kind: 'message' | 'task' | 'task-list' | 'agent';
  taskId?: string;
}

export type TokenExchangeAuthorizationResult = { ok: true } | { ok: false; reason: string };

export interface TokenExchangeResourceAuthorizationContext {
  sql: Sql;
  agentId: string;
  caller: VerifiedCaller;
  operation: TokenExchangeOperation | undefined;
}

export interface TokenExchangeResourceProfile {
  id: string;
  authorize(
    context: TokenExchangeResourceAuthorizationContext,
  ): Promise<TokenExchangeAuthorizationResult>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function taskIdFromMessage(params: Record<string, unknown> | undefined): string | undefined {
  return stringField(record(params?.message)?.taskId);
}

function taskIdFromParams(params: Record<string, unknown> | undefined): string | undefined {
  return stringField(params?.id) ?? stringField(params?.taskId);
}

const JSON_RPC_OPERATIONS: Record<string, Omit<TokenExchangeOperation, 'taskId'>> = {
  'agent/getAuthenticatedExtendedCard': { name: 'agent.card', kind: 'agent' },
  GetExtendedAgentCard: { name: 'agent.card', kind: 'agent' },
  'message/send': { name: 'message.send', kind: 'message' },
  SendMessage: { name: 'message.send', kind: 'message' },
  'message/stream': { name: 'message.stream', kind: 'message' },
  SendStreamingMessage: { name: 'message.stream', kind: 'message' },
  'tasks/get': { name: 'task.read', kind: 'task' },
  GetTask: { name: 'task.read', kind: 'task' },
  'tasks/list': { name: 'task.read', kind: 'task-list' },
  ListTasks: { name: 'task.read', kind: 'task-list' },
  'tasks/cancel': { name: 'task.cancel', kind: 'task' },
  CancelTask: { name: 'task.cancel', kind: 'task' },
  'tasks/resubscribe': { name: 'task.resubscribe', kind: 'task' },
  SubscribeToTask: { name: 'task.resubscribe', kind: 'task' },
  'tasks/pushNotificationConfig/set': { name: 'task.push-config', kind: 'task' },
  'tasks/pushNotificationConfig/get': { name: 'task.push-config', kind: 'task' },
  'tasks/pushNotificationConfig/list': { name: 'task.push-config', kind: 'task' },
  'tasks/pushNotificationConfig/delete': { name: 'task.push-config', kind: 'task' },
  CreateTaskPushNotificationConfig: { name: 'task.push-config', kind: 'task' },
  GetTaskPushNotificationConfig: { name: 'task.push-config', kind: 'task' },
  ListTaskPushNotificationConfigs: { name: 'task.push-config', kind: 'task' },
  DeleteTaskPushNotificationConfig: { name: 'task.push-config', kind: 'task' },
};

export function parseTokenExchangeJsonRpcOperation(
  body: unknown,
  version: '0.3' | '1.0' = '0.3',
): TokenExchangeOperation | undefined {
  const request = record(body);
  const method = stringField(request?.method);
  if (!method) return undefined;
  const base = Object.hasOwn(JSON_RPC_OPERATIONS, method) ? JSON_RPC_OPERATIONS[method] : undefined;
  if (!base) return undefined;
  if (base.kind === 'agent' || base.kind === 'task-list') return { ...base };
  const params = record(request?.params);
  // v1 push config `id` identifies the CONFIG, not the task. The SDK also
  // accepts canonical v0.3 method names at the v1 endpoint, so use the binding
  // version rather than inferring the parameter shape from the method name.
  const taskId = base.kind === 'message'
    ? taskIdFromMessage(params)
    : base.name === 'task.push-config'
      ? stringField(params?.[version === '1.0' || method === 'tasks/pushNotificationConfig/set'
        ? 'taskId' : 'id'])
      : taskIdFromParams(params);
  return { ...base, ...(taskId !== undefined ? { taskId } : {}) };
}

// Match the installed SDK decoder, including its protocol error on malformed IDs.
function decodePathId(value: string): string {
  try { return decodeURIComponent(value); } catch {
    throw new InvalidParamsError('Invalid percent-encoding in resource ID');
  }
}

export function parseTokenExchangeHttpJsonOperation(
  method: string,
  path: string,
  body: unknown,
): TokenExchangeOperation | undefined {
  // Path is relative to the v1 endpoint. Mirror the SDK's optional tenant
  // prefix, then match whole routes so resource IDs cannot become operations.
  if (path !== '/message:send' && path !== '/message:stream' && path !== '/tasks'
    && !path.startsWith('/tasks/') && path !== '/extendedAgentCard') {
    const tenant = path.match(/^\/[^/]+(\/(?:message:(?:send|stream)|tasks(?:\/.*)?|extendedAgentCard))$/);
    if (tenant) path = tenant[1]!;
  }
  if (method === 'GET' && path === '/extendedAgentCard') {
    return { name: 'agent.card', kind: 'agent' };
  }
  if (method === 'POST' && path === '/message:send') {
    const taskId = taskIdFromMessage(record(body));
    return { name: 'message.send', kind: 'message', ...(taskId ? { taskId } : {}) };
  }
  if (method === 'POST' && path === '/message:stream') {
    const taskId = taskIdFromMessage(record(body));
    return { name: 'message.stream', kind: 'message', ...(taskId ? { taskId } : {}) };
  }
  if (method === 'GET' && path === '/tasks') {
    return { name: 'task.read', kind: 'task-list' };
  }
  // SDK 0.24 resolves GET /tasks/:id before action routes, including IDs
  // containing literal colons. Authorize exactly the ID it will read.
  const getTask = method === 'GET' ? path.match(/^\/tasks\/([^/]+)$/) : null;
  if (getTask) return { name: 'task.read', kind: 'task', taskId: decodePathId(getTask[1]!) };
  const action = method === 'POST' ? path.match(/^\/tasks\/([^/]+):(cancel|subscribe)$/) : null;
  if (action) {
    return { name: action[2] === 'cancel' ? 'task.cancel' : 'task.resubscribe',
      kind: 'task', taskId: decodePathId(action[1]!) };
  }
  const pushConfig = path.match(/^\/tasks\/([^/]+)\/pushNotificationConfigs(?:\/[^/]+)?$/);
  if (pushConfig) {
    return { name: 'task.push-config', kind: 'task', taskId: decodePathId(pushConfig[1]!) };
  }
  return undefined;
}

export async function authorizeTokenExchangeOperation(
  sql: Sql,
  agentId: string,
  caller: VerifiedCaller | undefined,
  operation: TokenExchangeOperation | undefined,
  profiles: readonly TokenExchangeResourceProfile[],
): Promise<TokenExchangeAuthorizationResult> {
  const tokenExchange = caller?.tokenExchange;
  if (!tokenExchange) {
    if (!operation) return { ok: false, reason: 'unknown_operation' };
    if (operation.kind === 'task' && !operation.taskId) {
      return { ok: false, reason: 'missing_task_id' };
    }
    if (operation?.kind === 'task-list') {
      if (!caller) return { ok: false, reason: 'anonymous_task_list_not_allowed' };
      if (await agentHasTokenExchangeTaskBindings(sql, agentId)) {
        return { ok: false, reason: 'federated_task_list_not_supported' };
      }
    } else if (operation?.taskId) {
      const task = await loadTokenExchangeTaskAuthorization(sql, agentId, operation.taskId);
      // Preserve SDK continuation semantics for pruned/nonexistent tasks.
      // Existing inaccessible tasks are still denied, never resumed or replaced.
      if (!task && operation.kind === 'message') return { ok: true };
      if (task?.authorizationKey) {
        return { ok: false, reason: 'federated_task_requires_token' };
      }
      const accessible = task && !task.authorizationRevoked && !task.actorId && (
        caller
          ? task.principalId === caller.principalId && task.profileId === undefined
          : task.principalId === undefined && task.profileId === PUBLIC_TASK_PROFILE
      );
      if (!accessible) return { ok: false, reason: 'task_not_accessible' };
    }
    return { ok: true };
  }
  const profile = profiles.find((candidate) => candidate.id === tokenExchange.profileId);
  if (!profile) return { ok: false, reason: 'unsupported_token_profile' };
  return profile.authorize({ sql, agentId, caller: caller!, operation });
}
