import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Sql } from '../../db.js';
import type { VerifiedCaller } from '../../auth/principal.js';
import {
  authorizeFederatedOperation,
  parseFederatedHttpJsonOperation,
  parseFederatedJsonRpcOperation,
  type FederatedOperation,
} from './mentionable-authorization.js';
import {
  OAUTH_FEDERATION_SCOPE_MESSAGE_SEND,
  OAUTH_FEDERATION_SCOPE_TASK_CANCEL,
  OAUTH_FEDERATION_SCOPE_TASK_READ,
  OAUTH_FEDERATION_SCOPE_TASK_RESUBSCRIBE,
} from './mentionable-v0.1.js';

test('maps v0.3 and v1 JSON-RPC methods to the narrow federation scopes', () => {
  assert.deepEqual(
    parseFederatedJsonRpcOperation({
      method: 'message/send',
      params: { message: { taskId: 't-1' } },
    }),
    {
      scope: OAUTH_FEDERATION_SCOPE_MESSAGE_SEND,
      kind: 'message',
      taskId: 't-1',
    },
  );
  assert.deepEqual(
    parseFederatedJsonRpcOperation({
      method: 'GetTask',
      params: { id: 't-2' },
    }),
    { scope: OAUTH_FEDERATION_SCOPE_TASK_READ, kind: 'task', taskId: 't-2' },
  );
  assert.deepEqual(
    parseFederatedJsonRpcOperation({
      method: 'SubscribeToTask',
      params: { taskId: 't-3' },
    }),
    {
      scope: OAUTH_FEDERATION_SCOPE_TASK_RESUBSCRIBE,
      kind: 'task',
      taskId: 't-3',
    },
  );
});

test('maps HTTP+JSON task paths without confusing task ids and actions', () => {
  assert.deepEqual(parseFederatedHttpJsonOperation('GET', '/agents/a/v1/tasks/t%2F1', undefined), {
    scope: OAUTH_FEDERATION_SCOPE_TASK_READ,
    kind: 'task',
    taskId: 't/1',
  });
  assert.deepEqual(
    parseFederatedHttpJsonOperation('POST', '/agents/a/v1/tasks/t-2:cancel', undefined),
    { scope: OAUTH_FEDERATION_SCOPE_TASK_CANCEL, kind: 'task', taskId: 't-2' },
  );
  assert.deepEqual(parseFederatedHttpJsonOperation('GET', '/agents/a/v1/tasks', undefined), {
    scope: OAUTH_FEDERATION_SCOPE_TASK_READ,
    kind: 'task-list',
  });
});

test('unknown methods stay closed for federated bearer enforcement', () => {
  assert.equal(parseFederatedJsonRpcOperation({ method: 'custom/doThing' }), undefined);
  assert.equal(
    parseFederatedHttpJsonOperation('PATCH', '/agents/a/v1/tasks/t-1', undefined),
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
    await authorizeFederatedOperation(sql, 'agent-1', federatedCaller(), {
      scope: OAUTH_FEDERATION_SCOPE_MESSAGE_SEND,
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
    await authorizeFederatedOperation(sql, 'agent-1', taskOnly, {
      scope: OAUTH_FEDERATION_SCOPE_TASK_READ,
      kind: 'task',
      taskId: 'task-1',
    }),
    { ok: true },
  );
  assert.deepEqual(
    await authorizeFederatedOperation(sql, 'agent-1', taskOnly, {
      scope: OAUTH_FEDERATION_SCOPE_TASK_READ,
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
    await authorizeFederatedOperation(
      authorizationSql({
        actorId: 'did:web:connector.example',
        principalId: 'slack:T123/U456',
        authorizationKey: 'federated-key-1',
        active: true,
      }),
      'agent-1',
      caller,
      { scope: OAUTH_FEDERATION_SCOPE_MESSAGE_SEND, kind: 'message' },
    ),
    { ok: false, reason: 'unsupported_token_profile' },
  );
});

test('message-path task scopes still require the task principal to match', async () => {
  const result = await authorizeFederatedOperation(
    authorizationSql({
      actorId: 'did:web:connector.example',
      principalId: 'slack:T123/OTHER',
      authorizationKey: 'federated-key-1',
      active: true,
    }),
    'agent-1',
    federatedCaller(),
    {
      scope: OAUTH_FEDERATION_SCOPE_TASK_READ,
      kind: 'task',
      taskId: 'task-1',
    },
  );
  assert.deepEqual(result, { ok: false, reason: 'task_principal_mismatch' });
});

test('task continuity fails closed on actor mismatch or removed exact grant', async () => {
  const operation = {
    scope: OAUTH_FEDERATION_SCOPE_TASK_READ,
    kind: 'task' as const,
    taskId: 'task-1',
  } satisfies FederatedOperation;
  const caller = federatedCaller();
  assert.deepEqual(
    await authorizeFederatedOperation(
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
    await authorizeFederatedOperation(
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
  const result = await authorizeFederatedOperation(
    authorizationSql({
      actorId: 'did:web:connector.example',
      principalId: 'slack:T123/U456',
      authorizationKey: 'federated-key-1',
      active: false,
    }),
    'agent-1',
    undefined,
    {
      scope: OAUTH_FEDERATION_SCOPE_TASK_READ,
      kind: 'task',
      taskId: 'task-1',
    },
  );
  assert.deepEqual(result, {
    ok: false,
    reason: 'federated_task_requires_token',
  });
  assert.deepEqual(
    await authorizeFederatedOperation(
      authorizationSql({
        actorId: 'did:web:connector.example',
        principalId: 'slack:T123/U456',
        authorizationKey: 'federated-key-1',
        active: false,
      }),
      'agent-1',
      undefined,
      {
        scope: OAUTH_FEDERATION_SCOPE_TASK_READ,
        kind: 'task-list',
      },
    ),
    { ok: false, reason: 'federated_task_list_not_supported' },
  );
});
