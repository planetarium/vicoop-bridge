import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import {
  OPERATION_APPROVAL_EXTENSION_URI,
  CALLER_CONTEXT_V2_CAPABILITY,
  CALLER_RUNTIME_V1_CAPABILITY,
  EXECUTION_SCOPE_V1_CAPABILITY,
  FEDERATED_EXECUTION_SCOPE_V1_CAPABILITY,
  TASK_REPLAY_CAPABILITY,
  SIWE_BEARER_AUTH_EXTENSION_URI,
  formatFederatedPrincipal,
  TaskAssignFrame,
  type AgentCard,
} from '@vicoop-bridge/protocol';
import { DefaultRequestHandler, HttpJsonRequestHandler, TaskState } from '@a2x/sdk';
import { createHttpApp } from './http.js';
import { operationCallerScheme } from './operation-callers.js';
import { Registry, type ClientConnection } from './registry.js';
import { ensureSchema, type Sql } from './db.js';
import postgres from 'postgres';
import { issueCallerToken } from './auth/caller-token.js';
import { OAUTH_FEDERATION_EXTENSION_URI } from './oauth/profiles/mentionable-v0.1.js';

const callerRuntimeCapabilities = [
  CALLER_RUNTIME_V1_CAPABILITY,
  CALLER_CONTEXT_V2_CAPABILITY,
  EXECUTION_SCOPE_V1_CAPABILITY,
  TASK_REPLAY_CAPABILITY,
  FEDERATED_EXECUTION_SCOPE_V1_CAPABILITY,
];

function fakeSql(): Sql {
  return (async (strings: TemplateStringsArray) => strings.join('').includes('SELECT allowed_callers')
    ? [{ allowed_callers: [] }] : []) as unknown as Sql;
}

function registerAgent(registry: Registry, allowedCallers: string[] = []): void {
  const agentCard: AgentCard = {
    name: 'v1-test-agent',
    description: 'A2A v1 route test',
    version: '0.0.1',
    protocolVersion: '0.3.0',
    capabilities: { streaming: true },
    skills: [],
  };
  const conn: ClientConnection = {
    agentId: 'v1-test-agent',
    clientId: 'client-1',
    ownerPrincipal: 'eth:0x0000000000000000000000000000000000000001',
    agentCard,
    allowedCallers,
    ws: { close() {} } as unknown as WebSocket,
    connectedAt: Date.now(),
  };
  assert.deepEqual(registry.registerAgent(conn), { ok: true });
}

function buildApp(allowedCallers: string[] = []) {
  const registry = new Registry();
  registerAgent(registry, allowedCallers);
  return createHttpApp({
    registry,
    db: fakeSql(),
    publicUrl: 'https://bridge.example',
  });
}

test('versioned discovery exposes a v1 dual-transport card without changing v0.3', async () => {
  const app = buildApp();

  const v1Response = await app.request(
    '/agents/v1-test-agent/v1/.well-known/agent-card.json',
  );
  assert.equal(v1Response.status, 200);
  const v1Card = await v1Response.json() as {
    protocolVersion?: string;
    supportedInterfaces: Array<{
      url: string;
      protocolBinding: string;
      protocolVersion: string;
    }>;
  };
  assert.equal(v1Card.protocolVersion, undefined);
  assert.deepEqual(v1Card.supportedInterfaces, [
    {
      url: 'https://bridge.example/agents/v1-test-agent/v1',
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    },
    {
      url: 'https://bridge.example/agents/v1-test-agent/v1',
      protocolBinding: 'HTTP+JSON',
      protocolVersion: '1.0',
    },
  ]);

  const v03Response = await app.request(
    '/agents/v1-test-agent/.well-known/agent-card.json',
  );
  assert.equal(v03Response.status, 200);
  const v03Card = await v03Response.json() as { protocolVersion: string; url: string };
  assert.equal(v03Card.protocolVersion, '0.3.0');
  assert.equal(v03Card.url, 'https://bridge.example/agents/v1-test-agent');
});

test('operation callers distinguish verified Google subjects, policy selectors and delegated subjects', () => {
  const principalId = 'google:abc-XYZ_123';
  assert.equal(operationCallerScheme({ principalId }), 'google');
  for (const id of ['google:', 'google:sub:abc-XYZ_123', 'google:email:ana@example.com', 'google:domain:example.com']) {
    assert.equal(operationCallerScheme({ principalId: id }), undefined);
  }
  assert.equal(operationCallerScheme({ principalId, actorId: 'mistyped' }), undefined);
  assert.equal(operationCallerScheme({ principalId, actorId: 'did:web:connector.example' }), 'federated');
});

test('operation approval discovery requires overlapping runtime and current ownership policy on both card versions', async () => {
  for (const scenario of ['enabled', 'google', 'siwe', 'any-direct', 'api-key-only', 'wrong-scheme',
    'disabled', 'other-operation', 'old-revision', 'ordinary-agent', 'no-federation', 'incomplete-scope']) {
    const registry = new Registry();
    const caller = formatFederatedPrincipal({ issuer: 'did:web:connector.example', subject: 'slack:T/U',
      method: 'urn:mentionable:auth:slack-workspace-member:v0.1' })!;
    const wallet = 'eth:0x0000000000000000000000000000000000000003';
    const grants: Record<string, string[]> = {
      google: ['google:domain:example.com'], siwe: [wallet], 'any-direct': [],
      'api-key-only': ['apikey:service'], 'wrong-scheme': [wallet], 'no-federation': [],
    };
    registerAgent(registry, grants[scenario] ?? [caller]);
    const conn = registry.getAgent('v1-test-agent')!;
    conn.ownerRevision = 7;
    conn.protocolCapabilities = scenario === 'ordinary-agent' ? [] : callerRuntimeCapabilities.filter(capability =>
      (scenario !== 'incomplete-scope' || capability !== TASK_REPLAY_CAPABILITY) &&
      (scenario !== 'google' || capability !== FEDERATED_EXECUTION_SCOPE_V1_CAPABILITY));
    conn.agentCard.capabilities = { extensions: [{ uri: OPERATION_APPROVAL_EXTENSION_URI,
      required: true, params: { operations: ['merge-pr'], registrationUrl: 'https://untrusted.example' } }] };
    const policy = {
      agentId: conn.agentId, ownerPrincipal: conn.ownerPrincipal, ownerRevision: scenario === 'old-revision' ? 6 : 7,
      operation: scenario === 'other-operation' ? 'sync' : 'merge-pr', version: '1', executorId: 'host',
      executorTokenSha256: '0'.repeat(64), ttlSeconds: 3600, fields: {},
      operators: ['google', 'any-direct', 'wrong-scheme', 'api-key-only'].includes(scenario) ? [{ principalId: 'google:abc-XYZ_123' }]
        : scenario === 'siwe' ? [{ principalId: wallet }]
        : [{ principalId: 'slack:T/U2', actorId: 'did:web:connector.example' }],
    };
    const app = createHttpApp({ registry, db: fakeSql(), publicUrl: 'https://bridge.example',
      operationPolicies: scenario === 'disabled' ? [] : [policy] });
    for (const suffix of ['', '/v1']) {
      const response = await app.request(`/agents/${conn.agentId}${suffix}/.well-known/agent-card.json`);
      assert.equal(response.status, 200);
      const card = await response.json() as AgentCard;
      const matches = card.capabilities?.extensions?.filter(e => e.uri === OPERATION_APPROVAL_EXTENSION_URI) ?? [];
      assert.equal(matches.length, ['enabled', 'google', 'siwe', 'any-direct'].includes(scenario) ? 1 : 0, scenario);
      if (matches.length) {
        assert.equal(matches[0]!.required, false);
        assert.deepEqual(matches[0]!.params, { registrationUrl: 'https://bridge.example/agents/v1-test-agent/operations' });
      }
    }
  }
});

test('all public card surfaces advertise OAuth federation only for capable caller runtimes', async () => {
  const federated = formatFederatedPrincipal({
    issuer: 'did:web:connector.example',
    method: 'urn:mentionable:auth:slack-workspace-member:v0.1',
    subject: 'slack:T123/U456',
  })!;
  for (const upgraded of [false, true]) {
    const registry = new Registry();
    registerAgent(registry, [federated]);
    registry.getAgent('v1-test-agent')!.protocolCapabilities = callerRuntimeCapabilities.filter(
      (capability) => upgraded || capability !== FEDERATED_EXECUTION_SCOPE_V1_CAPABILITY,
    );
    const app = createHttpApp({ registry, db: fakeSql(), publicUrl: 'https://bridge.example' });
    for (const path of [
      '/agents/v1-test-agent/.well-known/agent-card.json',
      '/.well-known/agent-card/v1-test-agent',
      '/agents/v1-test-agent/v1/.well-known/agent-card.json',
    ]) {
      const response = await app.request(path);
      assert.equal(response.status, 200, path);
      const card = await response.json() as AgentCard & { a2a?: Pick<AgentCard, 'capabilities'> };
      const capabilities = path.startsWith('/.well-known/') ? card.a2a!.capabilities : card.capabilities;
      const extensions = capabilities?.extensions?.filter((extension) => extension.uri === OAUTH_FEDERATION_EXTENSION_URI) ?? [];
      assert.equal(extensions.length, upgraded ? 1 : 0, path);
      if (upgraded) {
        assert.equal(extensions[0]!.required, false);
        assert.deepEqual(extensions[0]!.params, {
          authorization_server: 'https://bridge.example/.well-known/oauth-authorization-server',
          resource: 'https://bridge.example/agents/v1-test-agent',
        });
      }
    }
  }
});

test('v1 JSON-RPC route returns protocol parse errors with an A2A-Version header', async () => {
  const response = await buildApp().request('/agents/v1-test-agent/v1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('A2A-Version'), '1.0');
  const body = await response.json() as { error: { code: number } };
  assert.equal(body.error.code, -32700);
});

test('JSON-RPC ingress rejects non-object bodies without asking the SDK to parse again', async () => {
  const app = buildApp();
  const request = { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'missing-task' } };
  for (const suffix of ['', '/v1']) {
    for (const value of [JSON.stringify(request), '{', null, [], true, 1, {}, { jsonrpc: '2.0', method: 'tasks/get' }]) {
      const response = await app.request(`/agents/v1-test-agent${suffix}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { id: unknown; error: { code: number } };
      assert.equal(body.id, null);
      assert.equal(body.error.code, -32600);
      if (suffix) assert.equal(response.headers.get('A2A-Version'), '1.0');
    }
    const malformed = await app.request(`/agents/v1-test-agent${suffix}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    });
    assert.equal(malformed.status, 200);
    assert.equal((await malformed.json() as { error: { code: number } }).error.code, -32700);
  }
});

test('unrecognized operations never reach an SDK handler', async (t) => {
  const app = buildApp();
  const rpcHandler = t.mock.method(DefaultRequestHandler.prototype, 'handle', async () => {
    throw new Error('unrecognized JSON-RPC operation reached SDK');
  });
  const httpHandler = t.mock.method(HttpJsonRequestHandler.prototype, 'handle', async () => {
    throw new Error('unrecognized HTTP+JSON operation reached SDK');
  });
  for (const suffix of ['', '/v1']) {
    const r = await app.request(`/agents/v1-test-agent${suffix}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'unknown', method: 'FutureTaskOperation', params: { id: 'task' } }),
    });
    assert.equal(r.status, 200);
    const body = await r.json() as { id: string; error: { code: number } };
    assert.equal(body.id, 'unknown');
    assert.equal(body.error.code, -32601);
  }
  const r = await app.request('/agents/v1-test-agent/v1/futureTasks/task');
  assert.equal(r.status, 404);
  assert.equal(rpcHandler.mock.callCount(), 0);
  assert.equal(httpHandler.mock.callCount(), 0);
});

test('v1 HTTP+JSON routes use structured errors and reject anonymous task listing', async () => {
  const app = buildApp();
  const malformed = await app.request('/agents/v1-test-agent/v1/message:send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/a2a+json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get('Content-Type') ?? '', /^application\/a2a\+json/);
  const malformedBody = await malformed.json() as { error: { status: string } };
  assert.equal(malformedBody.error.status, 'INVALID_ARGUMENT');

  const missingTask = await app.request('/agents/v1-test-agent/v1/tasks/missing-task');
  assert.equal(missingTask.status, 404);
  const missingTaskBody = await missingTask.json() as { error: { status: string } };
  assert.equal(missingTaskBody.error.status, 'NOT_FOUND');

  const list = await app.request('/agents/v1-test-agent/v1/tasks?pageSize=10');
  assert.equal(list.status, 403);
  assert.equal((await list.json() as { error: { status: string } }).error.status, 'PERMISSION_DENIED');

  const wrongVersion = await app.request(
    '/agents/v1-test-agent/v1/extendedAgentCard?A2A-Version=99.0',
  );
  assert.equal(wrongVersion.status, 400);
  const wrongVersionBody = await wrongVersion.json() as { error: { message: string } };
  assert.match(wrongVersionBody.error.message, /99\.0.*not supported/);
});

test('restricted v1 HTTP+JSON routes return google.rpc.Status auth errors', async () => {
  const response = await buildApp([
    'eth:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]).request('/agents/v1-test-agent/v1/tasks/missing-task');

  assert.equal(response.status, 401);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/a2a\+json/);
  const body = await response.json() as {
    error: { code: number; status: string; details: Array<{ metadata: { rejectionId: string } }> };
  };
  assert.equal(body.error.code, 401);
  assert.equal(body.error.status, 'UNAUTHENTICATED');
  assert.match(body.error.details[0]!.metadata.rejectionId, /^rej_[0-9a-f]{8}$/);
});

test('CORS preflight allows the A2A-Version request header', async () => {
  const response = await buildApp().request('/agents/v1-test-agent/v1/message:send', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://client.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'A2A-Version,Content-Type',
    },
  });

  assert.equal(response.status, 204);
  assert.match(response.headers.get('Access-Control-Allow-Headers') ?? '', /A2A-Version/i);
});

for (const { callerRuntime, federated, apiKeyOnly = false, direct } of [
  { callerRuntime: false, federated: true },
  { callerRuntime: false, federated: false },
  { callerRuntime: true, federated: true },
  { callerRuntime: true, federated: false },
  { callerRuntime: false, federated: false, apiKeyOnly: true },
  { callerRuntime: true, federated: false, apiKeyOnly: true },
  { callerRuntime: true, federated: false, direct: 'google' },
  { callerRuntime: true, federated: false, direct: 'siwe' },
  { callerRuntime: true, federated: false, direct: 'google-with-slack-operator' },
]) {
test(`${direct ?? (federated ? 'federated' : apiKeyOnly ? 'API-key-only' : 'mixed-policy API-key')} message tokens bind tasks on all three A2A ingress paths (${callerRuntime ? 'caller runtime' : 'host runtime'})`, async () => {
  const profileId = 'https://mentionable.dev/ns/oauth-federation/v0.1';
  const principalId = federated ? 'slack:T123/U456' : direct === 'siwe' ? 'eth:0x0000000000000000000000000000000000000003'
    : direct ? 'google:abc-XYZ_123' : 'apikey:direct-caller-554';
  const directGrant = direct?.startsWith('google') ? 'google:sub:abc-XYZ_123' : principalId;
  const canPropose = callerRuntime && (federated || direct === 'google' || direct === 'siwe');
  const actorId = 'did:web:connector.example';
  const authorizationKey = formatFederatedPrincipal({
    issuer: actorId, subject: 'slack:T123/U456',
    method: 'urn:mentionable:auth:slack-workspace-member:v0.1',
  })!;
  const tasks = new Map<string, Record<string, unknown>>();
  const dispatchIds = new Map<string, string>();
  const submittedBindings: unknown[][] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join('?');
    if (statement.includes('FROM callers')) {
      return [{
        id: 'direct-caller-554', principal_id: principalId, audience: 'caller', email: null,
        expires_at: new Date(Date.now() + 60_000), revoked: false,
      }];
    }
    if (statement.includes('FROM infra.oauth_token_exchange_access_tokens')) {
      return [{
        id: 'token-row-1',
        profile_id: profileId,
        agent_id: 'v1-test-agent',
        resource: 'https://bridge.example/agents/v1-test-agent',
        principal_id: principalId,
        actor_id: actorId,
        allowed_caller: authorizationKey,
        attestation: null,
        scopes: ['a2a:message.send', 'a2a:message.stream'],
        task_id: null,
        expires_at: new Date(Date.now() + 60_000),
        revoked: false,
        policy_active: true,
      }];
    }
    if (statement.includes('UPDATE infra.oauth_token_exchange_access_tokens')) return [];
    if (statement.includes('INSERT INTO infra.a2a_tasks')) {
      const task = structuredClone(values[3] as Record<string, unknown>);
      tasks.set(String(values[0]), task);
      if (values[2] === TaskState.SUBMITTED) submittedBindings.push(values);
      return [];
    }
    if (statement.includes('UPDATE infra.a2a_tasks SET dispatch_id')) {
      dispatchIds.set(String(values[1]), String(values[0]));
      return Object.assign([], { count: 1 });
    }
    if (statement.includes('SELECT task_json') && statement.includes('FROM infra.a2a_tasks')) {
      const task = tasks.get(String(values[0]));
      return task ? [{ task_json: structuredClone(task), dispatch_id: dispatchIds.get(String(values[0])) ?? null }] : [];
    }
    return Object.assign([], { count: 0 });
  }) as unknown as Sql;
  sql.json = ((value: unknown) => value) as Sql['json'];
  sql.begin = (async (callback: (tx: Sql) => unknown) => callback(sql)) as unknown as Sql['begin'];

  const registry = new Registry();
  const assignments: TaskAssignFrame[] = [];
  const ws = {
    close() {},
    send(raw: string) {
      const frame = JSON.parse(raw) as { type?: string; taskId?: string; contextId?: string };
      if (frame.type !== 'task.assign' || !frame.taskId) return;
      assignments.push(TaskAssignFrame.parse(JSON.parse(raw)));
      queueMicrotask(() => {
        const binding = registry.getBinding(frame.taskId!);
        binding?.sink.pushStatus({
          taskId: frame.taskId!,
          contextId: frame.contextId ?? frame.taskId!,
          final: true,
          status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
        });
        binding?.sink.finish();
      });
    },
  } as unknown as WebSocket;
  const agentCard: AgentCard = {
    name: 'v1-test-agent',
    description: 'federated ingress integration',
    version: '0.0.1',
    protocolVersion: '0.3.0',
    capabilities: { streaming: true, extensions: [{ uri: OPERATION_APPROVAL_EXTENSION_URI,
      params: { operations: ['merge-pr', 'unregistered'] } }] },
    skills: [],
  };
  assert.deepEqual(registry.registerAgent({
    agentId: 'v1-test-agent',
    clientId: 'client-1',
    ownerPrincipal: 'eth:0x0000000000000000000000000000000000000001',
    ownerRevision: 0,
    agentCard,
    allowedCallers: apiKeyOnly ? [principalId] : [authorizationKey, ...(!federated ? [directGrant] : [])],
    protocolCapabilities: callerRuntime ? callerRuntimeCapabilities : [CALLER_CONTEXT_V2_CAPABILITY],
    ws,
    connectedAt: Date.now(),
  }), { ok: true });
  const app = createHttpApp({ registry, db: sql, publicUrl: 'https://bridge.example', operationPolicies: [{
    agentId: 'v1-test-agent', ownerPrincipal: 'eth:0x0000000000000000000000000000000000000001',
    ownerRevision: 0, operation: 'merge-pr', version: '1', executorId: 'host', executorTokenSha256: '0'.repeat(64),
    operators: direct === 'google' ? [{ principalId: 'google:987' }]
      : direct === 'siwe' ? [{ principalId: 'eth:0x0000000000000000000000000000000000000004' }]
      : [{ principalId: 'slack:T123/U789', actorId }], ttlSeconds: 3600, fields: {},
  }] });
  const authorization = `Bearer ${federated ? 'vbc_oauth_test' : `vbc_caller_${principalId}`}`;
  // Authentication succeeds without opting into unrelated extensions, even
  // when a mixed policy also advertises federation.
  const message = (id: string) => ({
    messageId: id,
    role: 'user',
    parts: [{ kind: 'text', text: 'hello' }],
  });
  const requests: Array<[string, RequestInit]> = [
    ['/agents/v1-test-agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization, 'X-A2A-Extensions': OPERATION_APPROVAL_EXTENSION_URI,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: message('m-v03') },
      }),
    }],
    ['/agents/v1-test-agent/v1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'SendMessage', params: { message: { ...message('m-v1-rpc'), extensions: [OPERATION_APPROVAL_EXTENSION_URI] } },
      }),
    }],
    ['/agents/v1-test-agent/v1/message:send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/a2a+json', 'A2A-Extensions': OPERATION_APPROVAL_EXTENSION_URI,
        Authorization: authorization,
      },
      body: JSON.stringify({ message: message('m-v1-http') }),
    }],
  ];
  for (const [path, init] of requests) {
    const response = await app.request(path, init);
    assert.ok(response.status >= 200 && response.status < 300, `${path}: ${await response.text()}`);
    const activated = canPropose && path !== '/agents/v1-test-agent/v1';
    for (const header of ['X-A2A-Extensions', 'A2A-Extensions']) {
      assert.equal(response.headers.get(header), activated ? OPERATION_APPROVAL_EXTENSION_URI : null);
    }
  }
  assert.equal(submittedBindings.length, 3);
  assert.equal(assignments.length, 3);
  for (const assignment of assignments) {
    assert.deepEqual(assignment.operationNames, canPropose && assignment.message.messageId !== 'm-v1-rpc'
      ? ['merge-pr'] : undefined);
    assert.deepEqual(assignment.caller, {
      principal: { id: principalId }, ...(federated ? { actor: { id: actorId } } : {}),
    });
    if (callerRuntime) {
      assert.equal(assignment.executionScope?.policy, federated ? 'federated-principal-v1' : 'direct-principal-v1');
      assert.equal(assignment.executionScope?.principalId, federated ? authorizationKey : principalId);
      assert.equal(assignment.executionScope?.agentId, 'v1-test-agent');
      assert.match(assignment.executionScope?.id ?? '', /^[a-f0-9]{64}$/);
      assert.deepEqual(assignment.executionScope, assignments[0]!.executionScope);
    } else {
      assert.equal(assignment.executionScope, undefined);
    }
  }
  for (const values of submittedBindings) {
    assert.equal(values[4], principalId);
    assert.equal(values[6], federated ? actorId : null);
    assert.equal(values[7], federated ? profileId : null);
    assert.equal(values[8], federated ? authorizationKey : null);
    assert.equal(JSON.stringify(values[3]).includes('_authorizationKey'), false);
  }
});
}

// One live registry/app per runtime exercises cache invalidation as each grant
// is added/removed. Both A2A versions and the Mentionable projection must agree.
test('authentication discovery follows live caller policy on every public card surface', async () => {
  const eth = 'eth:0x0000000000000000000000000000000000000002';
  const federated = formatFederatedPrincipal({
    issuer: 'did:web:connector.example',
    method: 'urn:mentionable:auth:slack-workspace-member:v0.1',
    subject: 'slack:T123/U456',
  })!;
  for (const callerRuntime of [false, true]) {
    const registry = new Registry();
    registerAgent(registry);
    const conn = registry.getAgent('v1-test-agent')!;
    conn.protocolCapabilities = callerRuntime ? callerRuntimeCapabilities : [CALLER_CONTEXT_V2_CAPABILITY];
    // Untrusted hello entries must not resurrect methods after grant removal.
    conn.agentCard.capabilities!.extensions = [
      { uri: SIWE_BEARER_AUTH_EXTENSION_URI, required: true },
      { uri: OAUTH_FEDERATION_EXTENSION_URI, required: true },
    ];
    const app = createHttpApp({
      registry, db: fakeSql(), publicUrl: 'https://bridge.example',
      google: { clientId: 'test', clientSecret: 'test', redirectUri: 'https://bridge.example/oauth/callback' },
      deviceFlowStateSecret: 'test-secret-for-auth-discovery-558',
    });
    for (const policy of [
      { name: 'API key only', callers: ['apikey:alice'], schemes: ['bearerAuth'] },
      { name: 'federation only', callers: [federated], schemes: ['oauthFederation'] },
      { name: 'SIWE only', callers: [eth], schemes: ['bearerAuth', 'siweBearer'] },
      { name: 'Google only', callers: ['google:sub:123'], schemes: ['bearerAuth', 'deviceFlow'] },
      { name: 'mixed', callers: [eth, 'apikey:alice', federated, 'google:sub:123'], schemes: ['bearerAuth', 'siweBearer', 'oauthFederation', 'deviceFlow'] },
      { name: 'removed Ethereum', callers: ['apikey:alice', federated], schemes: ['bearerAuth', 'oauthFederation'] },
      { name: 'removed federation', callers: ['apikey:alice'], schemes: ['bearerAuth'] },
      { name: 'empty policy', callers: [], schemes: callerRuntime ? ['bearerAuth', 'siweBearer', 'deviceFlow'] : [] },
    ]) {
      registry.updateAllowedCallers('v1-test-agent', policy.callers);
      for (const path of [
        '/agents/v1-test-agent/.well-known/agent-card.json',
        '/agents/v1-test-agent/v1/.well-known/agent-card.json',
        '/.well-known/agent-card/v1-test-agent',
      ]) {
        const label = `${callerRuntime ? 'isolated' : 'host'} ${policy.name} ${path}`;
        const response = await app.request(path);
        assert.equal(response.status, 200, label);
        const card = await response.json() as {
          capabilities?: AgentCard['capabilities'];
          a2a?: { capabilities: AgentCard['capabilities']; auth: { scheme: string } };
          securitySchemes?: Record<string, { bearerFormat?: string; httpAuthSecurityScheme?: { bearerFormat?: string } }>;
          security?: Array<Record<string, string[]>>;
          securityRequirements?: Array<{ schemes: Record<string, { list: string[] }> }>;
        };
        assert.deepEqual(Object.keys(card.securitySchemes ?? {}).sort(), [...policy.schemes].sort(), label);
        const alternatives = card.security ?? card.securityRequirements?.map((requirement) =>
          Object.fromEntries(Object.keys(requirement.schemes).map((name) => [name, []])),
        ) ?? [];
        assert.deepEqual(alternatives, policy.schemes.map((name) => ({ [name]: [] })), label);
        const extensions = (card.a2a?.capabilities ?? card.capabilities)?.extensions ?? [];
        const siwe = extensions.find((extension) => extension.uri === SIWE_BEARER_AUTH_EXTENSION_URI);
        const federation = extensions.find((extension) => extension.uri === OAUTH_FEDERATION_EXTENSION_URI);
        assert.equal(Boolean(siwe), policy.schemes.includes('siweBearer'), label);
        assert.equal(Boolean(federation), policy.schemes.includes('oauthFederation'), label);
        for (const extension of [siwe, federation]) {
          if (extension) assert.equal(extension.required, false, label);
        }
        if (policy.schemes.includes('bearerAuth')) {
          const bearer = card.securitySchemes!.bearerAuth!;
          assert.equal(bearer.bearerFormat ?? bearer.httpAuthSecurityScheme?.bearerFormat, 'Opaque', label);
        }
        if (!policy.schemes.includes('siweBearer')) {
          assert.doesNotMatch(JSON.stringify(card), /mintToken|a2a-wallet|bearerFormat":"SIWE"/, label);
        }
        if (card.a2a) {
          assert.equal(card.a2a.auth.scheme, policy.schemes.includes('deviceFlow') ? 'oauth2' : 'none', label);
        }
      }
    }
  }
});

test('direct continuations offer operations only with their live original task grant',
  { skip: !process.env.DATABASE_URL }, async (t) => {
    const db = postgres(process.env.DATABASE_URL!, { onnotice() {} });
    await ensureSchema(db);
    const registry = new Registry();
    const agentId = 'resume-ops-' + crypto.randomUUID();
    const owner = 'owner-' + crypto.randomUUID();
    const principal = 'google:147';
    const exact = 'google:sub:147', domain = 'google:domain:bridge.test';
    const caller = await issueCallerToken(db, { principalId: principal, provider: 'google', email: 'reader@bridge.test' });
    t.after(async () => {
      await db`DELETE FROM infra.a2a_tasks WHERE owner_agent=${agentId}`;
      await db`DELETE FROM agents WHERE id=${agentId}`;
      await db`DELETE FROM callers WHERE id=${caller.callerId}`;
      await db.end();
    });
    await db`INSERT INTO agents(id,owner_principal,name,token_hash,allowed_callers)
      VALUES(${agentId},${owner},'resumed operations',${agentId},${[exact, domain]})`;
    const turns: Array<{ taskId: string; grant?: string; operations?: string[] }> = [];
    const ws = {
      close() {},
      send(raw: string) {
        const parsed = JSON.parse(raw);
        if (parsed.type !== 'task.assign') return;
        const frame = TaskAssignFrame.parse(parsed);
        const binding = registry.getBinding(frame.taskId)!;
        turns.push({ taskId: frame.taskId, grant: binding.operationGrant?.grantKey, operations: frame.operationNames });
        queueMicrotask(() => {
          binding.sink.pushStatus({ taskId: frame.taskId, contextId: frame.contextId,
            final: true, status: { state: TaskState.INPUT_REQUIRED } });
          binding.sink.finish();
        });
      },
    } as unknown as WebSocket;
    registry.registerAgent({
      agentId, clientId: 'resume-client', ownerPrincipal: owner, ownerRevision: 0, ws,
      protocolCapabilities: callerRuntimeCapabilities, allowedCallers: [exact, domain], connectedAt: Date.now(),
      agentCard: { name: agentId, description: 'resumable operations', version: '1', protocolVersion: '0.3.0',
        skills: [], capabilities: { extensions: [{ uri: OPERATION_APPROVAL_EXTENSION_URI, params: { operations: ['deploy'] } }] } },
    });
    const app = createHttpApp({ db, registry, publicUrl: 'https://bridge.test', operationPolicies: [{
      agentId, ownerPrincipal: owner, ownerRevision: 0, operation: 'deploy', version: '1', executorId: 'host',
      ttlSeconds: 3600, executorTokenSha256: '0'.repeat(64), operators: [{ principalId: 'google:148' }], fields: {},
    }] });
    const send = async (taskId?: string) => {
      const previousCount = turns.length;
      const response = await app.request('/agents/' + agentId, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + caller.rawToken,
          'X-A2A-Extensions': OPERATION_APPROVAL_EXTENSION_URI },
        body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'message/send', params: {
          message: { messageId: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text: 'continue' }], taskId },
        } }),
      });
      const reply = await response.json() as { error?: unknown };
      assert.equal(reply.error, undefined, JSON.stringify(reply));
      assert.equal(turns.length, previousCount + 1, 'ordinary chat must still dispatch');
      const turn = turns[previousCount]!;
      if (taskId) assert.equal(turn.taskId, taskId);
      assert.equal(response.headers.get('X-A2A-Extensions'), turn.grant ? OPERATION_APPROVAL_EXTENSION_URI : null);
      assert.deepEqual(turn.operations, turn.grant ? ['deploy'] : undefined);
      return turn;
    };
    const setGrants = async (grants: string[]) => {
      await db`UPDATE agents SET allowed_callers=${grants} WHERE id=${agentId}`;
      registry.updateAllowedCallers(agentId, grants);
    };
    const first = await send();
    assert.equal(first.grant, exact);
    await setGrants([domain, exact]);
    assert.equal((await send(first.taskId)).grant, exact);
    await setGrants([domain]);
    await setGrants([domain, exact]);
    assert.equal((await send(first.taskId)).grant, undefined);
    const older = await send();
    assert.equal(older.grant, domain);
    await db`UPDATE infra.a2a_tasks SET operation_owner_revision=operation_owner_revision+1 WHERE task_id=${older.taskId}`;
    assert.equal((await send(older.taskId)).grant, undefined);
  });
