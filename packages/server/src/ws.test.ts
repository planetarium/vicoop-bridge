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
