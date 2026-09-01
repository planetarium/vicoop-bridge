import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Sql } from '../../db.js';
import type { VerifiedCaller } from '../../auth/principal.js';
import {
  authorizeTokenExchangeOperation,
  parseTokenExchangeHttpJsonOperation,
  parseTokenExchangeJsonRpcOperation,
  type TokenExchangeOperation,
} from '../token-exchange/authorization.js';
import { createMentionableResourceProfile } from './mentionable-authorization.js';
import {
  OAUTH_FEDERATION_SCOPE_MESSAGE_SEND,
  OAUTH_FEDERATION_SCOPE_TASK_CANCEL,
  OAUTH_FEDERATION_SCOPE_TASK_READ,
  OAUTH_FEDERATION_SCOPE_TASK_RESUBSCRIBE,
} from './mentionable-v0.1.js';

const profiles = [createMentionableResourceProfile()];
const authorize = (
  sql: Sql,
  agentId: string,
  caller: VerifiedCaller | undefined,
  operation: TokenExchangeOperation | undefined,
) => authorizeTokenExchangeOperation(sql, agentId, caller, operation, profiles);

test('maps v0.3 and v1 JSON-RPC methods to profile-independent operations', () => {
  assert.deepEqual(
    parseTokenExchangeJsonRpcOperation({
      method: 'message/send',
      params: { message: { taskId: 't-1' } },
    }),
    {
      name: 'message.send',
      kind: 'message',
      taskId: 't-1',
    },
  );
  assert.deepEqual(
    parseTokenExchangeJsonRpcOperation({
      method: 'GetTask',
      params: { id: 't-2' },
    }),
    { name: 'task.read', kind: 'task', taskId: 't-2' },
  );
  assert.deepEqual(
    parseTokenExchangeJsonRpcOperation({
      method: 'SubscribeToTask',
      params: { taskId: 't-3' },
    }),
    {
      name: 'task.resubscribe',
      kind: 'task',
      taskId: 't-3',
    },
  );
});

test('maps HTTP+JSON task paths without confusing task ids and actions', () => {
  assert.deepEqual(parseTokenExchangeHttpJsonOperation('GET', '/agents/a/v1/tasks/t%2F1', undefined), {
    name: 'task.read',
    kind: 'task',
    taskId: 't/1',
  });
  assert.deepEqual(
    parseTokenExchangeHttpJsonOperation('POST', '/agents/a/v1/tasks/t-2:cancel', undefined),
    { name: 'task.cancel', kind: 'task', taskId: 't-2' },
  );
  assert.deepEqual(parseTokenExchangeHttpJsonOperation('GET', '/agents/a/v1/tasks', undefined), {
    name: 'task.read',
    kind: 'task-list',
  });
});

test('unknown methods stay closed for federated bearer enforcement', () => {
  assert.equal(parseTokenExchangeJsonRpcOperation({ method: 'custom/doThing' }), undefined);
  assert.equal(
    parseTokenExchangeHttpJsonOperation('PATCH', '/agents/a/v1/tasks/t-1', undefined),
    undefined,
  );
});

function authorizationSql(input: {
  actorId: string;
  principalId: string;
  authorizationKey: string;
  active: boolean;
}): Sql {
  return (async (strings: TemplateStringsArray) => {
    const statement = strings.join('?');
    if (statement.includes('authorization_key IS NOT NULL')) return [{ present: true }];
    if (statement.includes('FROM infra.a2a_tasks')) {
      return [
        {
          owner_principal: input.principalId,
          owner_actor: input.actorId,
          authorization_profile: 'https://mentionable.dev/ns/oauth-federation/v0.1',
          authorization_key: input.authorizationKey,
        },
      ];
    }
    if (statement.includes('ANY(allowed_callers)')) return [{ active: input.active }];
    throw new Error(`unexpected SQL in test: ${statement}`);
  }) as unknown as Sql;
}

function federatedCaller(overrides: Partial<VerifiedCaller> = {}): VerifiedCaller {
  return {
    principalId: 'slack:T123/U456',
    actorId: 'did:web:connector.example',
    tokenExchange: {
      tokenId: 'token-1',
      profileId: 'https://mentionable.dev/ns/oauth-federation/v0.1',
      agentId: 'agent-1',
      resource: 'https://bridge.example/agents/agent-1',
      actorId: 'did:web:connector.example',
      allowedCaller: 'federated-key-1',
      scopes: [OAUTH_FEDERATION_SCOPE_MESSAGE_SEND, OAUTH_FEDERATION_SCOPE_TASK_READ],
    },
    ...overrides,
  };
}

test('continuation tokens retain principal, actor, grant, and task binding', async () => {
  const sql = authorizationSql({
    actorId: 'did:web:connector.example',
    principalId: 'slack:T123/U456',
    authorizationKey: 'federated-key-1',
    active: true,
  });
  assert.deepEqual(
    await authorize(sql, 'agent-1', federatedCaller(), {
      name: 'message.send',
      kind: 'message',
    }),
    { ok: true },
  );

  const taskOnly = federatedCaller({
    tokenExchange: {
      tokenId: 'token-2',
      profileId: 'https://mentionable.dev/ns/oauth-federation/v0.1',
      agentId: 'agent-1',
      resource: 'https://bridge.example/agents/agent-1',
      actorId: 'did:web:connector.example',
      allowedCaller: 'federated-key-1',
      scopes: [OAUTH_FEDERATION_SCOPE_TASK_READ],
      taskId: 'task-1',
    },
  });
  assert.deepEqual(
    await authorize(sql, 'agent-1', taskOnly, {
      name: 'task.read',
      kind: 'task',
      taskId: 'task-1',
    }),
    { ok: true },
  );
  assert.deepEqual(
    await authorize(sql, 'agent-1', taskOnly, {
      name: 'task.read',
      kind: 'task',
      taskId: 'task-2',
    }),
    { ok: false, reason: 'token_task_mismatch' },
  );
});

test('Mentionable resource policy rejects tokens issued by another profile', async () => {
  const caller = federatedCaller();
  caller.tokenExchange!.profileId = 'urn:example:oauth-profile:v1';
  assert.deepEqual(
    await authorize(
      authorizationSql({
        actorId: 'did:web:connector.example',
        principalId: 'slack:T123/U456',
        authorizationKey: 'federated-key-1',
        active: true,
      }),
      'agent-1',
      caller,
      { name: 'message.send', kind: 'message' },
    ),
    { ok: false, reason: 'unsupported_token_profile' },
  );
});

test('message-path task scopes still require the task principal to match', async () => {
  const result = await authorize(
    authorizationSql({
      actorId: 'did:web:connector.example',
      principalId: 'slack:T123/OTHER',
      authorizationKey: 'federated-key-1',
      active: true,
    }),
    'agent-1',
    federatedCaller(),
    {
      name: 'task.read',
      kind: 'task',
      taskId: 'task-1',
    },
  );
  assert.deepEqual(result, { ok: false, reason: 'task_principal_mismatch' });
});

test('task continuity fails closed on actor mismatch or removed exact grant', async () => {
  const operation = {
    name: 'task.read',
    kind: 'task' as const,
    taskId: 'task-1',
  } satisfies TokenExchangeOperation;
  const caller = federatedCaller();
  assert.deepEqual(
    await authorize(
      authorizationSql({
        actorId: 'did:web:other.example',
        principalId: caller.principalId,
        authorizationKey: 'federated-key-1',
        active: true,
      }),
      'agent-1',
      caller,
      operation,
    ),
    { ok: false, reason: 'task_actor_mismatch' },
  );
  assert.deepEqual(
    await authorize(
      authorizationSql({
        actorId: caller.tokenExchange!.actorId,
        principalId: caller.principalId,
        authorizationKey: 'federated-key-1',
        active: false,
      }),
      'agent-1',
      caller,
      operation,
    ),
    { ok: false, reason: 'task_grant_revoked' },
  );
});

test('a federated task remains protected after the agent becomes public', async () => {
  const result = await authorize(
    authorizationSql({
      actorId: 'did:web:connector.example',
      principalId: 'slack:T123/U456',
      authorizationKey: 'federated-key-1',
      active: false,
    }),
    'agent-1',
    undefined,
    {
      name: 'task.read',
      kind: 'task',
      taskId: 'task-1',
    },
  );
  assert.deepEqual(result, {
    ok: false,
    reason: 'federated_task_requires_token',
  });
  assert.deepEqual(
    await authorize(
      authorizationSql({
        actorId: 'did:web:connector.example',
        principalId: 'slack:T123/U456',
        authorizationKey: 'federated-key-1',
        active: false,
      }),
      'agent-1',
      undefined,
      {
        name: 'task.read',
        kind: 'task-list',
      },
    ),
    { ok: false, reason: 'federated_task_list_not_supported' },
  );
});

test('resource authorization dispatches a non-Mentionable token to its registered profile', async () => {
  const caller = federatedCaller();
  caller.tokenExchange!.profileId = 'urn:example:oauth-profile:v1';
  caller.tokenExchange!.scopes = ['example:read'];
  let received: TokenExchangeOperation | undefined;
  const result = await authorizeTokenExchangeOperation(
    (async () => { throw new Error('generic dispatch should not query task storage'); }) as unknown as Sql,
    'agent-1',
    caller,
    { name: 'message.send', kind: 'message' },
    [{
      id: 'urn:example:oauth-profile:v1',
      async authorize(context) {
        received = context.operation;
        return context.caller.tokenExchange?.scopes.includes('example:read') === true
          ? { ok: true }
          : { ok: false, reason: 'missing_example_scope' };
      },
    }],
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(received, { name: 'message.send', kind: 'message' });
});
