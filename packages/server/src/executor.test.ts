import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import {
  TaskState,
  type Artifact,
  type Message,
  type Task,
  type TaskStatusUpdateEvent,
} from '@a2x/sdk';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  parseDownFrame,
  type AgentCard,
} from '@vicoop-bridge/protocol';
import { Registry, type ClientConnection } from './registry.js';
import type { ContextAwareTaskStore } from './postgres-task-store.js';
import {
  WSForwardingExecutor,
  appendHistoryMessage,
  stripInternalMetadata,
} from './executor.js';

// Issue #128 (B): the /agents/:id route stashes the verified caller's
// principalId on `message.metadata._principalId`. The executor must (1)
// thread that into the task binding so accept-path logs in ws.ts include
// it, and (2) strip the `_`-prefixed keys before the WS frame leaves the
// bridge so the connected client never sees server-internal caller
// identity over the wire.

function makeAgentCard(): AgentCard {
  return {
    name: 't',
    version: '0',
    protocolVersion: '0.3.0',
  };
}

function noopTaskStore(): ContextAwareTaskStore {
  // The strip/binding behavior under test runs before any taskStore call,
  // and the test pushes a terminal status so the executor's persistence
  // path (taskStore.updateTask) only fires after assertions land — stubs
  // are sufficient. `loadByContextId` returns [] — these tests are not
  // delta requests, so the stateful-context reconstruction never fires.
  return {
    save: async () => {},
    load: async () => undefined,
    updateTask: async () => {},
    loadByContextId: async () => [],
  } as unknown as ContextAwareTaskStore;
}

function captureTaskStore(): ContextAwareTaskStore & { updates: unknown[] } {
  const updates: unknown[] = [];
  return {
    updates,
    save: async () => {},
    load: async () => undefined,
    updateTask: async (_taskId: string, update: unknown) => {
      updates.push(update);
    },
    loadByContextId: async () => [],
  } as unknown as ContextAwareTaskStore & { updates: unknown[] };
}

function makeWsCapture(): { ws: WebSocket; sent: string[] } {
  const sent: string[] = [];
  const ws = {
    close: () => undefined,
    send: (data: string | Buffer) =>
      sent.push(typeof data === 'string' ? data : data.toString('utf-8')),
  } as unknown as WebSocket;
  return { ws, sent };
}

test('stripInternalMetadata drops underscore-prefixed keys', () => {
  assert.deepEqual(stripInternalMetadata({ _principalId: 'eth:0xabc', foo: 'bar' }), {
    foo: 'bar',
  });
});

test('stripInternalMetadata returns undefined when only `_*` keys present', () => {
  // Important: undefined (not {}) so the executor can spread it conditionally
  // and keep the WS frame's `metadata` field absent — matching the wire shape
  // for messages that had no metadata in the first place.
  assert.equal(stripInternalMetadata({ _principalId: 'eth:0xabc' }), undefined);
});

test('stripInternalMetadata returns undefined for undefined input', () => {
  assert.equal(stripInternalMetadata(undefined), undefined);
});

test('stripInternalMetadata preserves a regular metadata object as-is', () => {
  assert.deepEqual(stripInternalMetadata({ keepMe: 1, nested: { x: 2 } }), {
    keepMe: 1,
    nested: { x: 2 },
  });
});

test('appendHistoryMessage appends messages once by messageId', () => {
  const first = {
    role: 'user',
    parts: [{ kind: 'text', text: 'hi' }],
    messageId: 'm-1',
  } as unknown as Message;
  const duplicate = {
    role: 'user',
    parts: [{ kind: 'text', text: 'hi again' }],
    messageId: 'm-1',
  } as unknown as Message;
  const second = {
    role: 'agent',
    parts: [{ text: 'done' }],
    messageId: 'm-2',
  } as unknown as Message;

  const withFirst = appendHistoryMessage([], first);
  const withDuplicate = appendHistoryMessage(withFirst, duplicate);
  const withSecond = appendHistoryMessage(withDuplicate, second);

  assert.deepEqual(withSecond.map((m) => m.messageId), ['m-1', 'm-2']);
});

test('executor records principalId in binding and strips _principalId from outgoing WS frame', async () => {
  const { ws, sent } = makeWsCapture();
  const registry = new Registry();
  const conn: ClientConnection = {
    agentId: 'a1',
    clientId: 'c1',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeAgentCard(),
    allowedCallers: [],
    ws,
    connectedAt: 0,
  };
  registry.registerAgent(conn);

  const executor = new WSForwardingExecutor('a1', registry, noopTaskStore());
  const task = {
    id: 't-1',
    contextId: 'ctx-1',
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
  } as unknown as Task;
  const message = {
    role: 'user',
    parts: [{ kind: 'text', text: 'hi' }],
    messageId: 'm-1',
    metadata: { _principalId: 'eth:0xabc', userField: 'keep' },
  } as unknown as Message;

  const gen = executor.executeStream(task, message);
  // Kick the generator so executeStream reaches the bindTask + sendToAgent
  // calls (both run before the first `yield`).
  const firstEvent = gen.next();

  const binding = registry.getBinding('t-1');
  assert.ok(binding, 'expected binding to be registered before first yield');
  assert.equal(binding.principalId, 'eth:0xabc');
  assert.equal(binding.agentId, 'a1');

  // The WS frame must NOT carry server-internal `_*` keys — the connected
  // client should only see caller-supplied metadata.
  assert.equal(sent.length, 1, 'expected exactly one task.assign frame');
  const frame = parseDownFrame(sent[0]!);
  assert.equal(frame.type, 'task.assign');
  if (frame.type === 'task.assign') {
    const md = frame.message.metadata;
    assert.ok(md, 'expected non-underscore metadata to survive');
    assert.equal(
      (md as Record<string, unknown>)._principalId,
      undefined,
      '_principalId must be stripped before the WS frame leaves the bridge',
    );
    assert.equal((md as Record<string, unknown>).userField, 'keep');
  }

  // Push a terminal status so the generator returns without hanging.
  binding.sink.pushStatus({
    taskId: 't-1',
    contextId: 'ctx-1',
    final: true,
    status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
  });
  binding.sink.finish();
  await firstEvent;
  for await (const _event of gen) void _event;
});

test('executor omits message.metadata entirely when the only entry was _principalId', async () => {
  // Wire-compat guarantee: a message that had no caller-visible metadata
  // before injection must look identical on the wire after stripping. A
  // present-but-empty `metadata: {}` would surprise clients that rely on
  // `metadata === undefined` as a "no metadata" sentinel.
  const { ws, sent } = makeWsCapture();
  const registry = new Registry();
  registry.registerAgent({
    agentId: 'a2',
    clientId: 'c2',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeAgentCard(),
    allowedCallers: [],
    ws,
    connectedAt: 0,
  });
  const executor = new WSForwardingExecutor('a2', registry, noopTaskStore());
  const task = {
    id: 't-2',
    contextId: 'ctx-2',
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
  } as unknown as Task;
  const message = {
    role: 'user',
    parts: [{ kind: 'text', text: 'hi' }],
    messageId: 'm-2',
    metadata: { _principalId: 'eth:0xabc' },
  } as unknown as Message;

  const gen = executor.executeStream(task, message);
  const firstEvent = gen.next();

  const frame = parseDownFrame(sent[0]!);
  assert.equal(frame.type, 'task.assign');
  if (frame.type === 'task.assign') {
    assert.equal(frame.message.metadata, undefined);
  }

  const binding = registry.getBinding('t-2')!;
  binding.sink.pushStatus({
    taskId: 't-2',
    contextId: 'ctx-2',
    final: true,
    status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
  });
  binding.sink.finish();
  await firstEvent;
  for await (const _event of gen) void _event;
});

test('executor binding has no principalId when message metadata is absent', async () => {
  // Public-agent path: no auth middleware, no _principalId injection. The
  // binding's principalId stays undefined and downstream ws.ts log lines
  // omit the field — confirms the additive change doesn't accidentally
  // stamp a placeholder.
  const { ws, sent } = makeWsCapture();
  const registry = new Registry();
  registry.registerAgent({
    agentId: 'a3',
    clientId: 'c3',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeAgentCard(),
    allowedCallers: [],
    ws,
    connectedAt: 0,
  });
  const executor = new WSForwardingExecutor('a3', registry, noopTaskStore());
  const task = {
    id: 't-3',
    contextId: 'ctx-3',
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
  } as unknown as Task;
  const message = {
    role: 'user',
    parts: [{ kind: 'text', text: 'hi' }],
    messageId: 'm-3',
  } as unknown as Message;

  const gen = executor.executeStream(task, message);
  const firstEvent = gen.next();

  const binding = registry.getBinding('t-3');
  assert.ok(binding);
  assert.equal(binding.principalId, undefined);

  // Frame still goes out, metadata absent.
  const frame = parseDownFrame(sent[0]!);
  assert.equal(frame.type, 'task.assign');
  if (frame.type === 'task.assign') {
    assert.equal(frame.message.metadata, undefined);
  }

  binding.sink.pushStatus({
    taskId: 't-3',
    contextId: 'ctx-3',
    final: true,
    status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
  });
  binding.sink.finish();
  await firstEvent;
  for await (const _event of gen) void _event;
});

test('executor persists inbound and agent status messages in task history', async () => {
  const { ws } = makeWsCapture();
  const registry = new Registry();
  registry.registerAgent({
    agentId: 'a4',
    clientId: 'c4',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeAgentCard(),
    allowedCallers: [],
    ws,
    connectedAt: 0,
  });
  const taskStore = captureTaskStore();
  const executor = new WSForwardingExecutor('a4', registry, taskStore);
  const task = {
    id: 't-4',
    contextId: 'ctx-4',
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
  } as unknown as Task;
  const message = {
    role: 'user',
    parts: [{ kind: 'text', text: 'hi' }],
    messageId: 'm-4',
  } as unknown as Message;

  const gen = executor.executeStream(task, message);
  const firstEvent = gen.next();
  const binding = registry.getBinding('t-4')!;

  binding.sink.pushStatus({
    taskId: 't-4',
    contextId: 'ctx-4',
    final: false,
    status: {
      state: TaskState.WORKING,
      timestamp: new Date().toISOString(),
      message: {
        role: 'agent',
        parts: [{ text: 'working' }],
        messageId: 'agent-working',
        taskId: 't-4',
        contextId: 'ctx-4',
      },
    },
  });
  binding.sink.pushStatus({
    taskId: 't-4',
    contextId: 'ctx-4',
    final: true,
    status: {
      state: TaskState.COMPLETED,
      timestamp: new Date().toISOString(),
      message: {
        role: 'agent',
        parts: [{ text: 'done' }],
        messageId: 'agent-done',
        taskId: 't-4',
        contextId: 'ctx-4',
      },
    },
  });
  binding.sink.finish();

  await firstEvent;
  for await (const _event of gen) void _event;

  const update = taskStore.updates.at(-1) as { history?: Message[] };
  assert.deepEqual(
    update.history?.map((m) => m.messageId),
    ['m-4', 'agent-working', 'agent-done'],
  );
  assert.deepEqual(
    task.history?.map((m) => m.messageId),
    ['m-4', 'agent-working', 'agent-done'],
  );
});

test('executor merges appended artifact chunks before persisting task artifacts', async () => {
  const { ws } = makeWsCapture();
  const registry = new Registry();
  registry.registerAgent({
    agentId: 'a-artifact',
    clientId: 'c-artifact',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeAgentCard(),
    allowedCallers: [],
    ws,
    connectedAt: 0,
  });
  const taskStore = captureTaskStore();
  const executor = new WSForwardingExecutor('a-artifact', registry, taskStore);
  const task = {
    id: 't-artifact',
    contextId: 'ctx-artifact',
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
  } as unknown as Task;
  const message = {
    role: 'user',
    parts: [{ kind: 'text', text: 'hi' }],
    messageId: 'm-artifact',
  } as unknown as Message;

  const gen = executor.executeStream(task, message);
  const firstEvent = gen.next();
  const binding = registry.getBinding('t-artifact')!;

  binding.sink.pushArtifact({
    taskId: 't-artifact',
    contextId: 'ctx-artifact',
    append: true,
    artifact: { artifactId: 'response', parts: [{ text: 'one' }] },
  });
  binding.sink.pushArtifact({
    taskId: 't-artifact',
    contextId: 'ctx-artifact',
    append: true,
    artifact: { artifactId: 'response', parts: [{ text: ' two' }] },
  });
  binding.sink.pushStatus({
    taskId: 't-artifact',
    contextId: 'ctx-artifact',
    final: true,
    status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
  });
  binding.sink.finish();

  await firstEvent;
  for await (const _event of gen) void _event;

  assert.equal(task.artifacts?.length, 1);
  assert.deepEqual(task.artifacts?.[0]?.parts, [{ text: 'one two' }]);
  const update = taskStore.updates.at(-1) as { artifacts?: Artifact[] };
  assert.deepEqual(update.artifacts?.[0]?.parts, [{ text: 'one two' }]);
});

test('executor persists history when agent is unreachable', async () => {
  const registry = new Registry();
  const taskStore = captureTaskStore();
  const executor = new WSForwardingExecutor('missing', registry, taskStore);
  const task = {
    id: 't-5',
    contextId: 'ctx-5',
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
  } as unknown as Task;
  const message = {
    role: 'user',
    parts: [{ kind: 'text', text: 'hi' }],
    messageId: 'm-5',
    extensions: [OPENAI_COMPAT_EXTENSION_URI],
  } as unknown as Message;

  const statuses: TaskStatusUpdateEvent[] = [];
  for await (const event of executor.executeStream(task, message)) {
    if ('status' in event) statuses.push(event);
  }

  const update = taskStore.updates.at(-1) as { history?: Message[] };
  assert.deepEqual(
    update.history?.map((m) => m.messageId),
    ['m-5', 't-5-unreach'],
  );
  assert.deepEqual(statuses[0]?.status.message?.metadata, {
    [OPENAI_COMPAT_EXTENSION_URI]: {
      terminal_error: {
        code: 'client_not_connected',
        message: 'client not connected',
      },
    },
    error: {
      code: 'client_not_connected',
      message: 'client not connected',
    },
  });
  assert.deepEqual(statuses[0]?.status.message?.extensions, [OPENAI_COMPAT_EXTENSION_URI]);
});

test('executor omits terminal error metadata when openai-compat extension was not requested', async () => {
  const registry = new Registry();
  const taskStore = captureTaskStore();
  const executor = new WSForwardingExecutor('missing', registry, taskStore);
  const task = {
    id: 't-plain',
    contextId: 'ctx-plain',
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
  } as unknown as Task;
  const message = {
    role: 'user',
    parts: [{ kind: 'text', text: 'hi' }],
    messageId: 'm-plain',
  } as unknown as Message;

  const statuses: TaskStatusUpdateEvent[] = [];
  for await (const event of executor.executeStream(task, message)) {
    if ('status' in event) statuses.push(event);
  }

  assert.equal(statuses[0]?.status.message?.metadata, undefined);
  assert.equal(statuses[0]?.status.message?.extensions, undefined);
});

// ---- Stateful-context delta reconstruction (#410) ----

type LoadCall = { contextId: string; principalId: string; excludeTaskId?: string };

function contextStore(prior: Task[]): ContextAwareTaskStore & { loadCalls: LoadCall[] } {
  const loadCalls: LoadCall[] = [];
  return {
    loadCalls,
    save: async () => {},
    load: async () => undefined,
    updateTask: async () => {},
    loadByContextId: async (contextId: string, principalId: string, excludeTaskId?: string) => {
      loadCalls.push({ contextId, principalId, excludeTaskId });
      return prior;
    },
  } as unknown as ContextAwareTaskStore & { loadCalls: LoadCall[] };
}

// Kick the generator to the first yield (bindTask + reconstruction + sendToAgent
// all run before it), then push a terminal status so it returns cleanly.
async function driveToAssign(
  executor: WSForwardingExecutor,
  registry: Registry,
  task: Task,
  message: Message,
): Promise<void> {
  const gen = executor.executeStream(task, message);
  const firstEvent = gen.next();
  const binding = registry.getBinding(task.id)!;
  binding.sink.pushStatus({
    taskId: task.id,
    contextId: task.contextId ?? task.id,
    final: true,
    status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
  });
  binding.sink.finish();
  await firstEvent;
  for await (const _event of gen) void _event;
}

function deltaMetadata(principalId: string): Record<string, unknown> {
  return {
    _principalId: principalId,
    [OPENAI_COMPAT_EXTENSION_URI]: { delta: true },
  };
}

test('executor reconstructs contextHistory for a delta request and ships it stripped', async () => {
  const { ws, sent } = makeWsCapture();
  const registry = new Registry();
  registry.registerAgent({
    agentId: 'a-delta',
    clientId: 'c',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeAgentCard(),
    allowedCallers: [],
    ws,
    connectedAt: 0,
  });
  // One prior task with two history turns, plus a terminal status.message that
  // is NOT already in history (must be appended, deduped by messageId). The
  // stored user turn still carries `_principalId`, which must be stripped
  // before it leaves the bridge.
  const prior: Task[] = [
    {
      id: 't-prev',
      contextId: 'ctx-d',
      status: {
        state: TaskState.COMPLETED,
        message: {
          role: 'agent',
          parts: [{ kind: 'text', text: 'reply 1' }],
          messageId: 'a-1',
        },
      },
      history: [
        {
          role: 'user',
          parts: [{ kind: 'text', text: 'turn 1' }],
          messageId: 'u-1',
          metadata: { _principalId: 'eth:0xabc', keep: 'me' },
        },
      ],
    } as unknown as Task,
  ];
  const taskStore = contextStore(prior);
  const executor = new WSForwardingExecutor('a-delta', registry, taskStore);
  const task = {
    id: 't-delta',
    contextId: 'ctx-d',
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
  } as unknown as Task;
  const message = {
    role: 'user',
    parts: [{ kind: 'text', text: 'turn 2' }],
    messageId: 'u-2',
    metadata: deltaMetadata('eth:0xabc'),
  } as unknown as Message;

  await driveToAssign(executor, registry, task, message);

  // Reconstruction ran, principal-scoped, excluding the current task.
  assert.deepEqual(taskStore.loadCalls, [
    { contextId: 'ctx-d', principalId: 'eth:0xabc', excludeTaskId: 't-delta' },
  ]);

  const frame = parseDownFrame(sent[0]!);
  if (frame.type !== 'task.assign') throw new Error('unreachable');
  assert.ok(frame.contextHistory, 'expected contextHistory on the frame');
  // history turn (u-1) + terminal status.message (a-1), oldest→newest.
  assert.deepEqual(frame.contextHistory!.map((m) => m.messageId), ['u-1', 'a-1']);
  // Internal `_`-prefixed metadata stripped; caller-visible key survives.
  const u1 = frame.contextHistory![0]!;
  assert.equal((u1.metadata as Record<string, unknown> | undefined)?._principalId, undefined);
  assert.equal((u1.metadata as Record<string, unknown> | undefined)?.keep, 'me');
});

test('executor does not reconstruct context history for a non-delta request', async () => {
  const { ws, sent } = makeWsCapture();
  const registry = new Registry();
  registry.registerAgent({
    agentId: 'a-full',
    clientId: 'c',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeAgentCard(),
    allowedCallers: [],
    ws,
    connectedAt: 0,
  });
  const taskStore = contextStore([{ id: 't-prev' } as unknown as Task]);
  const executor = new WSForwardingExecutor('a-full', registry, taskStore);
  const task = {
    id: 't-full',
    contextId: 'ctx-f',
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
  } as unknown as Task;
  // Full-replay: has a principal but NO delta marker → envelope carries history.
  const message = {
    role: 'user',
    parts: [{ kind: 'text', text: 'hi' }],
    messageId: 'u-f',
    metadata: { _principalId: 'eth:0xabc' },
  } as unknown as Message;

  await driveToAssign(executor, registry, task, message);

  assert.equal(taskStore.loadCalls.length, 0, 'loadByContextId must not run for full-replay');
  const frame = parseDownFrame(sent[0]!);
  if (frame.type !== 'task.assign') throw new Error('unreachable');
  assert.equal(frame.contextHistory, undefined);
});

test('executor skips reconstruction when a delta request has no principalId', async () => {
  const { ws, sent } = makeWsCapture();
  const registry = new Registry();
  registry.registerAgent({
    agentId: 'a-anon',
    clientId: 'c',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeAgentCard(),
    allowedCallers: [],
    ws,
    connectedAt: 0,
  });
  const taskStore = contextStore([{ id: 't-prev' } as unknown as Task]);
  const executor = new WSForwardingExecutor('a-anon', registry, taskStore);
  const task = {
    id: 't-anon',
    contextId: 'ctx-a',
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
  } as unknown as Task;
  const message = {
    role: 'user',
    parts: [{ kind: 'text', text: 'hi' }],
    messageId: 'u-a',
    // delta marker present but no `_principalId` — the load is principal-scoped,
    // so it must be skipped rather than run unscoped.
    metadata: { [OPENAI_COMPAT_EXTENSION_URI]: { delta: true } },
  } as unknown as Message;

  await driveToAssign(executor, registry, task, message);

  assert.equal(taskStore.loadCalls.length, 0);
  const frame = parseDownFrame(sent[0]!);
  if (frame.type !== 'task.assign') throw new Error('unreachable');
  assert.equal(frame.contextHistory, undefined);
});

test('executor omits contextHistory when a delta context has no prior turns', async () => {
  const { ws, sent } = makeWsCapture();
  const registry = new Registry();
  registry.registerAgent({
    agentId: 'a-fresh',
    clientId: 'c',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeAgentCard(),
    allowedCallers: [],
    ws,
    connectedAt: 0,
  });
  // Unknown/expired contextId → empty load → fresh context, no error, no field.
  const taskStore = contextStore([]);
  const executor = new WSForwardingExecutor('a-fresh', registry, taskStore);
  const task = {
    id: 't-fresh',
    contextId: 'ctx-fresh',
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
  } as unknown as Task;
  const message = {
    role: 'user',
    parts: [{ kind: 'text', text: 'hi' }],
    messageId: 'u-fresh',
    metadata: deltaMetadata('eth:0xabc'),
  } as unknown as Message;

  await driveToAssign(executor, registry, task, message);

  assert.equal(taskStore.loadCalls.length, 1);
  const frame = parseDownFrame(sent[0]!);
  if (frame.type !== 'task.assign') throw new Error('unreachable');
  assert.equal(frame.contextHistory, undefined);
});
