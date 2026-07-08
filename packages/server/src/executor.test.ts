import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import {
  TaskState,
  type Artifact,
  type Message,
  type Task,
  type TaskStatusUpdateEvent,
  type TaskStore,
} from '@a2x/sdk';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  parseDownFrame,
  type AgentCard,
} from '@vicoop-bridge/protocol';
import { Registry, type ClientConnection } from './registry.js';
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

function noopTaskStore(): TaskStore {
  // The strip/binding behavior under test runs before any taskStore call,
  // and the test pushes a terminal status so the executor's persistence
  // path (taskStore.updateTask) only fires after assertions land — stubs
  // are sufficient.
  return {
    save: async () => {},
    load: async () => undefined,
    updateTask: async () => {},
  } as unknown as TaskStore;
}

function captureTaskStore(): TaskStore & { updates: unknown[] } {
  const updates: unknown[] = [];
  return {
    updates,
    save: async () => {},
    load: async () => undefined,
    updateTask: async (_taskId: string, update: unknown) => {
      updates.push(update);
    },
  } as unknown as TaskStore & { updates: unknown[] };
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

test('executor inactivity watchdog closes a silent stream with a failed terminal', async () => {
  // A bound task that never receives a terminal frame (connected-but-silent
  // daemon, or any path that drops the terminal) must not hang forever: the
  // server-side inactivity backstop fabricates a `failed` terminal so the
  // stream closes and the binding is released.
  const { ws } = makeWsCapture();
  const registry = new Registry();
  registry.registerAgent({
    agentId: 'aw',
    clientId: 'cw',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeAgentCard(),
    allowedCallers: [],
    ws,
    connectedAt: 0,
  });
  // 25ms inactivity budget so the test is fast; no frame is ever pushed.
  const executor = new WSForwardingExecutor('aw', registry, noopTaskStore(), 25);
  const task = {
    id: 't-wd',
    contextId: 'ctx-wd',
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
  } as unknown as Task;
  const message = {
    role: 'user',
    parts: [{ kind: 'text', text: 'hi' }],
    messageId: 'm-wd',
  } as unknown as Message;

  const events: TaskStatusUpdateEvent[] = [];
  for await (const event of executor.executeStream(task, message)) {
    events.push(event as TaskStatusUpdateEvent);
  }

  assert.ok(events.length >= 1, 'expected at least the fabricated terminal event');
  const last = events[events.length - 1]!;
  assert.equal(last.final, true);
  assert.equal(last.status.state, TaskState.FAILED);
  assert.match(
    (last.status.message?.parts?.[0] as { text?: string } | undefined)?.text ?? '',
    /timed out/,
  );
  assert.equal(registry.getBinding('t-wd'), undefined, 'binding must be released');
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
