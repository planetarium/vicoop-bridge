import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import postgres from 'postgres';
import type { WebSocket } from 'ws';
import { A2XClient, TaskNotFoundError, TaskState, type AgentCardV03, type AgentCardV10, type Task } from '@a2x/sdk';
import { SIWE_BEARER_AUTH_EXTENSION_URI, type TaskAssignFrame } from '@vicoop-bridge/protocol';
import { createHttpApp } from './http.js';
import { ensureSchema } from './db.js';
import { Registry } from './registry.js';
import { issueSessionToken } from './auth/caller-token.js';
import { PostgresTaskStore } from './postgres-task-store.js';
import { parseTokenExchangeJsonRpcOperation, parseTokenExchangeHttpJsonOperation } from './oauth/token-exchange/authorization.js';

test('push config authorization selects the SDK task field, not a config id', () => {
  for (const method of ['GetTaskPushNotificationConfig', 'DeleteTaskPushNotificationConfig',
    'CreateTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs',
    'tasks/pushNotificationConfig/get', 'tasks/pushNotificationConfig/delete']) {
    assert.equal(parseTokenExchangeJsonRpcOperation({ method,
      params: { id: 'own-task-used-as-config-id', taskId: 'victim' } }, '1.0')?.taskId, 'victim');
  }
  assert.equal(parseTokenExchangeJsonRpcOperation({ method: 'tasks/pushNotificationConfig/set',
    params: { id: 'decoy', taskId: 'victim' } })?.taskId, 'victim');
  assert.equal(parseTokenExchangeJsonRpcOperation({ method: 'tasks/pushNotificationConfig/get',
    params: { id: 'victim', taskId: 'decoy' } })?.taskId, 'victim');
  assert.equal(parseTokenExchangeHttpJsonOperation('GET', '/tasks/id:cancel', undefined)?.taskId, 'id:cancel');
  assert.equal(parseTokenExchangeHttpJsonOperation('DELETE', '/tasks/id:cancel/pushNotificationConfigs/config', undefined)?.taskId, 'id:cancel');
});

test('HTTP operation parsing does not interpret resource names as route suffixes', () => {
  for (const id of ['tasks', 'message:send', 'message:stream']) {
    assert.deepEqual(parseTokenExchangeHttpJsonOperation('GET', `/tasks/victim/pushNotificationConfigs/${id}`, undefined),
      { name: 'task.push-config', kind: 'task', taskId: 'victim' });
  }
  assert.deepEqual(parseTokenExchangeHttpJsonOperation('GET', '/tenant/tasks/task-id', undefined),
    { name: 'task.read', kind: 'task', taskId: 'task-id' });
});

test('task access is bound to the authenticated caller across transports (issue #517)',
  { skip: !process.env.DATABASE_URL }, async (t) => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
  const agentId = `task-access-${randomUUID()}`;
  const otherAgent = `${agentId}-other`;
  const principals = [0, 1, 2].map(() => `eth:0x${randomUUID().replaceAll('-', '')}00000000`);
  const issued: Awaited<ReturnType<typeof issueSessionToken>>[] = [];
  const assignments: TaskAssignFrame[] = [];
  let publicAgent = false;
  let useCallerRuntime = true;
  function buildApp() {
    const registry = new Registry();
    for (const id of [agentId, otherAgent]) {
      assert.deepEqual(registry.registerAgent({ agentId: id, clientId: `${id}-client`,
        ownerPrincipal: principals[1]!, // B being agent owner must not bypass task ownership.
        agentCard: { name: id, description: 'Task ownership test', version: '1', protocolVersion: '0.3.0',
          capabilities: { streaming: true }, skills: [] },
        allowedCallers: publicAgent ? [] : principals.slice(0, 2),
        protocolCapabilities: useCallerRuntime
          ? ['execution-scope-v1', 'caller-context-v2', 'task-replay-v1', 'caller-runtime-v1'] : [],
        connectedAt: Date.now(),
        ws: { close() {}, send(raw: string) {
          const frame = JSON.parse(raw) as TaskAssignFrame;
          if (frame.type !== 'task.assign') return;
          assignments.push(frame);
          queueMicrotask(() => {
            const binding = registry.getBinding(frame.taskId)!;
            binding.sink.pushArtifact({ taskId: frame.taskId, contextId: frame.contextId,
              artifact: { artifactId: 'artifact', parts: [{ text: 'private-artifact' }] } });
            binding.sink.pushStatus({ taskId: frame.taskId, contextId: frame.contextId, final: true,
              status: { state: TaskState.COMPLETED, message: { messageId: randomUUID(), role: 'agent',
                parts: [{ text: 'private-response' }] } } });
            binding.sink.finish();
          });
        } } as unknown as WebSocket,
      }), { ok: true });
    }
    return createHttpApp({ registry, db: sql, publicUrl: 'http://localhost' });
  }
  let app: ReturnType<typeof buildApp>;
  const headers = (caller: number | undefined) => ({ 'Content-Type': 'application/json',
    'A2A-Extensions': SIWE_BEARER_AUTH_EXTENSION_URI,
    ...(caller === undefined ? {} : { Authorization: `Bearer ${issued[caller]!.rawToken}` }) });
  const rpc = (caller: number | undefined, method: string, params: unknown, v1 = false, id = agentId) =>
    app.request(`/agents/${id}${v1 ? '/v1' : ''}`, { method: 'POST', headers: headers(caller),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  async function send(caller: number | undefined, contextId: string, taskId?: string) {
    const response = await rpc(caller, 'message/send', { message: { messageId: randomUUID(), role: 'user',
      parts: [{ kind: 'text', text: 'private-prompt' }], contextId, taskId,
      metadata: { _principalId: principals[1], _authorizationProfile: 'forged' } },
      metadata: { _principalId: principals[1], _authorizationProfile: 'forged' },
      configuration: { blocking: true } });
    const body = await response.json() as { result: Task };
    assert.ok(body.result?.id, JSON.stringify(body));
    return body.result;
  }
  async function denied(response: Response) {
    const httpJson = response.headers.get('Content-Type')?.startsWith('application/a2a+json');
    assert.equal(response.status, httpJson ? 404 : 200, await response.clone().text());
    const text = await response.text();
    assert.ok(!text.includes('private-'), text);
    if (!httpJson) {
      const body = JSON.parse(text);
      assert.equal(body.id, 1);
      assert.equal(body.error.code, -32001);
      assert.equal(body.result, undefined);
    }
  }
  try {
    await ensureSchema(sql);
    for (const principalId of [...principals, principals[0]!]) {
      issued.push(await issueSessionToken(sql, { principalId, provider: 'siwe', audience: 'caller' }));
    }
    app = buildApp();
    const a = await send(0, 'shared-context');
    const b = await send(1, 'shared-context');
    const different = await send(0, 'different-context');
    assert.notEqual(assignments[0]!.executionScope?.id, assignments[1]!.executionScope?.id);
    const store = new PostgresTaskStore(sql, { ownerAgent: agentId });
    const working = await store.createTask({ contextId: 'shared-context', metadata: { _principalId: principals[0] } });
    await store.updateTask(working.id, { status: { state: TaskState.WORKING } });
    const resumable = await store.createTask({ contextId: 'resume-context', metadata: { _principalId: principals[0] } });
    await store.updateTask(resumable.id, { status: { state: TaskState.INPUT_REQUIRED } });
    const legacy = await store.createTask({ contextId: 'legacy' });

    await t.test('get: same/different contexts, working/completed, renewed token, cross-agent', async () => {
      for (const task of [a, different, working]) {
        await denied(await rpc(1, 'tasks/get', { id: task.id }));
        await denied(await rpc(1, 'GetTask', { id: task.id }, true));
        await denied(await app.request(`/agents/${agentId}/v1/tasks/${task.id}`, { headers: headers(1) }));
        assert.equal((await rpc(0, 'tasks/get', { id: task.id })).status, 200);
      }
      assert.equal((await rpc(3, 'tasks/get', { id: a.id })).status, 200);
      await denied(await rpc(0, 'tasks/get', { id: a.id }, false, otherAgent));
      await denied(await rpc(0, 'tasks/get', { id: legacy.id }));
      await denied(await rpc(0, 'tasks/get', { id: 'missing' }));
      assert.equal((await rpc(2, 'tasks/get', { id: a.id })).status, 403);
    });

    await t.test('string-encoded JSON-RPC requests are rejected before reads or execution', async () => {
      const before = await sql`SELECT * FROM infra.a2a_tasks WHERE owner_agent=${agentId} ORDER BY task_id`;
      const count = assignments.length;
      for (const v1 of [false, true]) {
        const requests = [
          { method: v1 ? 'GetTask' : 'tasks/get', params: { id: a.id } },
          { method: v1 ? 'SendMessage' : 'message/send', params: {
            message: { messageId: randomUUID(), role: 'user', parts: [{ text: 'invalid envelope' }] },
          } },
        ];
        for (const request of requests) {
          const response = await app.request(`/agents/${agentId}${v1 ? '/v1' : ''}`, {
            method: 'POST', headers: headers(1),
            body: JSON.stringify(JSON.stringify({ jsonrpc: '2.0', id: 1, ...request })),
          });
          assert.equal(response.status, 200);
          const body = await response.json() as { result?: unknown; error?: { code: number } };
          assert.equal(body.result, undefined);
          assert.equal(body.error?.code, -32600);
        }
      }
      assert.equal(assignments.length, count);
      assert.deepEqual(await sql`SELECT * FROM infra.a2a_tasks WHERE owner_agent=${agentId} ORDER BY task_id`, before);
    });

    await t.test('list count/pagination and concurrent requests only contain own tasks', async () => {
      const lists = await Promise.all([0, 1, 0, 1].map(async caller => {
        const r = await rpc(caller, 'ListTasks', { pageSize: 1, includeArtifacts: true }, true);
        assert.equal(r.status, 200);
        return { caller, body: await r.json() as { result: { tasks: Task[]; totalSize: number; nextPageToken: string } } };
      }));
      for (const { caller, body } of lists) {
        assert.equal(body.result.totalSize, caller === 0 ? 4 : 1);
        assert.equal(body.result.tasks.length, 1);
        if (caller === 1) { assert.equal(body.result.tasks[0]!.id, b.id); assert.equal(body.result.nextPageToken, ''); }
      }
      const r = await app.request(`/agents/${agentId}/v1/tasks?contextId=shared-context`, { headers: headers(1) });
      const list = await r.json() as { tasks: Task[]; totalSize: number };
      assert.equal(list.totalSize, 1);
      assert.deepEqual(list.tasks.map(task => task.id), [b.id]);
      for (const access of [undefined, { agentId: otherAgent, principalId: principals[0] }]) {
        const detached = new PostgresTaskStore(sql, { ownerAgent: agentId, listAccess: () => access });
        assert.deepEqual((await detached.listTasks({})).tasks, []);
      }
      const second = await rpc(0, 'ListTasks', { pageSize: 1, pageToken: '1' }, true);
      const secondBody = await second.json() as { result: { tasks: Task[] } };
      assert.notEqual(secondBody.result.tasks[0]!.id, lists[0]!.body.result.tasks[0]!.id);
    });

    await t.test('cancel, continuation, stream replay, push config reject before mutation', async () => {
      const before = await sql`SELECT * FROM infra.a2a_tasks WHERE owner_agent=${agentId} ORDER BY task_id`;
      const count = assignments.length;
      for (const method of ['tasks/cancel', 'tasks/resubscribe', 'tasks/pushNotificationConfig/get',
        'tasks/pushNotificationConfig/list', 'tasks/pushNotificationConfig/delete']) {
        await denied(await rpc(1, method, { id: working.id, pushNotificationConfigId: b.id }));
      }
      await denied(await rpc(1, 'tasks/pushNotificationConfig/set', { taskId: a.id, id: b.id,
        pushNotificationConfig: { url: 'https://example.invalid' } }));
      for (const method of ['GetTaskPushNotificationConfig', 'DeleteTaskPushNotificationConfig',
        'CreateTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs', 'tasks/pushNotificationConfig/get']) {
        await denied(await rpc(1, method, { id: b.id, taskId: a.id, url: 'https://example.invalid' }, true));
      }
      for (const method of ['message/send', 'message/stream', 'SendMessage', 'SendStreamingMessage']) {
        await denied(await rpc(1, method, { message: { taskId: resumable.id, messageId: randomUUID(),
          role: 'user', parts: [{ kind: 'text', text: 'try to continue' }] } }, !method.includes('/')));
      }
      for (const [verb, suffix] of [['POST', ':cancel'], ['POST', ':subscribe'], ['POST', '/pushNotificationConfigs'],
        ['GET', '/pushNotificationConfigs'], ['DELETE', '/pushNotificationConfigs/config']]) {
        await denied(await app.request(`/agents/${agentId}/v1/tasks/${working.id}${suffix}`,
          { method: verb, headers: headers(1), ...(verb === 'POST' ? { body: '{}' } : {}) }));
      }
      for (const action of ['send', 'stream']) {
        await denied(await app.request(`/agents/${agentId}/v1/message:${action}`, { method: 'POST', headers: headers(1),
          body: JSON.stringify({ message: { taskId: resumable.id, messageId: randomUUID(), role: 'user', parts: [{ text: 'resume' }] } }) }));
      }
      assert.equal(assignments.length, count);
      assert.deepEqual(await sql`SELECT * FROM infra.a2a_tasks WHERE owner_agent=${agentId} ORDER BY task_id`, before);
      const resumed = await send(3, 'resume-context', resumable.id);
      assert.equal(resumed.id, resumable.id);
      const replay = await rpc(0, 'tasks/resubscribe', { id: a.id });
      assert.equal(replay.status, 200);
      assert.match(await replay.text(), /private-response/);
    });

    await t.test('SDK JSON-RPC clients receive TaskNotFoundError and matching request IDs', async () => {
      for (const v1 of [false, true]) {
        const path = `/agents/${agentId}${v1 ? '/v1' : ''}`;
        const card = await (await app.request(`${path}/.well-known/agent-card.json`)).json() as AgentCardV03 | AgentCardV10;
        const client = new A2XClient(card, {
          fetch: async (input, init) => app.request(new Request(input, init)),
          headers: headers(1), extensions: [SIWE_BEARER_AUTH_EXTENSION_URI],
        });
        await assert.rejects(client.getTask(a.id), TaskNotFoundError);
        await assert.rejects(client.getTask(randomUUID()), TaskNotFoundError);
        const response = await app.request(path, { method: 'POST', headers: headers(1),
          body: JSON.stringify({ jsonrpc: '2.0', id: 'read-correlation',
            method: v1 ? 'GetTask' : 'tasks/get', params: { id: a.id } }) });
        assert.equal(response.status, 200);
        assert.equal((await response.json() as { id: string }).id, 'read-correlation');
      }
    });

    await t.test('SDK HTTP+JSON clients receive TaskNotFoundError for hidden and missing tasks', async () => {
      const card = await (await app.request(`/agents/${agentId}/v1/.well-known/agent-card.json`)).json() as AgentCardV10;
      const client = new A2XClient(card, {
        fetch: async (input, init) => app.request(new Request(input, init)),
        headers: headers(1), extensions: [SIWE_BEARER_AUTH_EXTENSION_URI],
        preferredTransports: ['HTTP+JSON'],
      });
      for (const id of [a.id, randomUUID()]) {
        await assert.rejects(client.getTask(id), TaskNotFoundError);
        await assert.rejects(client.cancelTask(id), TaskNotFoundError);
        await assert.rejects(client.getTaskPushNotificationConfig(id, 'config'), TaskNotFoundError);
        await assert.rejects(async () => {
          for await (const event of client.subscribeTask(id)) assert.fail(JSON.stringify(event));
        }, TaskNotFoundError);
        const response = await app.request(`/agents/${agentId}/v1/tasks/${id}`, { headers: headers(1) });
        assert.equal(response.status, 404);
        const body = await response.json() as { error: { details: { reason: string; metadata: { data: string } }[] } };
        assert.equal(body.error.details[0]!.reason, 'TASK_NOT_FOUND');
        assert.ok(JSON.parse(body.error.details[0]!.metadata.data).rejectionId);
      }
    });

    await t.test('missing or pruned continuation IDs create new tasks in every message binding', async () => {
      const pruned = await store.createTask({ contextId: 'pruned', metadata: { _principalId: principals[0] } });
      await sql`DELETE FROM infra.a2a_tasks WHERE task_id=${pruned.id}`;
      for (const v1 of [false, true]) {
        for (const streaming of [false, true]) {
          const count = assignments.length;
          const response = await rpc(0,
            v1 ? (streaming ? 'SendStreamingMessage' : 'SendMessage') : (streaming ? 'message/stream' : 'message/send'),
            { message: { taskId: pruned.id, messageId: randomUUID(), role: 'user', parts: [{ text: 'new task' }] },
              configuration: { blocking: true, returnImmediately: false } }, v1);
          assert.equal(response.status, 200);
          await response.text();
          assert.equal(assignments.length, count + 1);
          assert.notEqual(assignments.at(-1)!.taskId, pruned.id);
        }
      }
      for (const action of ['send', 'stream']) {
        const count = assignments.length;
        const missingId = randomUUID();
        const response = await app.request(`/agents/${agentId}/v1/message:${action}`, {
          method: 'POST', headers: headers(0), body: JSON.stringify({
            message: { taskId: missingId, messageId: randomUUID(), role: 'user', parts: [{ text: 'new task' }] },
            configuration: { returnImmediately: false },
          }),
        });
        assert.equal(response.status, 200);
        await response.text();
        assert.equal(assignments.length, count + 1);
        assert.notEqual(assignments.at(-1)!.taskId, missingId);
      }
    });

    await t.test('rejection IDs correlate with a task access log event', async () => {
      const logs: string[] = [];
      const mock = t.mock.method(console, 'log', (line: string) => { logs.push(line); });
      try {
        const response = await rpc(1, 'tasks/get', { id: a.id });
        const body = await response.json() as { error: { data: { rejectionId: string } } };
        const entry = logs.map(line => JSON.parse(line)).find(entry => entry.rejectionId === body.error.data.rejectionId);
        assert.equal(entry.event, 'task_operation_rejected');
        assert.equal(entry.agentId, agentId);
        assert.equal(entry.reason, 'task_not_accessible');
      } finally { mock.mock.restore(); }
    });

    await t.test('HTTP IDs are decoded once and invalid encoding is a protocol error', async () => {
      const literalId = `literal%41-${randomUUID()}`;
      await sql`UPDATE infra.a2a_tasks SET task_id=${literalId}, task_json=jsonb_set(task_json, '{id}', to_jsonb(${literalId}::text))
        WHERE task_id=${different.id}`;
      const response = await app.request(`/agents/${agentId}/v1/tasks/${encodeURIComponent(literalId)}`, { headers: headers(0) });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json() as Task).id, literalId);
      await denied(await app.request(`/agents/${agentId}/v1/tasks/${encodeURIComponent(literalId)}`, { headers: headers(1) }));
      const malformed = await app.request(`/agents/${agentId}/v1/tasks/bad%ZZ`, { headers: headers(0) });
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json() as { error: { status: string } }).error.status, 'INVALID_ARGUMENT');
    });

    await t.test('HTTP query cannot replace the authorized path task', async () => {
      const r = await app.request(`/agents/${agentId}/v1/tasks/${b.id}?id=${a.id}`, { headers: headers(1) });
      assert.equal(r.status, 200);
      assert.equal((await r.json() as Task).id, b.id);
    });

    await t.test('HTTP message binding uses the transport carrier despite extra params', async () => {
      for (const action of ['send', 'stream']) {
        const count = assignments.length;
        const response = await app.request(`/agents/${agentId}/v1/message:${action}`, {
          method: 'POST', headers: headers(1), body: JSON.stringify({
            params: { message: { messageId: randomUUID(), role: 'user', parts: [{ text: 'unused wrapper' }] } },
            message: { messageId: randomUUID(), role: 'user', parts: [{ text: 'binding regression' }],
              metadata: { _principalId: principals[0] } },
            metadata: { _principalId: principals[0] },
            configuration: { returnImmediately: false },
          }),
        });
        assert.equal(response.status, 200, await response.clone().text());
        await response.text();
        assert.equal(assignments.length, count + 1);
        const assignment = assignments.at(-1)!;
        assert.equal(assignment.executionScope?.principalId, principals[1]);
        const rows = await sql`SELECT owner_principal FROM infra.a2a_tasks WHERE task_id=${assignment.taskId}`;
        assert.equal(rows[0]!.owner_principal, principals[1]);
      }
    });

    await t.test('fresh handler caches and host mode keep the ownership boundary', async () => {
      useCallerRuntime = false;
      app = buildApp();
      await denied(await rpc(1, 'tasks/get', { id: a.id }));
      assert.equal((await rpc(0, 'tasks/get', { id: a.id })).status, 200);
      const hostTask = await send(0, 'host-context');
      await denied(await rpc(1, 'tasks/get', { id: hostTask.id }));
    });

    await t.test('public transition hides private/legacy tasks; newly public tasks remain shared', async () => {
      publicAgent = true;
      app = buildApp();
      await denied(await rpc(undefined, 'tasks/get', { id: a.id }));
      await denied(await rpc(undefined, 'tasks/get', { id: legacy.id }));
      const publicTask = await send(undefined, 'public-context');
      assert.equal((await rpc(undefined, 'tasks/get', { id: publicTask.id })).status, 200);
      for (const caller of [undefined, 0]) {
        for (const list of [
          await rpc(caller, 'ListTasks', { contextId: 'public-context', historyLength: 10 }, true),
          await rpc(caller, 'tasks/list', {}, true),
          await app.request(`/agents/${agentId}/v1/tasks?contextId=public-context&historyLength=10`, { headers: headers(caller) }),
        ]) {
          assert.equal(list.status, 403);
          const body = await list.text();
          assert.match(body, /Anonymous task listing is not allowed/);
          assert.ok(!body.includes(publicTask.id));
        }
      }
      publicAgent = false;
      app = buildApp();
      await denied(await rpc(0, 'tasks/get', { id: publicTask.id }));
    });
  } finally {
    await sql`DELETE FROM infra.a2a_tasks WHERE owner_agent IN (${agentId}, ${otherAgent})`;
    for (const token of issued) await sql`DELETE FROM callers WHERE id=${token.callerId}`;
    await sql.end();
  }
});
