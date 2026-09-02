import type { VerifiedCaller } from '../../auth/principal.js';
import type { Sql } from '../../db.js';
import {
  agentHasTokenExchangeTaskBindings,
  loadTokenExchangeTaskAuthorization,
} from './store.js';

export type TokenExchangeOperationName =
  | 'message.send'
  | 'message.stream'
  | 'task.read'
  | 'task.cancel'
  | 'task.resubscribe'
  | 'task.push-config';

export interface TokenExchangeOperation {
  name: TokenExchangeOperationName;
  kind: 'message' | 'task' | 'task-list';
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
): TokenExchangeOperation | undefined {
  const request = record(body);
  const method = stringField(request?.method);
  if (!method) return undefined;
  const base = JSON_RPC_OPERATIONS[method];
  if (!base) return undefined;
  const params = record(request?.params);
  const taskId = base.kind === 'message' ? taskIdFromMessage(params) : taskIdFromParams(params);
  return { ...base, ...(taskId !== undefined ? { taskId } : {}) };
}

export function parseTokenExchangeHttpJsonOperation(
  method: string,
  path: string,
  body: unknown,
): TokenExchangeOperation | undefined {
  if (method === 'POST' && path.endsWith('/message:send')) {
    const taskId = taskIdFromMessage(record(body));
    return { name: 'message.send', kind: 'message', ...(taskId ? { taskId } : {}) };
  }
  if (method === 'POST' && path.endsWith('/message:stream')) {
    const taskId = taskIdFromMessage(record(body));
    return { name: 'message.stream', kind: 'message', ...(taskId ? { taskId } : {}) };
  }
  if (method === 'GET' && /\/tasks$/.test(path)) {
    return { name: 'task.read', kind: 'task-list' };
  }
  const taskMatch = path.match(
    /\/tasks\/([^/:]+)(?::(cancel|subscribe))?(?:\/pushNotificationConfigs(?:\/[^/]+)?)?$/,
  );
  if (!taskMatch) return undefined;
  const taskId = decodeURIComponent(taskMatch[1]!);
  const action = taskMatch[2];
  if (action === 'cancel') return { name: 'task.cancel', kind: 'task', taskId };
  if (action === 'subscribe') return { name: 'task.resubscribe', kind: 'task', taskId };
  if (path.includes('/pushNotificationConfigs')) {
    return { name: 'task.push-config', kind: 'task', taskId };
  }
  if (method === 'GET') return { name: 'task.read', kind: 'task', taskId };
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
  const profile = profiles.find((candidate) => candidate.id === tokenExchange.profileId);
  if (!profile) return { ok: false, reason: 'unsupported_token_profile' };
  return profile.authorize({ sql, agentId, caller: caller!, operation });
}
