import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import postgres from 'postgres';
import type { WebSocket } from 'ws';
import { TaskState, type Task } from '@a2x/sdk';
import { SIWE_BEARER_AUTH_EXTENSION_URI, type DownFrame } from '@vicoop-bridge/protocol';
import { createHttpApp } from './http.js';
import { ensureSchema } from './db.js';
import { Registry } from './registry.js';
import { issueSessionToken } from './auth/caller-token.js';

// The published 0.25.0 SDK intentionally does not pass this acceptance test.
// Enable against a local fixed SDK or its eventual release; remove the opt-in
// when the dependency is bumped to the published nonblocking-send fix.
test('nonblocking send retains ownership, partial files, and a single execution across lookups', {
  skip: !process.env.DATABASE_URL || process.env.A2A_TEST_NONBLOCKING !== '1',
}, async (t) => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
  await ensureSchema(sql);
  const agentId = `nonblocking-${randomUUID()}`;
  const principals = [0, 1].map(() => `eth:0x${randomUUID().replaceAll('-', '')}00000000`);
  const issued = await Promise.all(principals.map(principalId =>
    issueSessionToken(sql, { principalId, provider: 'siwe', audience: 'caller' })));
  const frames: DownFrame[] = [];
  const registry = new Registry();
  registry.registerAgent({ agentId, clientId: agentId, ownerPrincipal: principals[1]!,
    agentCard: { name: agentId, description: 'Nonblocking acceptance test', version: '1', protocolVersion: '0.3.0', capabilities: { streaming: true } },
    allowedCallers: principals, protocolCapabilities: ['task-replay-v1'], connectedAt: Date.now(),
    ws: { close() {}, send(raw: string) { frames.push(JSON.parse(raw)); } } as unknown as WebSocket });
  const app = createHttpApp({ registry, db: sql, publicUrl: 'http://localhost' });
  const headers = (caller = 0) => ({ 'Content-Type': 'application/json',
    'A2A-Extensions': SIWE_BEARER_AUTH_EXTENSION_URI, Authorization: `Bearer ${issued[caller]!.rawToken}` });
  const rpc = (method: string, params: unknown, caller = 0, v1 = false) =>
    app.request(`/agents/${agentId}${v1 ? '/v1' : ''}`, {
      method: 'POST', headers: headers(caller), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  const get = async (id: string) => {
    const body = await (await rpc('tasks/get', { id })).json() as { result?: Task };
    assert.ok(body.result, JSON.stringify(body));
    return body.result;
  };
  const waitFor = async (predicate: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('expected persisted transition');
  };
  t.after(async () => {
    for (const frame of frames) if (frame.type === 'task.assign') {
      const binding = registry.getBinding(frame.taskId);
      if (binding) {
        binding.sink.pushStatus({ taskId: frame.taskId, contextId: frame.contextId, final: true,
          status: { state: TaskState.CANCELED } });
        binding.sink.finish();
      }
    }
    await waitFor(async () => frames.every(frame => frame.type !== 'task.assign' || !registry.getBinding(frame.taskId)));
    await sql`DELETE FROM infra.a2a_tasks WHERE owner_agent=${agentId}`;
    await sql`DELETE FROM callers WHERE principal_id = ANY(${principals})`;
    await sql.end();
  });

  for (const [transport, terminal] of [['v03', 'completed'], ['v1-rpc', 'canceled'],
    ['v1-http', 'completed'], ['v03', 'failed']] as const) {
    await t.test(`${transport}: ${terminal}`, async () => {
      const before = frames.filter(frame => frame.type === 'task.assign').length;
      const message = { messageId: randomUUID(), role: transport === 'v03' ? 'user' : 'ROLE_USER',
        parts: [{ text: 'prepare private files' }], metadata: { _principalId: principals[1] } };
      const params = { message, metadata: { _principalId: principals[1] },
        configuration: transport === 'v03' ? { blocking: false } : { returnImmediately: true } };
      const sending = transport === 'v1-http'
        ? app.request(`/agents/${agentId}/v1/message:send`, { method: 'POST', headers: headers(), body: JSON.stringify(params) })
        : rpc(transport === 'v03' ? 'message/send' : 'SendMessage', params, 0, transport !== 'v03');
      const response = await Promise.race([sending, new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('send did not acknowledge before backend completion')), 2000);
        timer.unref();
      })]);
      const body = await response.json() as { result?: Task; task?: Task };
      const task = transport === 'v1-http' ? body.task : body.result;
      assert.ok(task?.id, JSON.stringify(body));
      const id = task.id;
      assert.equal((await get(id)).status.state, TaskState.WORKING);
      const owner = await sql`SELECT owner_principal FROM infra.a2a_tasks WHERE task_id=${id}`;
      assert.equal(owner[0]?.owner_principal, principals[0]);
      const denied = await (await rpc('tasks/get', { id }, 1)).json() as { error?: { code: number }; result?: unknown };
      assert.equal(denied.error?.code, -32001); assert.equal(denied.result, undefined);
      await waitFor(async () => !!registry.getBinding(id));
      const binding = registry.getBinding(id)!;
      const bytes = Buffer.from(`private bytes ${transport}`).toString('base64');
      binding.sink.pushArtifact({ taskId: id, contextId: task.contextId!, artifact: { artifactId: 'file',
        parts: [{ raw: bytes, filename: 'result.txt', mediaType: 'text/plain' }] } });
      await waitFor(async () => (await get(id)).artifacts?.length === 1);
      const partial = await get(id);
      const part = partial.artifacts![0]!.parts[0] as unknown as { file: { bytes: string } };
      assert.equal(part.file.bytes, bytes);
      assert.equal(partial.status.state, TaskState.WORKING);
      if (terminal === 'canceled') {
        await rpc('tasks/cancel', { id });
        await waitFor(async () => (await get(id)).status.state === TaskState.CANCELED);
      } else {
        binding.sink.pushStatus({ taskId: id, contextId: task.contextId!, final: true,
          status: { state: terminal === 'failed' ? TaskState.FAILED : TaskState.COMPLETED } });
        binding.sink.finish();
        await waitFor(async () => (await get(id)).status.state === terminal);
      }
      assert.equal(frames.filter(frame => frame.type === 'task.assign').length, before + 1);
      assert.equal((await get(id)).artifacts?.length, 1);
    });
  }
});
