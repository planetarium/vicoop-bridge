import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import postgres from 'postgres';
import { TaskState } from '@a2x/sdk';
import { createHttpApp } from './http.js';
import { ensureSchema } from './db.js';
import { Registry } from './registry.js';
import { issueSessionToken } from './auth/caller-token.js';
import { PostgresTaskStore } from './postgres-task-store.js';

test('admin agent task access is bound to the requesting operator (issue #519)',
  { skip: !process.env.DATABASE_URL }, async (t) => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
  const principals = [0, 1].map(() => `eth:0x${randomUUID().replaceAll('-', '')}00000000`);
  const issued: Awaited<ReturnType<typeof issueSessionToken>>[] = [];
  const taskIds: string[] = [];
  const app = createHttpApp({ registry: new Registry(), db: sql, publicUrl: 'http://localhost' });
  const post = (caller: number | undefined, body: string) => app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
      ...(caller === undefined ? {} : { Authorization: `Bearer ${issued[caller]!.rawToken}` }) },
    body,
  });
  const rpc = (caller: number | undefined, method: string, params: unknown) =>
    post(caller, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  async function denied(response: Response) {
    assert.equal(response.status, 200, await response.clone().text());
    const text = await response.text();
    assert.ok(!text.includes('private-admin'), text);
    const body = JSON.parse(text);
    assert.equal(body.id, 1);
    assert.equal(body.error?.code, -32001, text);
    assert.equal(body.result, undefined);
  }
  try {
    await ensureSchema(sql);
    for (const principalId of principals) {
      issued.push(await issueSessionToken(sql, { principalId, provider: 'siwe', audience: 'owner_session' }));
    }
    const store = new PostgresTaskStore(sql, { ownerAgent: 'admin' });
    const ownerMetadata = { _principalId: principals[0] };
    const completed = await store.createTask({ contextId: `admin-${randomUUID()}`, metadata: ownerMetadata });
    await store.updateTask(completed.id, { status: { state: TaskState.COMPLETED, message: {
      messageId: randomUUID(), role: 'agent', parts: [{ text: 'private-admin-output' }] } } });
    const working = await store.createTask({ contextId: `admin-${randomUUID()}`, metadata: ownerMetadata });
    await store.updateTask(working.id, { status: { state: TaskState.WORKING } });
    taskIds.push(completed.id, working.id);

    await t.test('another operator cannot read, cancel, or continue the task', async () => {
      await denied(await rpc(1, 'tasks/get', { id: completed.id }));
      await denied(await rpc(1, 'tasks/cancel', { id: working.id }));
      assert.equal((await store.getTask(working.id))?.status.state, TaskState.WORKING);
      await denied(await rpc(1, 'message/send', { message: { messageId: randomUUID(), role: 'user',
        kind: 'message', parts: [{ kind: 'text', text: 'hijack' }], taskId: working.id,
        contextId: working.contextId } }));
      assert.equal((await store.getTask(working.id))?.status.state, TaskState.WORKING);
    });

    await t.test('another operator cannot enumerate the task', async () => {
      const response = await rpc(1, 'tasks/list', {});
      const text = await response.text();
      for (const id of taskIds) assert.ok(!text.includes(id), text);
    });

    await t.test('the owning operator keeps access', async () => {
      const response = await rpc(0, 'tasks/get', { id: completed.id });
      const body = await response.json() as { result?: { id: string } };
      assert.equal(body.result?.id, completed.id, JSON.stringify(body));
    });

    await t.test('malformed and non-object bodies get JSON-RPC errors, not 500', async () => {
      const malformed = await post(1, '{not json');
      assert.notEqual(malformed.status, 500);
      assert.equal((await malformed.json() as { error: { code: number } }).error.code, -32700);
      for (const body of ['[]', '1', 'null', '"x"']) {
        const response = await post(1, body);
        assert.notEqual(response.status, 500, body);
        assert.equal((await response.json() as { error: { code: number } }).error.code, -32600, body);
      }
    });

    await t.test('unauthenticated requests are still rejected', async () => {
      assert.equal((await rpc(undefined, 'tasks/get', { id: completed.id })).status, 401);
    });
  } finally {
    if (taskIds.length > 0) await sql`DELETE FROM infra.a2a_tasks WHERE owner_agent = 'admin' AND task_id IN ${sql(taskIds)}`;
    for (const token of issued) await sql`DELETE FROM callers WHERE id=${token.callerId}`;
    await sql.end();
  }
});
