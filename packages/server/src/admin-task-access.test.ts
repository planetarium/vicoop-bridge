import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import postgres from 'postgres';
import { TaskState, type Task } from '@a2x/sdk';
import { createHttpApp } from './http.js';
import { ensureSchema } from './db.js';
import { Registry } from './registry.js';
import { issueSessionToken } from './auth/caller-token.js';
import { invalidateToolCache } from './schema-tools.js';

// Tasks are created through POST / itself so the test exercises the binding
// the endpoint actually writes, not one seeded behind its back.
test('admin agent task access is bound to the requesting operator (issue #519)',
  { skip: !process.env.DATABASE_URL }, async (t) => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
  const principals = [0, 1].map(() => `eth:0x${randomUUID().replaceAll('-', '')}00000000`);
  const [A, B] = [0, 1];
  const issued: Awaited<ReturnType<typeof issueSessionToken>>[] = [];
  const contexts: string[] = [];

  // Stand in for the Anthropic API. Each model call is recorded and held
  // until the test releases it, so a turn can be observed while in flight.
  const modelRequests: string[] = [];
  let holdModel: Promise<void> = Promise.resolve();
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY ??= 'test-key';
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // The executor introspects PostGraphile before every turn; an empty
    // schema is enough (same payload schema-tools.test.ts uses).
    if (url.endsWith('/graphql')) {
      return new Response(JSON.stringify({ data: { __schema: {
        queryType: { fields: [] }, mutationType: { fields: [] }, types: [] } } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (!url.includes('anthropic.com')) return originalFetch(input, init);
    modelRequests.push(typeof init?.body === 'string' ? init.body : '');
    await holdModel;
    return new Response(JSON.stringify({
      id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'admin-reply' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const app = createHttpApp({ registry: new Registry(), db: sql, publicUrl: 'http://localhost' });
  const post = (caller: number | undefined, body: string) => app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
      ...(caller === undefined ? {} : { Authorization: `Bearer ${issued[caller]!.rawToken}` }) },
    body,
  });
  const rpc = (caller: number | undefined, method: string, params: unknown) =>
    post(caller, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  // `forged` puts another principal in every internal-metadata slot a caller
  // can reach, on both carriers the SDK and the TaskStore read.
  const send = (caller: number, contextId: string, text: string,
    opts: { taskId?: string; forgedPrincipal?: string } = {}) => {
    const forged = opts.forgedPrincipal === undefined ? undefined : {
      _principalId: opts.forgedPrincipal, _email: 'forged@example.com',
      _authorizationProfile: 'forged', _actorId: 'forged',
    };
    return rpc(caller, 'message/send', {
      message: { kind: 'message', messageId: randomUUID(), role: 'user', contextId,
        ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
        parts: [{ kind: 'text', text }], ...(forged ? { metadata: forged } : {}) },
      ...(forged ? { metadata: forged } : {}),
    });
  };
  const newContext = () => { const id = `admin-${randomUUID()}`; contexts.push(id); return id; };
  const ownerOf = async (taskId: string) =>
    (await sql`SELECT owner_principal FROM infra.a2a_tasks WHERE owner_agent='admin' AND task_id=${taskId}`)[0]
      ?.owner_principal as string | null | undefined;
  async function result(response: Response): Promise<Task> {
    const body = await response.json() as { result?: Task; error?: unknown };
    assert.ok(body.result?.id, JSON.stringify(body));
    return body.result;
  }
  async function denied(response: Response) {
    assert.equal(response.status, 200, await response.clone().text());
    const text = await response.text();
    assert.ok(!text.includes('private-admin'), text);
    const body = JSON.parse(text);
    assert.equal(body.id, 1);
    assert.equal(body.error?.code, -32001, text);
    assert.equal(body.result, undefined);
  }
  async function waitForWorkingTask(contextId: string): Promise<string> {
    for (let i = 0; i < 200; i++) {
      const rows = await sql`SELECT task_id FROM infra.a2a_tasks WHERE owner_agent='admin'
        AND context_id=${contextId} AND task_json->'status'->>'state'='working'`;
      if (rows[0]) return rows[0].task_id as string;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no working admin task appeared in ${contextId}`);
  }

  try {
    await ensureSchema(sql);
    invalidateToolCache();
    for (const principalId of principals) {
      issued.push(await issueSessionToken(sql, { principalId, provider: 'siwe', audience: 'owner_session' }));
    }
    const victimContext = newContext();
    const completed = await result(await send(A, victimContext, 'private-admin-prompt'));
    assert.equal(completed.status.state, TaskState.COMPLETED, JSON.stringify(completed.status) + ' modelCalls=' + modelRequests.length);
    assert.equal(await ownerOf(completed.id), principals[A]);

    await t.test('another operator cannot read, cancel, or continue the task', async () => {
      await denied(await rpc(B, 'tasks/get', { id: completed.id }));
      await denied(await rpc(B, 'tasks/cancel', { id: completed.id }));
      await denied(await send(B, newContext(), 'hijack', { taskId: completed.id }));
    });

    await t.test('forged internal metadata cannot file a task under another operator', async () => {
      const before = modelRequests.length;
      const planted = await result(await send(B, victimContext, 'INJECTED-by-B',
        { forgedPrincipal: principals[A] }));
      assert.equal(await ownerOf(planted.id), principals[B]);
      await denied(await rpc(A, 'tasks/get', { id: planted.id }));
      assert.equal((await result(await rpc(B, 'tasks/get', { id: planted.id }))).id, planted.id);
      // B's prompt must not reach A's next turn in the shared context.
      await result(await send(A, victimContext, 'follow-up'));
      const victimTurn = modelRequests.slice(before + 1).join('\n');
      assert.ok(victimTurn.includes('follow-up'), victimTurn);
      assert.ok(!victimTurn.includes('INJECTED-by-B'), victimTurn);
      assert.ok(!victimTurn.includes('forged@example.com'), victimTurn);
    });

    await t.test('the owner can read and cancel a blocking message/send while it runs', async () => {
      let release!: () => void;
      holdModel = new Promise((r) => { release = r; });
      const context = newContext();
      const inFlight = send(A, context, 'long-running');
      try {
        const taskId = await waitForWorkingTask(context);
        assert.equal(await ownerOf(taskId), principals[A]);
        assert.equal((await result(await rpc(A, 'tasks/get', { id: taskId }))).id, taskId);
        await denied(await rpc(B, 'tasks/get', { id: taskId }));
        await denied(await rpc(B, 'tasks/cancel', { id: taskId }));
        const canceled = await result(await rpc(A, 'tasks/cancel', { id: taskId }));
        assert.equal(canceled.status.state, TaskState.CANCELED);
      } finally {
        release();
        holdModel = Promise.resolve();
        await (await inFlight).text();
      }
    });

    await t.test('the owning operator keeps access', async () => {
      assert.equal((await result(await rpc(A, 'tasks/get', { id: completed.id }))).id, completed.id);
    });

    await t.test('malformed and non-object bodies get JSON-RPC errors, not 500', async () => {
      const malformed = await post(B, '{not json');
      assert.notEqual(malformed.status, 500);
      assert.equal((await malformed.json() as { error: { code: number } }).error.code, -32700);
      for (const body of ['[]', '1', 'null', '"x"']) {
        const response = await post(B, body);
        assert.notEqual(response.status, 500, body);
        assert.equal((await response.json() as { error: { code: number } }).error.code, -32600, body);
      }
    });

    await t.test('unauthenticated requests are still rejected', async () => {
      assert.equal((await rpc(undefined, 'tasks/get', { id: completed.id })).status, 401);
    });
  } finally {
    globalThis.fetch = originalFetch;
    invalidateToolCache();
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    if (contexts.length > 0) {
      await sql`DELETE FROM infra.a2a_tasks WHERE owner_agent = 'admin' AND context_id IN ${sql(contexts)}`;
    }
    for (const token of issued) await sql`DELETE FROM callers WHERE id=${token.callerId}`;
    await sql.end();
  }
});
