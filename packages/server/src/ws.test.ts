import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import type { TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2x/sdk';
import {
  CALLER_CONTEXT_CAPABILITY,
  encodeFrame,
  OPENAI_COMPAT_EXTENSION_URI,
  parseDownFrame,
  PROTOCOL_VERSION,
  TASK_REPLAY_CAPABILITY,
} from '@vicoop-bridge/protocol';
import { Registry, type TaskSink } from './registry.js';
import { hashToken } from './token.js';
import { attachWsServer } from './ws.js';
import type { Sql } from './db.js';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function mockSql(): Sql {
  const fn = async () => [
    {
      id: 'agent-1',
      client_id: 'client-1',
      owner_principal: 'eth:0x0',
      allowed_callers: [],
    },
  ];
  return fn as unknown as Sql;
}

// Like mockSql, but the token lookup blocks on `gate` so a test can close the
// socket while authenticateAndRegister is mid-await (#364).
function gatedSql(gate: Promise<void>): Sql {
  const fn = async () => {
    await gate;
    return [
      {
        id: 'agent-1',
        client_id: 'client-1',
        owner_principal: 'eth:0x0',
        owner_email: null,
        allowed_callers: [],
      },
    ];
  };
  return fn as unknown as Sql;
}

function makeSink(): TaskSink & {
  statuses: TaskStatusUpdateEvent[];
  artifacts: TaskArtifactUpdateEvent[];
  finished: Promise<void>;
} {
  const statuses: TaskStatusUpdateEvent[] = [];
  const artifacts: TaskArtifactUpdateEvent[] = [];
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  return {
    statuses,
    artifacts,
    finished,
    pushStatus: (event) => statuses.push(event),
    pushArtifact: (event) => artifacts.push(event),
    finish: () => resolveFinished(),
  };
}

// `await sink.finished` on its own turns any regression that stops producing a
// terminal into an infinite hang: the runner reports nothing, and CI only goes
// red on job timeout. Bound every such wait.
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForAgent(registry: Registry, agentId: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!registry.getAgent(agentId)) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${agentId} registration`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('task.fail preserves backend error code and message on status message metadata', async () => {
  const server = createServer();
  const registry = new Registry();
  attachWsServer(server, { db: mockSql(), registry });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`);

  try {
    await once(ws, 'open');
    ws.send(encodeFrame({
      type: 'hello',
      version: PROTOCOL_VERSION,
      agentId: 'agent-1',
      token: 'token',
      protocolCapabilities: [CALLER_CONTEXT_CAPABILITY],
      agentCard: {
        name: 'agent',
        version: '0.0.0',
        protocolVersion: '0.3.0',
      },
    }));
    await waitForAgent(registry, 'agent-1');
    assert.deepEqual(registry.getAgent('agent-1')?.protocolCapabilities, [
      CALLER_CONTEXT_CAPABILITY,
    ]);

    const sink = makeSink();
    registry.bindTask({
      agentId: 'agent-1',
      taskId: 'task-1',
      contextId: 'ctx-1',
      sink,
      requestedExtensions: [OPENAI_COMPAT_EXTENSION_URI],
    });

    ws.send(encodeFrame({
      type: 'task.fail',
      taskId: 'task-1',
      error: {
        code: 'rate_limited',
        message: 'slow down',
      },
    }));

    await withTimeout(sink.finished, 5_000, 'the task terminal');

    assert.equal(sink.statuses.length, 1);
    const event = sink.statuses[0]!;
    assert.equal(event.final, true);
    assert.equal(event.taskId, 'task-1');
    assert.equal(event.contextId, 'ctx-1');
    assert.equal(event.status.state, 'failed');
    assert.deepEqual(event.status.message?.parts, [{ text: 'rate_limited: slow down' }]);
    assert.deepEqual(event.status.message?.metadata, {
      [OPENAI_COMPAT_EXTENSION_URI]: {
        terminal_error: {
          code: 'rate_limited',
          message: 'slow down',
        },
      },
      error: {
        code: 'rate_limited',
        message: 'slow down',
      },
    });
    assert.deepEqual(event.status.message?.extensions, [OPENAI_COMPAT_EXTENSION_URI]);
    assert.equal(registry.getBinding('task-1'), undefined);
  } finally {
    ws.close();
    await closeServer(server);
  }
});

test('a socket closing during async auth does not leave a zombie registration', async () => {
  const server = createServer();
  const registry = new Registry();
  let releaseAuth!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseAuth = resolve;
  });
  attachWsServer(server, { db: gatedSql(gate), registry });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`);

  try {
    await once(ws, 'open');
    ws.send(encodeFrame({
      type: 'hello',
      version: PROTOCOL_VERSION,
      agentId: 'agent-1',
      token: 'token',
      agentCard: {
        name: 'agent',
        version: '0.0.0',
        protocolVersion: '0.3.0',
      },
    }));

    // Let the server enter authenticateAndRegister and block on the gated
    // token lookup, then close the socket while auth is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 20));
    ws.close();
    await once(ws, 'close');

    // Wait for the *server-side* close handler to run — it fires shortly after
    // the client close and, with agentId still null, skips its own cleanup.
    // This ordering (close handler before auth resolves) is exactly what makes
    // the registration a zombie: nothing else will tear it down. Releasing auth
    // before this point would let the close handler observe a set agentId and
    // clean up normally, masking the bug.
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Release auth: registerAgent now runs against the already-dead socket.
    // The post-auth reconciliation must tear that entry back out.
    releaseAuth();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(registry.getAgent('agent-1'), undefined);
  } finally {
    await closeServer(server);
  }
});

test('task.status propagates frame metadata onto the top-level TaskStatusUpdateEvent.metadata (liveness heartbeat marker)', async () => {
  const server = createServer();
  const registry = new Registry();
  attachWsServer(server, { db: mockSql(), registry });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`);

  try {
    await once(ws, 'open');
    ws.send(encodeFrame({
      type: 'hello',
      version: PROTOCOL_VERSION,
      agentId: 'agent-1',
      token: 'token',
      agentCard: {
        name: 'agent',
        version: '0.0.0',
        protocolVersion: '0.3.0',
      },
    }));
    await waitForAgent(registry, 'agent-1');

    const sink = makeSink();
    registry.bindTask({
      agentId: 'agent-1',
      taskId: 'task-hb',
      contextId: 'ctx-hb',
      sink,
    });

    ws.send(encodeFrame({
      type: 'task.status',
      taskId: 'task-hb',
      status: { state: 'working', timestamp: '2026-06-18T00:00:00.000Z' },
      metadata: { [OPENAI_COMPAT_EXTENSION_URI]: { heartbeat: true } },
    }));

    // The status frame is non-terminal, so the sink never finishes — poll for
    // the pushed event instead.
    const deadline = Date.now() + 1_000;
    while (sink.statuses.length === 0) {
      assert.ok(Date.now() < deadline, 'timed out waiting for heartbeat status');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const event = sink.statuses[0]!;
    assert.equal(event.final, false);
    assert.equal(event.taskId, 'task-hb');
    assert.equal(event.contextId, 'ctx-hb');
    assert.equal(event.status.state, 'working');
    // Marker lands on the EVENT's top-level metadata (the surface the
    // oai2a2a codec reads), not on status.message.metadata.
    assert.deepEqual(event.metadata, {
      [OPENAI_COMPAT_EXTENSION_URI]: { heartbeat: true },
    });
    assert.equal(event.status.message, undefined);
  } finally {
    ws.close();
    await closeServer(server);
  }
});

test('task.complete log carries the forwarded heartbeat count, ignoring plain working statuses (issue #414 hop-2 instrumentation)', async () => {
  const server = createServer();
  const registry = new Registry();
  attachWsServer(server, { db: mockSql(), registry });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`);
  const events: Array<Record<string, unknown>> = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] !== 'string') return;
    try {
      const o = JSON.parse(args[0]) as Record<string, unknown>;
      if (o && typeof o === 'object' && 'event' in o) events.push(o);
    } catch {
      // non-JSON console output — ignore
    }
  };

  try {
    await once(ws, 'open');
    ws.send(encodeFrame({
      type: 'hello',
      version: PROTOCOL_VERSION,
      agentId: 'agent-1',
      token: 'token',
      agentCard: { name: 'agent', version: '0.0.0', protocolVersion: '0.3.0' },
    }));
    await waitForAgent(registry, 'agent-1');

    registry.bindTask({
      agentId: 'agent-1',
      taskId: 'task-hbc',
      contextId: 'ctx-hbc',
      sink: makeSink(),
    });

    const ts = '2026-06-18T00:00:00.000Z';
    const hbMeta = { [OPENAI_COMPAT_EXTENSION_URI]: { heartbeat: true } };
    // Two tagged heartbeats...
    ws.send(encodeFrame({ type: 'task.status', taskId: 'task-hbc', status: { state: 'working', timestamp: ts }, metadata: hbMeta }));
    ws.send(encodeFrame({ type: 'task.status', taskId: 'task-hbc', status: { state: 'working', timestamp: ts }, metadata: hbMeta }));
    // ...and a plain working status that must NOT be counted as a beat.
    ws.send(encodeFrame({ type: 'task.status', taskId: 'task-hbc', status: { state: 'working', timestamp: ts } }));
    ws.send(encodeFrame({ type: 'task.complete', taskId: 'task-hbc', status: { state: 'completed', timestamp: ts } }));

    const deadline = Date.now() + 1_000;
    let ev: Record<string, unknown> | undefined;
    while (!(ev = events.find((e) => e.event === 'task_completed' && e.taskId === 'task-hbc'))) {
      assert.ok(Date.now() < deadline, 'timed out waiting for task_completed');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(ev.heartbeatsForwarded, 2);
  } finally {
    console.log = origLog;
    ws.close();
    await closeServer(server);
  }
});

test('task.complete usage lands on the binding before the terminal status is delivered', async () => {
  // This is the billing input for the x402 `upto` scheme. The executor reads
  // it off the binding when it consumes the terminal event, so it has to be
  // set by the time that event is pushed — asserting it from inside the sink
  // is what pins that ordering.
  const server = createServer();
  const registry = new Registry();
  attachWsServer(server, { db: mockSql(), registry });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`);

  try {
    await once(ws, 'open');
    ws.send(encodeFrame({
      type: 'hello',
      version: PROTOCOL_VERSION,
      agentId: 'agent-1',
      token: 'token',
      agentCard: { name: 'agent', version: '0.0.0', protocolVersion: '0.3.0' },
    }));
    await waitForAgent(registry, 'agent-1');

    let usageAtTerminal: unknown;
    const binding = {
      agentId: 'agent-1',
      taskId: 'task-usage',
      contextId: 'ctx-usage',
      sink: {
        pushStatus: () => {
          usageAtTerminal = binding.usage;
        },
        pushArtifact: () => {},
        finish: () => {},
      },
    } as Parameters<Registry['bindTask']>[0];
    registry.bindTask(binding);

    ws.send(encodeFrame({
      type: 'task.complete',
      taskId: 'task-usage',
      status: { state: 'completed', timestamp: '2026-06-18T00:00:00.000Z' },
      usage: {
        promptTokens: 1000,
        completionTokens: 200,
        cachedInputTokens: 900,
        model: 'claude-sonnet-4',
      },
    }));

    const deadline = Date.now() + 1_000;
    while (usageAtTerminal === undefined) {
      assert.ok(Date.now() < deadline, 'timed out waiting for the terminal status');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(usageAtTerminal, {
      promptTokens: 1000,
      completionTokens: 200,
      cachedInputTokens: 900,
      model: 'claude-sonnet-4',
    });
  } finally {
    ws.close();
    await closeServer(server);
  }
});

test('a task.complete without usage leaves the binding unpriced rather than zeroed', async () => {
  // Absent must not be normalized into a zero anywhere along the path: the
  // two mean different things to the meter, and only one of them is free.
  const server = createServer();
  const registry = new Registry();
  attachWsServer(server, { db: mockSql(), registry });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`);

  try {
    await once(ws, 'open');
    ws.send(encodeFrame({
      type: 'hello',
      version: PROTOCOL_VERSION,
      agentId: 'agent-1',
      token: 'token',
      agentCard: { name: 'agent', version: '0.0.0', protocolVersion: '0.3.0' },
    }));
    await waitForAgent(registry, 'agent-1');

    let delivered = false;
    const binding = {
      agentId: 'agent-1',
      taskId: 'task-nousage',
      contextId: 'ctx-nousage',
      sink: {
        pushStatus: () => {
          delivered = true;
        },
        pushArtifact: () => {},
        finish: () => {},
      },
    } as Parameters<Registry['bindTask']>[0];
    registry.bindTask(binding);

    ws.send(encodeFrame({
      type: 'task.complete',
      taskId: 'task-nousage',
      status: { state: 'completed', timestamp: '2026-06-18T00:00:00.000Z' },
    }));

    const deadline = Date.now() + 1_000;
    while (!delivered) {
      assert.ok(Date.now() < deadline, 'timed out waiting for the terminal status');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(binding.usage, undefined);
  } finally {
    ws.close();
    await closeServer(server);
  }
});

test('task.status without metadata leaves TaskStatusUpdateEvent.metadata unset', async () => {
  const server = createServer();
  const registry = new Registry();
  attachWsServer(server, { db: mockSql(), registry });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`);

  try {
    await once(ws, 'open');
    ws.send(encodeFrame({
      type: 'hello',
      version: PROTOCOL_VERSION,
      agentId: 'agent-1',
      token: 'token',
      agentCard: { name: 'agent', version: '0.0.0', protocolVersion: '0.3.0' },
    }));
    await waitForAgent(registry, 'agent-1');

    const sink = makeSink();
    registry.bindTask({
      agentId: 'agent-1',
      taskId: 'task-plain-status',
      contextId: 'ctx-plain-status',
      sink,
    });

    ws.send(encodeFrame({
      type: 'task.status',
      taskId: 'task-plain-status',
      status: { state: 'working' },
    }));

    const deadline = Date.now() + 1_000;
    while (sink.statuses.length === 0) {
      assert.ok(Date.now() < deadline, 'timed out waiting for status');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(sink.statuses[0]!.metadata, undefined);
  } finally {
    ws.close();
    await closeServer(server);
  }
});

test('task.fail omits terminal error metadata when openai-compat extension was not requested', async () => {
  const server = createServer();
  const registry = new Registry();
  attachWsServer(server, { db: mockSql(), registry });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`);
  try {
    await once(ws, 'open');
    ws.send(encodeFrame({
      type: 'hello',
      version: PROTOCOL_VERSION,
      agentId: 'agent-1',
      token: 'token',
      agentCard: {
        name: 'agent',
        version: '0.0.0',
        protocolVersion: '0.3.0',
      },
    }));
    await waitForAgent(registry, 'agent-1');

    const sink = makeSink();
    registry.bindTask({
      agentId: 'agent-1',
      taskId: 'task-plain',
      contextId: 'ctx-plain',
      sink,
    });

    ws.send(encodeFrame({
      type: 'task.fail',
      taskId: 'task-plain',
      error: {
        code: 'rate_limited',
        message: 'slow down',
      },
    }));

    await withTimeout(sink.finished, 5_000, 'the task terminal');

    const event = sink.statuses[0]!;
    assert.equal(event.status.state, 'failed');
    assert.deepEqual(event.status.message?.parts, [{ text: 'rate_limited: slow down' }]);
    assert.equal(event.status.message?.metadata, undefined);
    assert.equal(event.status.message?.extensions, undefined);
  } finally {
    ws.close();
    await closeServer(server);
  }
});
async function waitForAgentGone(registry: Registry, agentId: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (registry.getAgent(agentId)) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${agentId} to unregister`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function helloFrame(): string {
  return encodeFrame({
    type: 'hello',
    version: PROTOCOL_VERSION,
    agentId: 'agent-1',
    token: 'token',
    protocolCapabilities: [TASK_REPLAY_CAPABILITY],
    agentCard: {
      name: 'agent',
      version: '0.0.0',
      protocolVersion: '0.3.0',
    },
  });
}

test('a task survives a proxy-style disconnect and completes on the reconnected socket', async () => {
  const server = createServer();
  const registry = new Registry(10_000);
  attachWsServer(server, { db: mockSql(), registry });
  const port = await listen(server);
  const first = new WebSocket(`ws://127.0.0.1:${port}/connect`);
  let second: WebSocket | undefined;

  try {
    await once(first, 'open');
    first.send(helloFrame());
    await waitForAgent(registry, 'agent-1');

    const sink = makeSink();
    registry.bindTask({
      agentId: 'agent-1',
      taskId: 'task-1',
      contextId: 'ctx-1',
      sink,
      executionId: 'execution-1',
      nextClientSeq: 0,
    });

    registry.getAgent('agent-1')!.ws.close(1012, 'restarting');
    await waitForAgentGone(registry, 'agent-1');

    assert.ok(registry.getBinding('task-1'), 'task must be held across the disconnect');
    assert.equal(sink.statuses.length, 0, 'no premature failure may be emitted');

    second = new WebSocket(`ws://127.0.0.1:${port}/connect`);
    await once(second, 'open');
    second.send(helloFrame());
    await waitForAgent(registry, 'agent-1');

    second.send(encodeFrame({
      type: 'task.status',
      taskId: 'task-1',
      executionId: 'execution-1',
      seq: 0,
      status: { state: 'working', timestamp: new Date().toISOString() },
      metadata: { [OPENAI_COMPAT_EXTENSION_URI]: { heartbeat: true } },
    }));

    second.send(encodeFrame({
      type: 'task.complete',
      taskId: 'task-1',
      executionId: 'execution-1',
      seq: 1,
      status: {
        state: 'completed',
        timestamp: new Date().toISOString(),
        message: {
          role: 'agent',
          messageId: 'm-1',
          parts: [{ kind: 'text', text: 'the answer' }],
        },
      },
    }));

    await withTimeout(sink.finished, 5_000, 'the task terminal');

    const terminal = sink.statuses.at(-1)!;
    assert.equal(terminal.final, true);
    assert.equal(terminal.status.state, 'completed');
    assert.deepEqual(terminal.status.message?.parts, [{ kind: 'text', text: 'the answer' }]);
    assert.ok(
      !sink.statuses.some((s) => s.status.state === 'failed'),
      'the task must never have been marked failed',
    );
    assert.equal(registry.getBinding('task-1'), undefined, 'the completed task is unbound');
  } finally {
    first.close();
    second?.close();
    await closeServer(server);
  }
});

test('an app-level close code fails in-flight tasks immediately, with no grace hold', async () => {
  const server = createServer();
  // An hour, deliberately: the point of this test is that the close code
  // reaches unregisterAgent at all. With a short grace the assertions below
  // pass either way — a severed code argument just means the hold expires into
  // a byte-identical terminal a few seconds later, and the only trace is the
  // test's own duration. Nothing here may be rescued by expiry.
  const registry = new Registry(60 * 60_000);
  attachWsServer(server, { db: mockSql(), registry });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`);

  try {
    await once(ws, 'open');
    ws.send(helloFrame());
    await waitForAgent(registry, 'agent-1');

    const sink = makeSink();
    registry.bindTask({
      agentId: 'agent-1',
      taskId: 'task-2',
      contextId: 'ctx-2',
      sink,
    });

    registry.getAgent('agent-1')!.ws.close(4014, 'client deleted');

    await withTimeout(sink.finished, 5_000, 'the immediate app-level-close terminal');

    const terminal = sink.statuses.at(-1)!;
    assert.equal(terminal.final, true);
    assert.equal(terminal.status.state, 'failed');
    assert.deepEqual(terminal.status.message?.parts, [{ text: 'client disconnected mid-task' }]);
    assert.equal(registry.getBinding('task-2'), undefined);
  } finally {
    ws.close();
    await closeServer(server);
  }
});

const wsSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Two distinct agents, each with its own token — needed to prove that one
// agent cannot act on another's task.
function twoAgentSql(): Sql {
  const rows: Record<string, unknown> = {
    [hashToken('token-1')]: {
      id: 'agent-1',
      client_id: 'client-1',
      owner_principal: 'eth:0x1',
      owner_email: null,
      allowed_callers: [],
    },
    [hashToken('token-2')]: {
      id: 'agent-2',
      client_id: 'client-2',
      owner_principal: 'eth:0x2',
      owner_email: null,
      allowed_callers: [],
    },
  };
  const fn = async (_strings: TemplateStringsArray, hash: string) => {
    const row = rows[hash];
    return row ? [row] : [];
  };
  return fn as unknown as Sql;
}

function helloFrameFor(agentId: string, token: string): string {
  return encodeFrame({
    type: 'hello',
    version: PROTOCOL_VERSION,
    agentId,
    token,
    protocolCapabilities: [TASK_REPLAY_CAPABILITY],
    agentCard: { name: agentId, version: '0.0.0', protocolVersion: '0.3.0' },
  });
}

test('a heartbeat on the reconnected socket keeps a task alive past the original grace deadline', async () => {
  // The reason resume exists at all. Without it the hold would expire on its
  // original deadline no matter how obviously alive the client is, which would
  // cap every task at the grace window rather than merely deciding how long to
  // wait for a client that may be dead. A short grace here stands in for a task
  // that outruns whatever the deadline happens to be.
  const server = createServer();
  const registry = new Registry(60);
  attachWsServer(server, { db: mockSql(), registry });
  const port = await listen(server);
  const first = new WebSocket(`ws://127.0.0.1:${port}/connect`);
  let second: WebSocket | undefined;

  try {
    await once(first, 'open');
    first.send(helloFrame());
    await waitForAgent(registry, 'agent-1');

    const sink = makeSink();
    registry.bindTask({
      agentId: 'agent-1', taskId: 'task-3', contextId: 'ctx-3', sink,
      executionId: 'execution-3', nextClientSeq: 0,
    });

    registry.getAgent('agent-1')!.ws.close(1012, 'restarting');
    await waitForAgentGone(registry, 'agent-1');

    second = new WebSocket(`ws://127.0.0.1:${port}/connect`);
    await once(second, 'open');
    second.send(helloFrame());
    await waitForAgent(registry, 'agent-1');

    // One beat, well inside the window — this is what must cancel the hold.
    second.send(encodeFrame({
      type: 'task.status',
      taskId: 'task-3',
      executionId: 'execution-3',
      seq: 0,
      status: { state: 'working', timestamp: new Date().toISOString() },
      metadata: { [OPENAI_COMPAT_EXTENSION_URI]: { heartbeat: true } },
    }));

    // Now work well past the original deadline before answering.
    await wsSleep(150);
    assert.ok(registry.getBinding('task-3'), 'the resumed task expired anyway');

    second.send(encodeFrame({
      type: 'task.complete',
      taskId: 'task-3',
      executionId: 'execution-3',
      seq: 1,
      status: {
        state: 'completed',
        timestamp: new Date().toISOString(),
        message: { role: 'agent', messageId: 'm-3', parts: [{ kind: 'text', text: 'late answer' }] },
      },
    }));

    await withTimeout(sink.finished, 5_000, 'the task terminal');

    const terminal = sink.statuses.at(-1)!;
    assert.equal(terminal.status.state, 'completed');
    assert.deepEqual(terminal.status.message?.parts, [{ kind: 'text', text: 'late answer' }]);
  } finally {
    first.close();
    second?.close();
    await closeServer(server);
  }
});

test('an agent cannot push frames into another agent\'s task', async () => {
  // `getBinding` keys on taskId alone, so the handlers must check ownership
  // themselves. The grace hold makes this load-bearing: a held binding stays
  // resolvable for the whole window while its owner is offline and cannot
  // contradict a forged terminal written in its name.
  const server = createServer();
  const registry = new Registry(10_000);
  attachWsServer(server, { db: twoAgentSql(), registry });
  const port = await listen(server);
  const victim = new WebSocket(`ws://127.0.0.1:${port}/connect`);
  // Connect one at a time. Opening both up front and awaiting them in sequence
  // deadlocks: the second socket fires 'open' while we are awaiting the first,
  // and `once()` then waits forever for a second 'open' that never comes.
  let attacker: WebSocket | undefined;
  const eventNames: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] !== 'string') return;
    try {
      const event = (JSON.parse(args[0]) as { event?: unknown }).event;
      if (typeof event === 'string') eventNames.push(event);
    } catch {
      // Ignore non-JSON console output.
    }
  };

  try {
    await once(victim, 'open');
    victim.send(helloFrameFor('agent-1', 'token-1'));
    await waitForAgent(registry, 'agent-1');

    attacker = new WebSocket(`ws://127.0.0.1:${port}/connect`);
    await once(attacker, 'open');
    attacker.send(helloFrameFor('agent-2', 'token-2'));
    await waitForAgent(registry, 'agent-2');

    const sink = makeSink();
    registry.bindTask({
      agentId: 'agent-1', taskId: 'victim-task', contextId: 'ctx-v', sink,
      executionId: 'execution-victim', nextClientSeq: 0,
    });

    // The victim drops mid-task; its binding is now held and still resolvable.
    registry.getAgent('agent-1')!.ws.close(1012, 'restarting');
    await waitForAgentGone(registry, 'agent-1');

    // agent-2 forges a terminal — and reported usage — for agent-1's task.
    attacker.send(encodeFrame({
      type: 'task.complete',
      taskId: 'victim-task',
      executionId: 'execution-victim',
      seq: 0,
      usage: { promptTokens: 999_999, completionTokens: 999_999 },
      status: {
        state: 'completed',
        timestamp: new Date().toISOString(),
        message: { role: 'agent', messageId: 'm-x', parts: [{ kind: 'text', text: 'forged' }] },
      },
    }));
    attacker.send(encodeFrame({
      type: 'task.fail',
      taskId: 'victim-task',
      executionId: 'execution-victim',
      seq: 0,
      error: { code: 'forged', message: 'forged' },
    }));

    // Give both frames time to be processed and rejected.
    await wsSleep(60);

    assert.deepEqual(sink.statuses, [], 'a foreign agent wrote into the victim task');
    assert.deepEqual(sink.artifacts, []);
    assert.ok(registry.getBinding('victim-task'), 'the victim task must still be held');
    assert.equal(eventNames.filter((name) => name === 'binding_owner_mismatch').length, 2);
    assert.equal(eventNames.filter((name) => name === 'dropped_terminal_frame').length, 0);

    // The rightful owner comes back and completes it normally.
    const recovered = new WebSocket(`ws://127.0.0.1:${port}/connect`);
    try {
      await once(recovered, 'open');
      recovered.send(helloFrameFor('agent-1', 'token-1'));
      await waitForAgent(registry, 'agent-1');
      recovered.send(encodeFrame({
        type: 'task.complete',
        taskId: 'victim-task',
        executionId: 'execution-victim',
        seq: 0,
        status: {
          state: 'completed',
          timestamp: new Date().toISOString(),
          message: { role: 'agent', messageId: 'm-ok', parts: [{ kind: 'text', text: 'real answer' }] },
        },
      }));
      await withTimeout(sink.finished, 5_000, 'the task terminal');
      // Re-read through the typed alias: the `deepEqual(…, [])` above narrows
      // `sink.statuses` to never[] for the rest of this block.
      const delivered: TaskStatusUpdateEvent[] = sink.statuses;
      const terminal = delivered.at(-1)!;
      assert.equal(terminal.status.state, 'completed');
      assert.deepEqual(terminal.status.message?.parts, [{ kind: 'text', text: 'real answer' }]);
    } finally {
      recovered.close();
    }
  } finally {
    console.log = origLog;
    victim.close();
    attacker?.close();
    await closeServer(server);
  }
});

test('a live duplicate-token collision is held against real sockets, then expires as superseded', async () => {
  // Deliberately real WebSockets rather than the registry stub. The collision
  // branch used to read `readyState` around its own `close()` call, and `ws`
  // mutates readyState synchronously inside close() — a hand-rolled stub can
  // model that wrongly and certify a branch production never takes, which is
  // exactly what happened once already.
  //
  // The contract now: a same-token reconnect is HELD even when the displaced
  // socket is unmistakably live, because "looks live" cannot distinguish a
  // rival daemon from the very client that is reconnecting. An unreclaimed hold
  // then expires into this path's own `superseded` terminal.
  const server = createServer();
  const registry = new Registry(60);
  attachWsServer(server, { db: mockSql(), registry });
  const port = await listen(server);
  const first = new WebSocket(`ws://127.0.0.1:${port}/connect`);
  // Connect one at a time; see the note in the ownership test above.
  let second: WebSocket | undefined;

  try {
    await once(first, 'open');
    first.send(helloFrame());
    await waitForAgent(registry, 'agent-1');
    const firstConn = registry.getAgent('agent-1');
    assert.equal(firstConn!.ws.readyState, firstConn!.ws.OPEN, 'precondition: displaced socket live');

    const sink = makeSink();
    registry.bindTask({
      agentId: 'agent-1', taskId: 'task-4', contextId: 'ctx-4', sink,
      executionId: 'execution-4', nextClientSeq: 0,
    });

    second = new WebSocket(`ws://127.0.0.1:${port}/connect`);
    await once(second, 'open');
    second.send(helloFrameFor('agent-1', 'token'));
    const deadline = Date.now() + 1_000;
    while (registry.getAgent('agent-1') === firstConn) {
      assert.ok(Date.now() < deadline, 'timed out waiting for the collision swap');
      await wsSleep(5);
    }

    // Not killed on the spot — this is the whole point.
    assert.ok(registry.getBinding('task-4'), 'a live-looking collision must still be held');
    assert.deepEqual(sink.statuses, [], 'no premature terminal');

    await withTimeout(sink.finished, 5_000, 'the collision hold to expire');

    const terminal: TaskStatusUpdateEvent[] = sink.statuses;
    const last = terminal.at(-1)!;
    assert.equal(last.final, true);
    assert.equal(last.status.state, 'failed');
    assert.deepEqual(last.status.message?.parts, [
      { text: 'superseded by a reconnect from the same client token' },
    ]);
    assert.equal(registry.getBinding('task-4'), undefined);
  } finally {
    first.close();
    second?.close();
    await closeServer(server);
  }
});

test('a pre-auth task frame is rejected with an actionable hello-first reason', async () => {
  const server = createServer();
  const registry = new Registry();
  attachWsServer(server, { db: mockSql(), registry });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`);

  try {
    await once(ws, 'open');
    ws.send(encodeFrame({
      type: 'task.fail', taskId: 'pre-auth-task',
      error: { code: 'too_early', message: 'too early' },
    }));
    const [code, reason] = (await once(ws, 'close')) as [number, Buffer];
    assert.equal(code, 4003);
    assert.equal(reason.toString('utf8'), 'expected hello before task frames');
  } finally {
    ws.close();
    await closeServer(server);
  }
});

test('a message past the ingress cap is refused by the transport, never assembled', async () => {
  // The pre-auth byte budget can only be charged once `ws` has already built
  // the message, so without an ingress cap the library's 100 MiB default is
  // what an unauthenticated peer can make each connection hold before we ever
  // look. This asserts the transport itself refuses it: close 1009, the
  // WebSocket "message too big" code, rather than our own 4002.
  const server = createServer();
  const registry = new Registry();
  attachWsServer(server, { db: mockSql(), registry });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`, { maxPayload: 0 });

  try {
    await once(ws, 'open');
    ws.send('{"pad":"' + 'z'.repeat(17 * 1024 * 1024) + '"}');
    const [code] = (await once(ws, 'close')) as [number, Buffer];
    assert.equal(code, 1009, 'the transport must reject an over-cap payload');
  } finally {
    ws.close();
    await closeServer(server);
  }
});

test('task-replay-v1 is acknowledged only after authentication', async () => {
  const server = createServer();
  const registry = new Registry(12_345);
  attachWsServer(server, { db: mockSql(), registry });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`);
  try {
    await once(ws, 'open');
    const ack = once(ws, 'message');
    ws.send(encodeFrame({
      type: 'hello', version: PROTOCOL_VERSION, agentId: 'agent-1', token: 'token',
      protocolCapabilities: [TASK_REPLAY_CAPABILITY],
      agentCard: { name: 'agent', version: '0.0.0', protocolVersion: '0.3.0' },
    }));
    const [raw] = (await ack) as [Buffer];
    const frame = parseDownFrame(raw.toString('utf8'));
    assert.equal(frame.type, 'hello.ack');
    if (frame.type === 'hello.ack') {
      assert.deepEqual(frame.protocolCapabilities, [TASK_REPLAY_CAPABILITY]);
      assert.equal(frame.disconnectGraceMs, 12_345);
    }
  } finally {
    ws.close();
    await closeServer(server);
  }
});

test('sequenced task frames are acknowledged, deduplicated, and completed once', async () => {
  const server = createServer();
  const registry = new Registry();
  attachWsServer(server, { db: mockSql(), registry });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`);
  const down: ReturnType<typeof parseDownFrame>[] = [];
  ws.on('message', (raw) => down.push(parseDownFrame(raw.toString('utf8'))));
  try {
    await once(ws, 'open');
    ws.send(encodeFrame({
      type: 'hello', version: PROTOCOL_VERSION, agentId: 'agent-1', token: 'token',
      protocolCapabilities: [TASK_REPLAY_CAPABILITY],
      agentCard: { name: 'agent', version: '0.0.0', protocolVersion: '0.3.0' },
    }));
    await waitForAgent(registry, 'agent-1');
    const sink = makeSink();
    registry.bindTask({
      agentId: 'agent-1', taskId: 'task-seq', contextId: 'ctx', sink,
      executionId: 'execution-seq', nextClientSeq: 0,
    });
    const artifact = encodeFrame({
      type: 'task.artifact', taskId: 'task-seq', executionId: 'execution-seq', seq: 0,
      artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'once' }] },
    });
    ws.send(artifact);
    ws.send(artifact);
    ws.send(encodeFrame({
      type: 'task.complete', taskId: 'task-seq', executionId: 'execution-seq', seq: 1,
      status: { state: 'completed' },
    }));
    await withTimeout(sink.finished, 5_000, 'sequenced terminal');
    assert.equal(sink.artifacts.length, 1);
    assert.equal(sink.statuses.filter((status) => status.final).length, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      down.filter((frame) => frame.type === 'task.ack').map((frame) =>
        frame.type === 'task.ack' ? frame.acceptedSeq : -1),
      [0, 0, 1],
    );
  } finally {
    ws.close();
    await closeServer(server);
  }
});

test('a sequence gap fails closed without forwarding the suffix', async () => {
  const server = createServer();
  const registry = new Registry();
  attachWsServer(server, { db: mockSql(), registry });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`);
  try {
    await once(ws, 'open');
    ws.send(encodeFrame({
      type: 'hello', version: PROTOCOL_VERSION, agentId: 'agent-1', token: 'token',
      protocolCapabilities: [TASK_REPLAY_CAPABILITY],
      agentCard: { name: 'agent', version: '0.0.0', protocolVersion: '0.3.0' },
    }));
    await waitForAgent(registry, 'agent-1');
    const sink = makeSink();
    registry.bindTask({
      agentId: 'agent-1', taskId: 'task-gap', contextId: 'ctx', sink,
      executionId: 'execution-gap', nextClientSeq: 0,
    });
    ws.send(encodeFrame({
      type: 'task.artifact', taskId: 'task-gap', executionId: 'execution-gap', seq: 1,
      artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'suffix' }] },
    }));
    await withTimeout(sink.finished, 5_000, 'gap failure');
    assert.equal(sink.artifacts.length, 0);
    assert.equal(sink.statuses.at(-1)?.status.state, 'failed');
    assert.deepEqual(sink.statuses.at(-1)?.status.message?.parts, [
      { text: 'client frame sequence gap: expected 0, received 1' },
    ]);
  } finally {
    ws.close();
    await closeServer(server);
  }
});

test('a terminal replay from an old execution cannot complete a reused taskId', async () => {
  const server = createServer();
  const registry = new Registry();
  attachWsServer(server, { db: mockSql(), registry });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`);
  try {
    await once(ws, 'open');
    ws.send(encodeFrame({
      type: 'hello', version: PROTOCOL_VERSION, agentId: 'agent-1', token: 'token',
      protocolCapabilities: [TASK_REPLAY_CAPABILITY],
      agentCard: { name: 'agent', version: '0.0.0', protocolVersion: '0.3.0' },
    }));
    await waitForAgent(registry, 'agent-1');
    const first = makeSink();
    registry.bindTask({
      agentId: 'agent-1', taskId: 'task-reuse', contextId: 'ctx-1', sink: first,
      executionId: 'execution-old', nextClientSeq: 0,
    });
    ws.send(encodeFrame({
      type: 'task.complete', taskId: 'task-reuse', executionId: 'execution-old', seq: 0,
      status: { state: 'completed' },
    }));
    await withTimeout(first.finished, 5_000, 'first terminal');

    const second = makeSink();
    registry.bindTask({
      agentId: 'agent-1', taskId: 'task-reuse', contextId: 'ctx-2', sink: second,
      executionId: 'execution-new', nextClientSeq: 0,
    });
    ws.send(encodeFrame({
      type: 'task.complete', taskId: 'task-reuse', executionId: 'execution-old', seq: 0,
      status: { state: 'completed' },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(second.statuses.length, 0, 'old terminal must not touch the new binding');
    ws.send(encodeFrame({
      type: 'task.complete', taskId: 'task-reuse', executionId: 'execution-new', seq: 0,
      status: { state: 'completed' },
    }));
    await withTimeout(second.finished, 5_000, 'new terminal');
    assert.equal(second.statuses.at(-1)?.status.state, 'completed');
  } finally {
    ws.close();
    await closeServer(server);
  }
});
