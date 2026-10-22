// Server-written dispatch marker (Task.metadata[APPROVAL_EXTENSION_URI]) used
// to correlate an approval's executionId with tasks/get after stream loss.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { WebSocket } from 'ws';
import { TaskState, type Task } from '@a2x/sdk';
import { APPROVAL_EXTENSION_URI, TASK_REPLAY_CAPABILITY, REMOTE_APPROVAL_CAPABILITY,
  type DownFrame, type TaskAssignFrame } from '@vicoop-bridge/protocol';
import { createHttpApp } from './http.js';
import { ensureSchema } from './db.js';
import { Registry, type TaskBinding } from './registry.js';
import { approvalStatus } from './tool-approvals.js';
import { executionMarker, executionWriter, withExecutionMarker, type ExecutionWriter } from './execution-marker.js';
import { PostgresTaskStore } from './postgres-task-store.js';

test('withExecutionMarker replaces only the marker key', () => {
  assert.deepEqual(withExecutionMarker({ a: 1, [APPROVAL_EXTENSION_URI]: { executionId: 'old', x: 1 } }, 'new'),
    { a: 1, [APPROVAL_EXTENSION_URI]: { executionId: 'new' } });
  assert.deepEqual(withExecutionMarker({ a: 1, [APPROVAL_EXTENSION_URI]: { executionId: 'old' } }, undefined), { a: 1 });
  assert.equal(withExecutionMarker({ [APPROVAL_EXTENSION_URI]: { executionId: 'old' } }, undefined), undefined);
  assert.equal(executionMarker({ [APPROVAL_EXTENSION_URI]: { executionId: 7 } }), undefined);
});

test('dispatch marker: persisted before dispatch, survives unbind, replaced per execution, stale writes skipped',
  { skip: !process.env.DATABASE_URL }, async (t) => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
  await ensureSchema(sql);
  const agentId = `execution-marker-${randomUUID()}`;
  const sent: DownFrame[] = [];
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  const registry = new Registry();
  const connect = (capabilities: string[]) => assert.deepEqual(registry.registerAgent({
    agentId, clientId: `${agentId}-client`, ownerPrincipal: 'owner',
    agentCard: { name: agentId, description: 'marker test', version: '1', protocolVersion: '0.3.0', capabilities: { streaming: true }, skills: [] },
    allowedCallers: [], protocolCapabilities: capabilities, connectedAt: Date.now(),
    ws: { readyState: 1, OPEN: 1, close() {}, send(raw: string) { sent.push(JSON.parse(raw) as DownFrame); } } as unknown as WebSocket,
  }), { ok: true });
  connect([TASK_REPLAY_CAPABILITY, REMOTE_APPROVAL_CAPABILITY]);
  const app = createHttpApp({ registry, db: sql, publicUrl: 'http://localhost' });
  const open: Array<{ binding: TaskBinding; response: Promise<Response> }> = [];
  t.after(async () => {
    for (const { binding, response } of open) {
      if (registry.getBinding(binding.taskId) === binding) settle(binding, 'completed');
      await response;
    }
    console.log = originalLog;
    await sql`DELETE FROM infra.a2a_tasks WHERE owner_agent = ${agentId}`;
    await sql.end();
  });

  const rpc = (method: string, params: unknown) => app.request(`/agents/${encodeURIComponent(agentId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  async function getTask(id: string): Promise<Task> {
    const body = await (await rpc('tasks/get', { id })).json() as { result?: Task };
    assert.ok(body.result, JSON.stringify(body));
    return body.result;
  }
  const marker = (task: Task) => executionMarker(task.metadata as Record<string, unknown> | undefined);
  async function dispatch(opts: { taskId?: string; metadata?: Record<string, unknown> } = {}) {
    const start = sent.length;
    const response = Promise.resolve(rpc('message/send', {
      message: { messageId: randomUUID(), role: 'user', parts: [{ kind: 'text', text: 'work' }],
        ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}) },
      ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
      configuration: { blocking: true } }));
    let assign: TaskAssignFrame | undefined;
    for (let i = 0; i < 200 && !assign; i++) {
      assign = sent.slice(start).find((f): f is TaskAssignFrame => f.type === 'task.assign');
      if (!assign) await new Promise(r => setTimeout(r, 5));
    }
    assert.ok(assign, 'task.assign not sent');
    const binding = registry.getBinding(assign.taskId)!;
    assert.ok(binding);
    open.push({ binding, response });
    return { assign, binding, response };
  }
  function settle(binding: TaskBinding, state: 'completed' | 'input-required', text = 'result') {
    binding.sink.pushArtifact({ taskId: binding.taskId, contextId: binding.contextId,
      artifact: { artifactId: `artifact-${binding.executionId ?? 'legacy'}`, parts: [{ kind: 'text', text }] } } as never);
    binding.sink.pushStatus({ taskId: binding.taskId, contextId: binding.contextId, final: true,
      status: { state, timestamp: new Date().toISOString() } } as never);
    binding.sink.finish();
  }
  const resultOf = async (response: Response | Promise<Response>) => {
    const body = await (await response).json() as { result?: Task };
    assert.ok(body.result, JSON.stringify(body));
    return body.result;
  };

  await t.test('initial and terminal tasks/get carry the execution marker; caller value is overridden', async () => {
    const forged = { [APPROVAL_EXTENSION_URI]: { executionId: 'forged' }, unrelated: 'kept' };
    const { assign, binding, response } = await dispatch({ metadata: forged });
    assert.ok(assign.executionId);
    const initial = await getTask(assign.taskId);
    assert.equal(marker(initial), assign.executionId);
    assert.equal((initial.metadata as Record<string, unknown>).unrelated, 'kept');
    // The approval status names the same server-owned executionId.
    const approval = registry.approvals.request(binding, { requestId: randomUUID(), toolName: 'Bash',
      input: { command: 'echo hi' }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(approvalStatus(approval).message.metadata[APPROVAL_EXTENSION_URI].executionId, assign.executionId);
    registry.approvals.received(binding, approval.requestId, 'deny');
    settle(binding, 'completed', 'original-result');
    const sendResult = await resultOf(response);
    assert.equal(marker(sendResult), assign.executionId);
    // After native completion/unbind, tasks/get still recovers the original result.
    assert.equal(registry.getBinding(assign.taskId), undefined);
    const terminal = await getTask(assign.taskId);
    assert.equal(terminal.status.state, 'completed');
    assert.equal(marker(terminal), assign.executionId);
    assert.equal((terminal.metadata as Record<string, unknown>).unrelated, 'kept');
    assert.ok(JSON.stringify(terminal.artifacts).includes('original-result'));
  });

  const state = (task: Task) => task.status.state as string;
  const texts = (task: Task) => JSON.stringify(task.artifacts ?? []);
  const statusText = (task: Task) => JSON.stringify(task.status.message?.parts ?? []);
  function chunk(binding: TaskBinding, artifactId: string, text: string, append = false) {
    binding.sink.pushArtifact({ taskId: binding.taskId, contextId: binding.contextId, append,
      artifact: { artifactId, parts: [{ kind: 'text', text }] } } as never);
  }
  async function suspend(binding: TaskBinding) {
    const approval = registry.approvals.request(binding, { requestId: randomUUID(), toolName: 'Bash',
      input: {}, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    binding.sink.pushStatus({ taskId: binding.taskId, contextId: binding.contextId, final: false,
      status: approvalStatus(approval) } as never);
    for (let i = 0; i < 100 && state(await getTask(binding.taskId)) !== 'auth-required'; i++) {
      await new Promise(r => setTimeout(r, 5));
    }
    assert.equal(state(await getTask(binding.taskId)), 'auth-required');
    return approval;
  }
  const skipLogged = (reason: string, executionId: string | null) => logs.some(l =>
    l.includes('"event":"task_store_stale_execution_write"') && l.includes(`"reason":"${reason}"`)
    && l.includes(`"executionId":${executionId === null ? 'null' : `"${executionId}"`}`));

  await t.test('a new execution on the same task ID: marker replaced, stale writes skipped, output exclusive', async () => {
    const first = await dispatch({ metadata: { unrelated: 'kept' } });
    const taskId = first.assign.taskId;
    const oldExecution = first.assign.executionId!;
    chunk(first.binding, 'shared', 'x-partial');
    const approval = await suspend(first.binding);
    assert.ok(texts(await getTask(taskId)).includes('x-partial'));

    // Same (anonymous) caller continues the same task ID: a new execution.
    // A caller-supplied marker naming the old execution is ignored.
    const second = await dispatch({ taskId, metadata: { [APPROVAL_EXTENSION_URI]: { executionId: oldExecution } } });
    const newExecution = second.assign.executionId!;
    assert.equal(second.assign.taskId, taskId);
    assert.notEqual(newExecution, oldExecution);
    // Reset atomically with the marker: no old status/output under the new ID.
    const during = await getTask(taskId);
    assert.equal(marker(during), newExecution);
    assert.equal(state(during), 'working');
    assert.equal(during.artifacts, undefined);
    assert.equal((during.metadata as Record<string, unknown>).unrelated, 'kept');

    // The superseded caller still learns its own outcome, labelled as its own
    // execution, but that outcome was not persisted.
    const oldResult = await resultOf(first.response);
    assert.equal(state(oldResult), 'failed');
    assert.match(statusText(oldResult), /superseded/);
    assert.equal(marker(oldResult), oldExecution);
    assert.ok(texts(oldResult).includes('x-partial'));
    assert.ok(skipLogged('superseded', oldExecution));
    const afterOld = await getTask(taskId);
    assert.equal(state(afterOld), 'working');
    assert.equal(marker(afterOld), newExecution);
    assert.equal(registry.approvals.get(approval.requestId), undefined);

    // Reusing the artifact ID must not append to the old execution's chunk.
    chunk(second.binding, 'shared', 'y-out', true);
    settle(second.binding, 'completed', 'y-final');
    const newResult = await resultOf(second.response);
    assert.equal(marker(newResult), newExecution);
    const terminal = await getTask(taskId);
    assert.equal(state(terminal), 'completed');
    assert.equal(marker(terminal), newExecution);
    assert.notEqual(marker(terminal), approval.executionId);
    assert.ok(texts(terminal).includes('y-out') && texts(terminal).includes('y-final'));
    assert.ok(!texts(terminal).includes('x-partial'), texts(terminal));
    assert.equal(terminal.artifacts?.filter(a => a.artifactId === 'shared').length, 1);
    // Conversation history is retained across executions.
    assert.ok((terminal.history ?? []).filter(m => m.role === 'user').length >= 2);
    assert.equal((terminal.metadata as Record<string, unknown>).unrelated, 'kept');
  });

  await t.test('a no-output execution on a reused task ID persists no artifacts', async () => {
    const first = await dispatch();
    settle(first.binding, 'input-required', 'question');
    await resultOf(first.response);
    assert.ok(texts(await getTask(first.assign.taskId)).includes('question'));
    const second = await dispatch({ taskId: first.assign.taskId });
    second.binding.sink.pushStatus({ taskId: second.binding.taskId, contextId: second.binding.contextId, final: true,
      status: { state: 'completed', timestamp: new Date().toISOString() } } as never);
    second.binding.sink.finish();
    const result = await resultOf(second.response);
    assert.equal(result.artifacts, undefined);
    const terminal = await getTask(first.assign.taskId);
    assert.equal(state(terminal), 'completed');
    assert.equal(marker(terminal), second.assign.executionId);
    assert.equal(terminal.artifacts, undefined);
  });

  await t.test('a dispatch without replay capability clears the stale marker', async () => {
    const first = await dispatch({ metadata: { unrelated: 'kept' } });
    const taskId = first.assign.taskId;
    settle(first.binding, 'input-required', 'question');
    await resultOf(first.response);
    assert.equal(marker(await getTask(taskId)), first.assign.executionId);
    registry.getAgent(agentId)!.protocolCapabilities = [];
    try {
      const second = await dispatch({ taskId });
      assert.equal(second.assign.executionId, undefined);
      assert.equal(marker(await getTask(taskId)), undefined);
      settle(second.binding, 'completed', 'legacy-out');
      await resultOf(second.response);
      const terminal = await getTask(taskId);
      assert.equal(state(terminal), 'completed');
      assert.equal(marker(terminal), undefined);
      // Legacy dispatches keep the pre-existing artifact accumulation.
      assert.ok(texts(terminal).includes('question'), texts(terminal));
      assert.ok(texts(terminal).includes('legacy-out'), texts(terminal));
      assert.equal((terminal.metadata as Record<string, unknown>).unrelated, 'kept');
    } finally { registry.getAgent(agentId)!.protocolCapabilities = [TASK_REPLAY_CAPABILITY, REMOTE_APPROVAL_CAPABILITY]; }
  });

  await t.test('a superseded legacy (non-replay) execution cannot overwrite a newer replay execution', async () => {
    registry.getAgent(agentId)!.protocolCapabilities = [];
    let legacy: Awaited<ReturnType<typeof dispatch>>;
    try {
      legacy = await dispatch();
      assert.equal(legacy.assign.executionId, undefined);
      chunk(legacy.binding, 'legacy', 'legacy-partial');
    } finally { registry.getAgent(agentId)!.protocolCapabilities = [TASK_REPLAY_CAPABILITY, REMOTE_APPROVAL_CAPABILITY]; }
    const taskId = legacy.assign.taskId;
    const replay = await dispatch({ taskId });
    assert.ok(replay.assign.executionId);
    const legacyResult = await resultOf(legacy.response);
    assert.equal(state(legacyResult), 'failed');
    assert.equal(marker(legacyResult), undefined);
    assert.ok(skipLogged('superseded', null));
    const during = await getTask(taskId);
    assert.equal(state(during), 'working');
    assert.equal(marker(during), replay.assign.executionId);
    assert.equal(during.artifacts, undefined);
    settle(replay.binding, 'completed', 'replay-out');
    await resultOf(replay.response);
    const terminal = await getTask(taskId);
    assert.equal(state(terminal), 'completed');
    assert.equal(marker(terminal), replay.assign.executionId);
    assert.ok(!texts(terminal).includes('legacy-partial'));
  });

  await t.test('a request that fails before dispatch cannot relabel the live execution', async () => {
    const live = await dispatch();
    const taskId = live.assign.taskId;
    const liveExecution = live.assign.executionId!;
    await suspend(live.binding);
    const original = PostgresTaskStore.prototype.markExecution;
    PostgresTaskStore.prototype.markExecution = async () => { throw new Error('injected marker failure'); };
    let rejected: Task;
    try {
      rejected = await resultOf(rpc('message/send', { message: { messageId: randomUUID(), role: 'user',
        parts: [{ kind: 'text', text: 'retry' }], taskId }, configuration: { blocking: true } }));
    } finally { PostgresTaskStore.prototype.markExecution = original; }
    assert.equal(state(rejected), 'failed');
    assert.match(statusText(rejected), /could not be recorded/);
    assert.equal(marker(rejected), undefined);
    assert.ok(skipLogged('not_dispatched', null));
    // Neither the SDK's pre-execute save nor the failure was persisted.
    const stored = await getTask(taskId);
    assert.equal(state(stored), 'auth-required');
    assert.equal(marker(stored), liveExecution);
    assert.equal(registry.getBinding(taskId), live.binding);
    settle(live.binding, 'completed', 'live-out');
    await resultOf(live.response);
    const terminal = await getTask(taskId);
    assert.equal(state(terminal), 'completed');
    assert.equal(marker(terminal), liveExecution);
    assert.ok(texts(terminal).includes('live-out'));
  });

  await t.test('a rejected ownership check does not take over the marker', async () => {
    const first = await dispatch();
    const taskId = first.assign.taskId;
    settle(first.binding, 'input-required', 'question');
    await resultOf(first.response);
    const foreign: TaskBinding = { agentId: `${agentId}-foreign`, taskId, contextId: 'ctx',
      sink: { pushStatus() {}, pushArtifact() {}, finish() {} } };
    registry.bindTask(foreign);
    try {
      const rejected = await resultOf(rpc('message/send', { message: { messageId: randomUUID(), role: 'user',
        parts: [{ kind: 'text', text: 'continue' }], taskId }, configuration: { blocking: true } }));
      assert.match(statusText(rejected), /ownership validation failed/);
      const stored = await getTask(taskId);
      assert.equal(state(stored), 'input-required');
      assert.equal(marker(stored), first.assign.executionId);
      assert.equal(registry.getBinding(taskId), foreign);
    } finally { registry.unbindTask(taskId, foreign); }
  });

  await t.test('tasks/cancel (not a message request) still persists on a dispatched task', async () => {
    const live = await dispatch();
    const canceled = await (await rpc('tasks/cancel', { id: live.assign.taskId })).json() as { result?: Task };
    assert.equal(canceled.result?.status.state, 'canceled', JSON.stringify(canceled));
    await resultOf(live.response);
    const stored = await getTask(live.assign.taskId);
    assert.equal(state(stored), 'canceled');
    assert.equal(marker(stored), live.assign.executionId);
  });

  type WireEvent = Record<string, unknown>;
  // Normalizes v0.3 (`kind`/lowercase) and v1 (`statusUpdate`/TASK_STATE_*) events.
  const wireState = (e: WireEvent): string | undefined => {
    const status = (e.status ?? (e.statusUpdate as WireEvent | undefined)?.status) as { state?: string } | undefined;
    return status?.state?.replace(/^TASK_STATE_/, '').toLowerCase().replace(/_/g, '-');
  };
  const wireUpdate = (e: WireEvent) => (e.statusUpdate ?? e) as {
    final?: boolean; metadata?: Record<string, { executionId?: string }>;
    status: { message?: { metadata?: Record<string, { executionId?: string; requestId?: string }> } } };
  function sseReader(response: Response) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events: WireEvent[] = [];
    return {
      reader, events,
      async until(predicate: (e: WireEvent) => boolean): Promise<WireEvent> {
        for (;;) {
          const found = events.find(predicate);
          if (found) return found;
          const { value, done } = await reader.read();
          assert.ok(!done, `stream ended early: ${JSON.stringify(events)}`);
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
            if (!data) continue;
            const parsed = JSON.parse(data) as WireEvent;
            events.push((parsed.jsonrpc ? parsed.result : parsed) as WireEvent);
          }
        }
      },
      async rest(): Promise<void> {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
        }
        for (const frame of buffer.split('\n\n')) {
          const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
          if (data) { const parsed = JSON.parse(data) as WireEvent; events.push((parsed.jsonrpc ? parsed.result : parsed) as WireEvent); }
        }
        reader.releaseLock();
      },
    };
  }
  const message = (text: string) => ({ messageId: randomUUID(), role: 'user', parts: [{ kind: 'text', text }] });
  const streams: Record<string, () => Promise<Response>> = {
    'jsonrpc-v0.3': () => Promise.resolve(rpc('message/stream', { message: message('stream') })),
    'jsonrpc-v1': () => Promise.resolve(app.request(`/agents/${encodeURIComponent(agentId)}/v1`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendStreamingMessage',
        params: { message: { messageId: randomUUID(), role: 'user', parts: [{ text: 'stream' }] } } }) })),
    'http-json-v1': () => Promise.resolve(app.request(`/agents/${encodeURIComponent(agentId)}/v1/message:stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({ message: { messageId: randomUUID(), role: 'user', parts: [{ text: 'stream' }] } }) })),
  };
  async function startStream(transport: string) {
    const start = sent.length;
    const response = await streams[transport]!();
    assert.equal(response.status, 200, response.status === 200 ? '' : await response.text());
    assert.match(response.headers.get('Content-Type') ?? '', /text\/event-stream/);
    const sse = sseReader(response);
    // Read as a client does: HTTP+JSON sends an initial task snapshot first,
    // and the bounded body only advances the execution as it is read.
    const auth = sse.until(e => wireState(e) === 'auth-required');
    let assign: TaskAssignFrame | undefined;
    for (let i = 0; i < 200 && !assign; i++) {
      assign = sent.slice(start).find((f): f is TaskAssignFrame => f.type === 'task.assign');
      if (!assign) await new Promise(r => setTimeout(r, 5));
    }
    assert.ok(assign?.executionId);
    const binding = registry.getBinding(assign.taskId)!;
    const approval = registry.approvals.request(binding, { requestId: randomUUID(), toolName: 'Bash',
      input: { command: 'echo wire' }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    binding.sink.pushStatus({ taskId: binding.taskId, contextId: binding.contextId, final: false,
      status: approvalStatus(approval) } as never);
    const authEvent = wireUpdate(await auth);
    assert.equal(authEvent.status.message?.metadata?.[APPROVAL_EXTENSION_URI]?.executionId, assign.executionId);
    assert.equal(authEvent.status.message?.metadata?.[APPROVAL_EXTENSION_URI]?.requestId, approval.requestId);
    assert.equal(authEvent.metadata?.[APPROVAL_EXTENSION_URI]?.executionId, assign.executionId);
    return { sse, assign, binding, approval, authEvent };
  }
  // The client consumes the decision and the native execution resumes.
  function resume(binding: TaskBinding, approval: { requestId: string }, text: string) {
    assert.ok(registry.approvals.received(binding, approval.requestId, 'allow_once'));
    binding.sink.pushStatus({ taskId: binding.taskId, contextId: binding.contextId, final: false,
      status: { state: 'working', timestamp: new Date().toISOString() } } as never);
    settle(binding, 'completed', text);
  }
  async function unbound(taskId: string) {
    for (let i = 0; i < 200 && registry.getBinding(taskId); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(registry.getBinding(taskId), undefined);
  }

  await t.test('v0.3 SSE (unpatched SDK): auth-required arrives final:true yet the same stream carries working and completed', async () => {
    const detachedBefore = logs.filter(l => l.includes('"event":"stream_detached"')).length;
    const { sse, assign, binding, approval, authEvent } = await startStream('jsonrpc-v0.3');
    assert.equal((sse.events.find(e => wireState(e) === 'auth-required') as { kind?: string }).kind, 'status-update');
    // The SDK marks every auth-required status final; the bridge keeps the
    // physical stream open regardless (documented in tool-approval-v1.md).
    assert.equal(authEvent.final, true);
    assert.equal(registry.approvals.decide(approval.requestId, 'allow_once', 'owner')?.state, 'decided');
    resume(binding, approval, 'stream-out');
    await sse.rest();
    const states = sse.events.map(e => wireState(e) ?? e.kind);
    assert.deepEqual(states, ['auth-required', 'working', 'artifact-update', 'completed']);
    const completed = wireUpdate(sse.events.find(e => wireState(e) === 'completed')!);
    assert.equal(completed.final, true);
    assert.equal(completed.metadata?.[APPROVAL_EXTENSION_URI]?.executionId, assign.executionId);
    await unbound(assign.taskId);
    const terminal = await getTask(assign.taskId) as Task & { kind?: string };
    assert.equal(terminal.kind, 'task');
    assert.equal(state(terminal), 'completed');
    assert.equal(marker(terminal), assign.executionId);
    assert.ok(texts(terminal).includes('stream-out'));
    // A stream read to its end never detaches.
    assert.equal(logs.filter(l => l.includes('"event":"stream_detached"')).length, detachedBefore);
  });

  for (const transport of Object.keys(streams)) {
    await t.test(`${transport}: client disconnect after the approval event does not end the execution`, async () => {
      const { sse, assign, binding, approval } = await startStream(transport);
      await sse.reader.cancel();
      await new Promise(r => setTimeout(r, 30));
      // Still the same live execution with a decidable approval.
      assert.equal(registry.getBinding(assign.taskId), binding);
      assert.equal(registry.approvals.get(approval.requestId)?.state, 'pending');
      assert.ok(logs.some(l => l.includes('"event":"stream_detached"') && l.includes(`"transport":"${transport}"`)));
      const resolves = sent.filter(f => f.type === 'approval.resolve').length;
      assert.equal(registry.approvals.decide(approval.requestId, 'allow_once', 'owner')?.state, 'decided');
      assert.equal(registry.approvals.decide(approval.requestId, 'deny', 'owner'), undefined);
      assert.equal(sent.filter(f => f.type === 'approval.resolve').length, resolves + 1);
      resume(binding, approval, `${transport}-out`);
      // The detached drain keeps the SDK/executor persisting to the terminal.
      await unbound(assign.taskId);
      assert.equal(registry.approvals.get(approval.requestId), undefined);
      const terminal = await getTask(assign.taskId);
      assert.equal(state(terminal), 'completed');
      assert.equal(marker(terminal), assign.executionId);
      assert.ok(texts(terminal).includes(`${transport}-out`));
      assert.ok(logs.some(l => l.includes('"event":"stream_detached_drained"') && l.includes(`"transport":"${transport}"`)));
    });
  }
});

test('task store write rules: holderless and fresh-task writes persist; dispatched rows are guarded',
  { skip: !process.env.DATABASE_URL }, async (t) => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
  await ensureSchema(sql);
  const ownerAgent = `execution-store-${randomUUID()}`;
  const store = new PostgresTaskStore(sql, { ownerAgent });
  const originalLog = console.log;
  console.log = () => {};
  t.after(async () => {
    console.log = originalLog;
    await sql`DELETE FROM infra.a2a_tasks WHERE owner_agent = ${ownerAgent}`;
    await sql.end();
  });
  const failed = { state: TaskState.FAILED, timestamp: new Date().toISOString() };
  // A fresh, never-dispatched task: an unmarked message request (e.g. a
  // payment halt or scope rejection) still persists its outcome.
  const fresh = await store.createTask({ contextId: randomUUID() });
  await executionWriter.run({ message: true }, () => store.updateTask(fresh.id, { status: failed }));
  assert.equal((await store.getTask(fresh.id))?.status.state, 'failed');

  const task = await store.createTask({ contextId: randomUUID(), metadata: { keep: 1 } });
  const owner: ExecutionWriter = {};
  await executionWriter.run(owner, () => store.markExecution(task.id, 'exec-1', [
    { artifactId: 'a', parts: [{ text: 'own' }] }]));
  assert.deepEqual({ ...owner, artifacts: undefined }, { message: true, marked: true, dispatchId: 'exec-1',
    executionId: 'exec-1', artifacts: undefined });
  // Payment halt / scope rejection from another message request: skipped.
  const halt = await executionWriter.run({ message: true }, () => store.updateTask(task.id, {
    status: { state: TaskState.INPUT_REQUIRED, timestamp: new Date().toISOString() } }));
  assert.equal(halt.status.state, 'input-required');
  assert.equal(executionMarker(halt.metadata as Record<string, unknown>), undefined);
  assert.equal((await store.getTask(task.id))?.status.state, 'working');
  // The owning request persists its own artifacts, not the SDK's merge.
  await executionWriter.run(owner, () => store.updateTask(task.id, { status: { state: TaskState.COMPLETED,
    timestamp: new Date().toISOString() }, artifacts: [{ artifactId: 'old', parts: [{ text: 'stale' }] }] }));
  const stored = await store.getTask(task.id);
  assert.equal(stored?.status.state, 'completed');
  assert.deepEqual(stored?.artifacts?.map(a => a.artifactId), ['a']);
  assert.equal(executionMarker(stored?.metadata as Record<string, unknown>), 'exec-1');
  assert.equal((stored?.metadata as Record<string, unknown>).keep, 1);
  // A legacy (non-replay) dispatch keeps accumulated artifacts and still
  // takes the private dispatch slot: the replay writer above is now stale.
  const legacy: ExecutionWriter = {};
  await executionWriter.run(legacy, () => store.markExecution(task.id, undefined, []));
  assert.equal(legacy.artifacts, undefined);
  const afterLegacyMark = await store.getTask(task.id);
  assert.deepEqual(afterLegacyMark?.artifacts?.map(a => a.artifactId), ['a']);
  assert.equal(executionMarker(afterLegacyMark?.metadata as Record<string, unknown>), undefined);
  await executionWriter.run(legacy, () => store.updateTask(task.id, {
    artifacts: [{ artifactId: 'a', parts: [{ text: 'own' }] }, { artifactId: 'b', parts: [{ text: 'more' }] }] }));
  assert.deepEqual((await store.getTask(task.id))?.artifacts?.map(a => a.artifactId), ['a', 'b']);
  await executionWriter.run(owner, () => store.updateTask(task.id, { status: failed }));
  assert.equal((await store.getTask(task.id))?.status.state, 'working');
  // Holderless writers (admin, maintenance) are unaffected.
  await store.updateTask(task.id, { status: failed });
  assert.equal((await store.getTask(task.id))?.status.state, 'failed');
  assert.equal(executionMarker((await store.getTask(task.id))?.metadata as Record<string, unknown>), undefined);
});
