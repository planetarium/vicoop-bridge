import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import type { TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2x/sdk';
import {
  encodeFrame,
  OPENAI_COMPAT_EXTENSION_URI,
  PROTOCOL_VERSION,
} from '@vicoop-bridge/protocol';
import { Registry, type TaskSink } from './registry.js';
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

    await sink.finished;

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

    await sink.finished;

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
