import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { createOpenclawBackend, parseLsofListeningPorts } from './openclaw.js';
import type { UpFrame, TaskAssignFrame } from '@vicoop-bridge/protocol';

interface ReqFrame {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
}

interface FakeGatewayOptions {
  autoHandshake?: boolean;
  onConnection?: (sock: WebSocket) => void;
  onRequest?: (sock: WebSocket, req: ReqFrame) => void;
}

interface FakeGateway {
  url: string;
  connections: WebSocket[];
  waitForConnection(index?: number): Promise<WebSocket>;
  respond(sock: WebSocket, id: string, payload: unknown): void;
  respondError(sock: WebSocket, id: string, error: { code: string; message: string }): void;
  emitChat(sock: WebSocket, payload: unknown): void;
  closeSocket(sock: WebSocket): Promise<void>;
  close(): Promise<void>;
}

async function createFakeGateway(opts: FakeGatewayOptions = {}): Promise<FakeGateway> {
  const autoHandshake = opts.autoHandshake ?? true;
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const connections: WebSocket[] = [];
  const waiters = new Map<number, Array<() => void>>();

  wss.on('connection', (sock) => {
    const idx = connections.length;
    connections.push(sock);
    sock.send(
      JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: `nonce-${idx}` },
      }),
    );

    sock.on('message', (raw) => {
      let frame: ReqFrame;
      try {
        frame = JSON.parse(raw.toString()) as ReqFrame;
      } catch {
        return;
      }
      if (frame.type !== 'req') return;
      if (frame.method === 'connect' && autoHandshake) {
        sock.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: {} }));
        return;
      }
      opts.onRequest?.(sock, frame);
    });

    opts.onConnection?.(sock);

    const list = waiters.get(idx);
    if (list) {
      waiters.delete(idx);
      for (const w of list) w();
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  const url = `ws://127.0.0.1:${port}`;

  return {
    url,
    connections,
    waitForConnection(index = 0) {
      if (connections[index]) return Promise.resolve(connections[index]);
      return new Promise<WebSocket>((resolve) => {
        const list = waiters.get(index) ?? [];
        list.push(() => resolve(connections[index]));
        waiters.set(index, list);
      });
    },
    respond(sock, id, payload) {
      sock.send(JSON.stringify({ type: 'res', id, ok: true, payload }));
    },
    respondError(sock, id, error) {
      sock.send(JSON.stringify({ type: 'res', id, ok: false, error }));
    },
    emitChat(sock, payload) {
      sock.send(JSON.stringify({ type: 'event', event: 'chat', payload }));
    },
    async closeSocket(sock) {
      await new Promise<void>((resolve) => {
        if (sock.readyState === WebSocket.CLOSED) return resolve();
        sock.once('close', () => resolve());
        sock.close(1000);
      });
    },
    async close() {
      for (const s of connections) {
        if (s.readyState !== WebSocket.CLOSED) s.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function makeTask(taskId: string, text: string): TaskAssignFrame {
  return {
    type: 'task.assign',
    taskId,
    contextId: `ctx-${taskId}`,
    message: {
      role: 'user',
      messageId: `msg-${taskId}`,
      parts: [{ kind: 'text', text }],
    },
  };
}

test('happy path: chat.send → final event → task completes', async () => {
  const frames: UpFrame[] = [];
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: true,
            payload: { runId: 'run-happy', status: 'started' },
          }),
        );
        setImmediate(() => {
          sock.send(
            JSON.stringify({
              type: 'event',
              event: 'chat',
              payload: {
                runId: 'run-happy',
                sessionKey: 'agent:main:ctx-t1',
                seq: 1,
                state: 'final',
                message: { text: 'hi back' },
              },
            }),
          );
        });
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    await backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f));
    const types = frames.map((f) => f.type);
    assert.deepEqual(types, ['task.status', 'task.artifact', 'task.complete']);
    const complete = frames.find((f) => f.type === 'task.complete');
    assert.ok(complete);
    assert.equal(complete!.status.state, 'completed');
  } finally {
    await fake.close();
  }
});

test('concurrent first-connect: shares one WebSocket across parallel handle() calls', async () => {
  let pendingConnectId: string | null = null;
  const fake = await createFakeGateway({
    autoHandshake: false,
    onRequest: (sock, req) => {
      if (req.method === 'connect') {
        pendingConnectId = req.id;
        return;
      }
      if (req.method === 'chat.send') {
        const params = req.params as { idempotencyKey: string };
        const runId = `run-${params.idempotencyKey}`;
        sock.send(
          JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId, status: 'started' } }),
        );
        setImmediate(() => {
          sock.send(
            JSON.stringify({
              type: 'event',
              event: 'chat',
              payload: {
                runId,
                sessionKey: 'agent:main:' + params.idempotencyKey,
                seq: 1,
                state: 'final',
                message: { text: 'done ' + params.idempotencyKey },
              },
            }),
          );
        });
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    const framesA: UpFrame[] = [];
    const framesB: UpFrame[] = [];
    const pA = backend.handle(makeTask('tA', 'a'), (f) => framesA.push(f));
    const pB = backend.handle(makeTask('tB', 'b'), (f) => framesB.push(f));
    // Give both handle() calls time to subscribe and reach the connect phase.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fake.connections.length, 1, 'only one WebSocket should be accepted');
    assert.ok(pendingConnectId, 'connect request should have arrived');
    fake.respond(fake.connections[0], pendingConnectId!, {});
    await Promise.all([pA, pB]);
    assert.equal(fake.connections.length, 1, 'no additional WebSocket opened after handshake');
    const finalA = framesA.find((f) => f.type === 'task.complete');
    const finalB = framesB.find((f) => f.type === 'task.complete');
    assert.ok(finalA && finalA.status.state === 'completed');
    assert.ok(finalB && finalB.status.state === 'completed');
  } finally {
    await fake.close();
  }
});

test('reconnect: after gateway close, next handle() opens a fresh WebSocket', async () => {
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        const runId = `run-${(req.params as { idempotencyKey: string }).idempotencyKey}`;
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: true,
            payload: { runId, status: 'started' },
          }),
        );
        setImmediate(() => {
          sock.send(
            JSON.stringify({
              type: 'event',
              event: 'chat',
              payload: {
                runId,
                sessionKey: 'agent:main:ctx',
                seq: 1,
                state: 'final',
                message: { text: 'ok' },
              },
            }),
          );
        });
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    const framesA: UpFrame[] = [];
    await backend.handle(makeTask('tA', 'a'), (f) => framesA.push(f));
    const sock0 = await fake.waitForConnection(0);
    await fake.closeSocket(sock0);
    // Let the client process the WebSocket close event.
    await new Promise((r) => setTimeout(r, 20));
    const framesB: UpFrame[] = [];
    await backend.handle(makeTask('tB', 'b'), (f) => framesB.push(f));
    assert.equal(fake.connections.length, 2, 'a fresh WebSocket should be opened for the second task');
    assert.ok(framesA.find((f) => f.type === 'task.complete'));
    assert.ok(framesB.find((f) => f.type === 'task.complete'));
  } finally {
    await fake.close();
  }
});

test('fast terminal event: final arrives on same socket read as ack and is still delivered', async () => {
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        const runId = 'run-fast';
        // Emit ack and terminal event in the same synchronous burst so both
        // frames batch into a single socket read on the client. The buffer
        // in handle() must catch the event even though runToTask has not
        // been populated yet.
        sock.send(
          JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId, status: 'started' } }),
        );
        sock.send(
          JSON.stringify({
            type: 'event',
            event: 'chat',
            payload: {
              runId,
              sessionKey: 'agent:main:ctx-t1',
              seq: 1,
              state: 'final',
              message: { text: 'instant' },
            },
          }),
        );
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    const frames: UpFrame[] = [];
    await backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f));
    const complete = frames.find((f) => f.type === 'task.complete');
    assert.ok(complete, 'task should complete even with racing ack+final');
    assert.equal(complete!.status.state, 'completed');
  } finally {
    await fake.close();
  }
});

test('task timeout: no terminal event triggers task_timeout failure', async () => {
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        // Ack, then stay silent forever.
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: true,
            payload: { runId: 'run-stall', status: 'started' },
          }),
        );
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url, taskTimeoutMs: 150 });
    const frames: UpFrame[] = [];
    await backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f));
    const fail = frames.find((f) => f.type === 'task.fail');
    assert.ok(fail, 'task must fail on timeout');
    assert.equal(fail!.error.code, 'task_timeout');
  } finally {
    await fake.close();
  }
});

test('cancel: issues chat.abort and lets aborted terminal event complete the task as canceled', async () => {
  let lastChatSendId: string | null = null;
  let activeSock: WebSocket | null = null;
  let activeRunId: string | null = null;
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        activeSock = sock;
        lastChatSendId = req.id;
        activeRunId = `run-${(req.params as { idempotencyKey: string }).idempotencyKey}`;
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: true,
            payload: { runId: activeRunId, status: 'started' },
          }),
        );
      }
      if (req.method === 'chat.abort') {
        sock.send(JSON.stringify({ type: 'res', id: req.id, ok: true, payload: {} }));
        setImmediate(() => {
          sock.send(
            JSON.stringify({
              type: 'event',
              event: 'chat',
              payload: {
                runId: activeRunId,
                sessionKey: 'agent:main:ctx-t1',
                seq: 2,
                state: 'aborted',
              },
            }),
          );
        });
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    const frames: UpFrame[] = [];
    const task = makeTask('t1', 'hi');
    const pending = backend.handle(task, (f) => frames.push(f));
    // Wait for the chat.send to land so cancel() can find runToTask.
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(lastChatSendId && activeSock);
    await backend.cancel(task.taskId);
    await pending;
    const complete = frames.find((f) => f.type === 'task.complete');
    assert.ok(complete);
    assert.equal(complete!.status.state, 'canceled');
  } finally {
    await fake.close();
  }
});

test('gateway close before ack emits gateway_closed (not gateway_send_failed)', async () => {
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        // Close the socket before acking so the pending request rejects
        // due to the close listener.
        setImmediate(() => sock.close(1000));
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    const frames: UpFrame[] = [];
    await backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f));
    const fail = frames.find((f) => f.type === 'task.fail');
    assert.ok(fail, 'task must fail');
    assert.equal(fail!.error.code, 'gateway_closed');
  } finally {
    await fake.close();
  }
});

test('late duplicate chat event for finalized run is dropped, not buffered', async () => {
  // After a task terminates, the gateway can still emit late deltas for
  // the same runId (e.g. a trailing log). Those must not accumulate in
  // pendingRunEvents — the second task should run normally with no side
  // effects, and the backend should stay usable across many completions.
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        const runId = `run-${(req.params as { idempotencyKey: string }).idempotencyKey}`;
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: true,
            payload: { runId, status: 'started' },
          }),
        );
        setImmediate(() => {
          sock.send(
            JSON.stringify({
              type: 'event',
              event: 'chat',
              payload: {
                runId,
                sessionKey: 'x',
                seq: 1,
                state: 'final',
                message: { text: 'ok' },
              },
            }),
          );
          // Late duplicate after the terminal event.
          setImmediate(() => {
            sock.send(
              JSON.stringify({
                type: 'event',
                event: 'chat',
                payload: {
                  runId,
                  sessionKey: 'x',
                  seq: 2,
                  state: 'delta',
                  message: { text: 'late' },
                },
              }),
            );
          });
        });
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    const framesA: UpFrame[] = [];
    await backend.handle(makeTask('tA', 'hi'), (f) => framesA.push(f));
    assert.ok(framesA.find((f) => f.type === 'task.complete'));
    // Give the late duplicate time to arrive and be dropped.
    await new Promise((r) => setTimeout(r, 30));
    const framesB: UpFrame[] = [];
    await backend.handle(makeTask('tB', 'hi'), (f) => framesB.push(f));
    assert.ok(framesB.find((f) => f.type === 'task.complete'));
  } finally {
    await fake.close();
  }
});

test('invalid URL: WebSocket constructor throwing does not wedge ensureConnected', async () => {
  // An invalid URL makes `new WebSocket(url)` throw synchronously. Without
  // the guard in connect(), _state would stay 'connecting' and every
  // subsequent handle() call would block forever on the same dead promise.
  const backend = createOpenclawBackend({
    url: 'http://not-a-ws-url',
    handshakeTimeoutMs: 500,
  });
  const framesA: UpFrame[] = [];
  const framesB: UpFrame[] = [];
  await backend.handle(makeTask('tA', 'a'), (f) => framesA.push(f));
  // Second call must not hang — it should re-enter ensureConnected() cleanly
  // and fail the same way.
  await backend.handle(makeTask('tB', 'b'), (f) => framesB.push(f));
  const failA = framesA.find((f) => f.type === 'task.fail');
  const failB = framesB.find((f) => f.type === 'task.fail');
  assert.ok(failA && failA.error.code === 'gateway_closed');
  assert.ok(failB && failB.error.code === 'gateway_closed');
});

test('handshake timeout: gateway accepts TCP but never completes handshake', async () => {
  const fake = await createFakeGateway({
    autoHandshake: false,
    // Swallow the connect request so the handshake never resolves.
    onRequest: () => {},
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url, handshakeTimeoutMs: 100 });
    const frames: UpFrame[] = [];
    await backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f));
    const fail = frames.find((f) => f.type === 'task.fail');
    assert.ok(fail, 'task must fail when handshake never completes');
    assert.equal(fail!.error.code, 'gateway_closed');
    assert.match(fail!.error.message, /handshake timed out/);
  } finally {
    await fake.close();
  }
});

test('invalid taskTimeoutMs falls back to default instead of firing immediately', async () => {
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: true,
            payload: { runId: 'run-ok', status: 'started' },
          }),
        );
        setImmediate(() => {
          sock.send(
            JSON.stringify({
              type: 'event',
              event: 'chat',
              payload: {
                runId: 'run-ok',
                sessionKey: 'x',
                seq: 1,
                state: 'final',
                message: { text: 'ok' },
              },
            }),
          );
        });
      }
    },
  });
  try {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      // Invalid timeout — must not cause the task to time out immediately.
      const backend = createOpenclawBackend({ url: fake.url, taskTimeoutMs: 0 });
      const frames: UpFrame[] = [];
      await backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f));
      assert.ok(frames.find((f) => f.type === 'task.complete'));
      assert.ok(warnings.some((w) => w.includes('invalid taskTimeoutMs')));
    } finally {
      console.warn = originalWarn;
    }
  } finally {
    await fake.close();
  }
});

test('gateway close mid-run fails in-flight task deterministically', async () => {
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        // Ack, but never send a terminal event; the close will be the trigger.
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: true,
            payload: { runId: 'run-stuck', status: 'started' },
          }),
        );
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    const frames: UpFrame[] = [];
    const pending = backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f));
    // Wait for the ack to arrive and handle() to register runToTask/finalizer.
    await new Promise((r) => setTimeout(r, 50));
    const sock = await fake.waitForConnection(0);
    await fake.closeSocket(sock);
    await pending;
    const fail = frames.find((f) => f.type === 'task.fail');
    assert.ok(fail, 'task must fail after gateway close');
    assert.equal(fail!.error.code, 'gateway_closed');
  } finally {
    await fake.close();
  }
});

test('parseLsofListeningPorts extracts loopback listen ports and ignores non-loopback', () => {
  const sample = [
    'COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'openclaw 1234 me    7u  IPv4 0x1111111111111111      0t0  TCP 127.0.0.1:3000 (LISTEN)',
    'openclaw 1234 me    8u  IPv6 0x2222222222222222      0t0  TCP [::1]:4000 (LISTEN)',
    'openclaw 1234 me    9u  IPv4 0x3333333333333333      0t0  TCP *:18789 (LISTEN)',
    'openclaw 1234 me   10u  IPv4 0x4444444444444444      0t0  TCP 192.168.1.10:5000 (LISTEN)',
    'openclaw 1234 me   11u  IPv4 0x5555555555555555      0t0  TCP 127.0.0.1:6000->127.0.0.1:7000 (ESTABLISHED)',
  ].join('\n');
  const ports = parseLsofListeningPorts(sample).sort((a, b) => a - b);
  assert.deepEqual(ports, [3000, 4000, 18789]);
});

test('parseLsofListeningPorts returns empty for empty / header-only input', () => {
  assert.deepEqual(parseLsofListeningPorts(''), []);
  assert.deepEqual(parseLsofListeningPorts('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME'), []);
});

test('discovery fallback: when primary URL is dead and no candidates match, original error propagates', async () => {
  // Use a deliberately bogus process name so `lsof -c <name>` matches nothing,
  // forcing the fallback path to exit without candidates and surface the
  // primary connect failure.
  const prev = process.env.OPENCLAW_PROCESS_NAME;
  process.env.OPENCLAW_PROCESS_NAME = '__vicoop_bridge_test_no_such_proc__';
  try {
    const backend = createOpenclawBackend({
      url: 'ws://127.0.0.1:1', // port 1 refuses TCP immediately
      handshakeTimeoutMs: 1500,
    });
    const frames: UpFrame[] = [];
    await backend.handle(makeTask('t-disc', 'hi'), (f) => frames.push(f));
    const fail = frames.find((f) => f.type === 'task.fail');
    assert.ok(fail, 'task must fail when no gateway is reachable');
    assert.equal(fail!.error.code, 'gateway_closed');
  } finally {
    if (prev === undefined) delete process.env.OPENCLAW_PROCESS_NAME;
    else process.env.OPENCLAW_PROCESS_NAME = prev;
  }
});

export { createFakeGateway, makeTask };
