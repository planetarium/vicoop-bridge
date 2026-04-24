import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import {
  createOpenclawBackend,
  listenersToGatewayUrls,
  mapPartsToChatInput,
  parseLsofListeningPorts,
  redactUrl,
} from './openclaw.js';
import type { UpFrame, TaskAssignFrame } from '@vicoop-bridge/protocol';

// Most tests don't exercise cancellation. Reusing one unaborted signal keeps
// those call sites noise-free; cancel-specific tests build their own
// AbortController and signal as needed.
const NEVER: AbortSignal = new AbortController().signal;

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
  emitSessionMessage(sock: WebSocket, payload: unknown): void;
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
      // Every backend task path now calls `sessions.messages.subscribe` once
      // per sessionKey to enable message-boundary streaming. Auto-ack here so
      // existing tests that don't care about streaming don't have to wire up
      // a handler — the onRequest hook still runs if a test wants to inspect
      // the subscription call itself.
      if (frame.method === 'sessions.messages.subscribe') {
        const key = (frame.params as { key?: string } | undefined)?.key ?? '';
        sock.send(
          JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: true,
            payload: { subscribed: true, key },
          }),
        );
        opts.onRequest?.(sock, frame);
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
    emitSessionMessage(sock, payload) {
      sock.send(JSON.stringify({ type: 'event', event: 'session.message', payload }));
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
    await backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f), NEVER);
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
    const pA = backend.handle(makeTask('tA', 'a'), (f) => framesA.push(f), NEVER);
    const pB = backend.handle(makeTask('tB', 'b'), (f) => framesB.push(f), NEVER);
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
    await backend.handle(makeTask('tA', 'a'), (f) => framesA.push(f), NEVER);
    const sock0 = await fake.waitForConnection(0);
    await fake.closeSocket(sock0);
    // Let the client process the WebSocket close event.
    await new Promise((r) => setTimeout(r, 20));
    const framesB: UpFrame[] = [];
    await backend.handle(makeTask('tB', 'b'), (f) => framesB.push(f), NEVER);
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
    await backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f), NEVER);
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
    await backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f), NEVER);
    const fail = frames.find((f) => f.type === 'task.fail');
    assert.ok(fail, 'task must fail on timeout');
    assert.equal(fail!.error.code, 'task_timeout');
  } finally {
    await fake.close();
  }
});

test('cancel (post-ack): signal abort issues chat.abort and aborted event completes the task as canceled', async () => {
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
    const controller = new AbortController();
    const task = makeTask('t1', 'hi');
    const pending = backend.handle(task, (f) => frames.push(f), controller.signal);
    // Wait for the chat.send to land so abort fires on a known runId.
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(lastChatSendId && activeSock);
    controller.abort();
    await pending;
    const complete = frames.find((f) => f.type === 'task.complete');
    assert.ok(complete);
    assert.equal(complete!.status.state, 'canceled');
  } finally {
    await fake.close();
  }
});

test('cancel (pre-ack): signal abort before chat.send ack still fires chat.abort once runId is known', async () => {
  // Gateway holds the chat.send ack so we can abort the signal first, then
  // release the ack. The backend must remember the intent and issue
  // chat.abort immediately after learning runId.
  let heldChatSend: { sock: WebSocket; id: string; runId: string } | null = null;
  let chatAbortSeen = false;
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        const runId = `run-${(req.params as { idempotencyKey: string }).idempotencyKey}`;
        heldChatSend = { sock, id: req.id, runId };
      }
      if (req.method === 'chat.abort') {
        chatAbortSeen = true;
        sock.send(JSON.stringify({ type: 'res', id: req.id, ok: true, payload: {} }));
        setImmediate(() => {
          const runId = (req.params as { runId: string }).runId;
          sock.send(
            JSON.stringify({
              type: 'event',
              event: 'chat',
              payload: {
                runId,
                sessionKey: (req.params as { sessionKey: string }).sessionKey,
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
    const controller = new AbortController();
    const task = makeTask('t1', 'hi');
    const pending = backend.handle(task, (f) => frames.push(f), controller.signal);
    // Wait for chat.send to reach the fake gateway (unacked), then abort.
    for (let i = 0; i < 20 && !heldChatSend; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(heldChatSend, 'chat.send should have reached the gateway');
    controller.abort();
    // Release the ack: this triggers the deferred chat.abort.
    const held = heldChatSend!;
    held.sock.send(
      JSON.stringify({
        type: 'res',
        id: held.id,
        ok: true,
        payload: { runId: held.runId, status: 'started' },
      }),
    );
    await pending;
    assert.ok(chatAbortSeen, 'chat.abort must fire even though abort arrived before ack');
    const complete = frames.find((f) => f.type === 'task.complete');
    assert.ok(complete);
    assert.equal(complete!.status.state, 'canceled');
  } finally {
    await fake.close();
  }
});

test('cancel (during connect): signal aborted before listener attaches still fires chat.abort', async () => {
  // Regression: previously, handle() attached the abort listener only AFTER
  // `await ensureConnected()`. If the signal aborted during that await, the
  // listener attached on an already-aborted signal and never fired (AbortSignal
  // does not replay the abort event). chat.abort was silently skipped and
  // the task hung until taskTimeoutMs.
  let heldConnect: { sock: WebSocket; id: string } | null = null;
  let chatAbortSeen = false;
  const fake = await createFakeGateway({
    autoHandshake: false,
    onRequest: (sock, req) => {
      if (req.method === 'connect') {
        heldConnect = { sock, id: req.id };
      }
      if (req.method === 'chat.send') {
        const runId = `run-${(req.params as { idempotencyKey: string }).idempotencyKey}`;
        sock.send(
          JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId, status: 'started' } }),
        );
      }
      if (req.method === 'chat.abort') {
        chatAbortSeen = true;
        sock.send(JSON.stringify({ type: 'res', id: req.id, ok: true, payload: {} }));
        setImmediate(() => {
          const params = req.params as { runId: string; sessionKey: string };
          sock.send(
            JSON.stringify({
              type: 'event',
              event: 'chat',
              payload: { runId: params.runId, sessionKey: params.sessionKey, seq: 2, state: 'aborted' },
            }),
          );
        });
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    const controller = new AbortController();
    const frames: UpFrame[] = [];
    const pending = backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f), controller.signal);
    // Wait until connect request is received but not yet acked — abort now
    // happens strictly inside `await ensureConnected()`.
    for (let i = 0; i < 20 && !heldConnect; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(heldConnect, 'connect request should have reached the gateway');
    controller.abort();
    // Release the connect ack so handle() can proceed past ensureConnected.
    const held = heldConnect!;
    held.sock.send(JSON.stringify({ type: 'res', id: held.id, ok: true, payload: {} }));
    await pending;
    assert.ok(chatAbortSeen, 'chat.abort must fire even though abort happened during connect');
    const complete = frames.find((f) => f.type === 'task.complete');
    assert.ok(complete);
    assert.equal(complete!.status.state, 'canceled');
  } finally {
    await fake.close();
  }
});

test('cancel (already aborted): signal aborted on entry emits canceled without touching the gateway', async () => {
  let chatSendSeen = false;
  const fake = await createFakeGateway({
    onRequest: (_sock, req) => {
      if (req.method === 'chat.send') chatSendSeen = true;
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    const controller = new AbortController();
    controller.abort();
    const frames: UpFrame[] = [];
    await backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f), controller.signal);
    const complete = frames.find((f) => f.type === 'task.complete');
    assert.ok(complete);
    assert.equal(complete!.status.state, 'canceled');
    // Give any accidental chat.send a chance to race in.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(chatSendSeen, false, 'pre-aborted task must not hit chat.send');
  } finally {
    await fake.close();
  }
});

test('cancel: chat.abort failure surfaces as gateway_abort_failed instead of hanging', async () => {
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: true,
            payload: { runId: 'run-abortfail', status: 'started' },
          }),
        );
      }
      if (req.method === 'chat.abort') {
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: false,
            error: { code: 'internal', message: 'abort machine broken' },
          }),
        );
      }
    },
  });
  try {
    // Use a large task timeout so the test proves the failure fires via the
    // abort-failed path, not via the generic task-timeout fallback.
    const backend = createOpenclawBackend({ url: fake.url, taskTimeoutMs: 60_000 });
    const controller = new AbortController();
    const frames: UpFrame[] = [];
    const pending = backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f), controller.signal);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await pending;
    const fail = frames.find((f) => f.type === 'task.fail');
    assert.ok(fail, 'task must fail when chat.abort itself fails');
    assert.equal(fail!.error.code, 'gateway_abort_failed');
    assert.match(fail!.error.message, /abort machine broken/);
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
    await backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f), NEVER);
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
    await backend.handle(makeTask('tA', 'hi'), (f) => framesA.push(f), NEVER);
    assert.ok(framesA.find((f) => f.type === 'task.complete'));
    // Give the late duplicate time to arrive and be dropped.
    await new Promise((r) => setTimeout(r, 30));
    const framesB: UpFrame[] = [];
    await backend.handle(makeTask('tB', 'hi'), (f) => framesB.push(f), NEVER);
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
  await backend.handle(makeTask('tA', 'a'), (f) => framesA.push(f), NEVER);
  // Second call must not hang — it should re-enter ensureConnected() cleanly
  // and fail the same way.
  await backend.handle(makeTask('tB', 'b'), (f) => framesB.push(f), NEVER);
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
    await backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f), NEVER);
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
      await backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f), NEVER);
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
    const pending = backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f), NEVER);
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

test('mapPartsToChatInput: text-only parts are joined with newline and carry no attachments', () => {
  const result = mapPartsToChatInput([
    { kind: 'text', text: 'first line' },
    { kind: 'text', text: 'second line' },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.input.message, 'first line\nsecond line');
  assert.deepEqual(result.input.attachments, []);
});

test('mapPartsToChatInput: file part with image bytes maps to an OpenClaw image attachment', () => {
  const result = mapPartsToChatInput([
    { kind: 'text', text: 'describe this' },
    {
      kind: 'file',
      file: { name: 'cat.png', mimeType: 'image/png', bytes: 'AAAA' },
    },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.input.message, 'describe this');
  assert.deepEqual(result.input.attachments, [
    { type: 'image', mimeType: 'image/png', fileName: 'cat.png', content: 'AAAA' },
  ]);
});

test('mapPartsToChatInput: image file without a name omits fileName cleanly', () => {
  const result = mapPartsToChatInput([
    { kind: 'file', file: { mimeType: 'image/jpeg', bytes: 'BBBB' } },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.input.attachments.length, 1);
  assert.equal(result.input.attachments[0].fileName, undefined);
});

test('mapPartsToChatInput: file.uri is rejected explicitly instead of silently dropped', () => {
  const result = mapPartsToChatInput([
    { kind: 'file', file: { uri: 'https://example.com/doc.pdf', mimeType: 'application/pdf' } },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'unsupported_file_uri');
  assert.match(result.error.message, /part\[0\]/);
});

test('mapPartsToChatInput: non-image file mime is rejected', () => {
  const result = mapPartsToChatInput([
    { kind: 'file', file: { mimeType: 'application/pdf', bytes: 'CCCC' } },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'unsupported_file_mime');
  assert.match(result.error.message, /application\/pdf/);
});

test('mapPartsToChatInput: missing both bytes and uri is rejected', () => {
  const result = mapPartsToChatInput([
    { kind: 'file', file: { mimeType: 'image/png' } },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'invalid_file_part');
});

test('mapPartsToChatInput: data part is rejected since OpenClaw has no structured input surface', () => {
  const result = mapPartsToChatInput([
    { kind: 'text', text: 'context follows' },
    { kind: 'data', data: { foo: 'bar', n: 42 } },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'unsupported_data_part');
  // Error should identify the offending part index (index 1 here).
  assert.match(result.error.message, /part\[1\]/);
});

test('handle(): image file part is forwarded to chat.send as attachments', async () => {
  const observedParams: unknown[] = [];
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        observedParams.push(req.params);
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: true,
            payload: { runId: 'run-img', status: 'started' },
          }),
        );
        setImmediate(() => {
          sock.send(
            JSON.stringify({
              type: 'event',
              event: 'chat',
              payload: {
                runId: 'run-img',
                sessionKey: 'agent:main:ctx-t1',
                seq: 1,
                state: 'final',
                message: { text: 'saw a cat' },
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
    const task: TaskAssignFrame = {
      type: 'task.assign',
      taskId: 't1',
      contextId: 'ctx-t1',
      message: {
        role: 'user',
        messageId: 'm1',
        parts: [
          { kind: 'text', text: 'what is in this image?' },
          { kind: 'file', file: { name: 'cat.png', mimeType: 'image/png', bytes: 'AAAA' } },
        ],
      },
    };
    await backend.handle(task, (f) => frames.push(f), NEVER);
    assert.equal(observedParams.length, 1, 'chat.send should have been issued exactly once');
    const params = observedParams[0] as { message: string; attachments: unknown };
    assert.equal(params.message, 'what is in this image?');
    assert.deepEqual(params.attachments, [
      { type: 'image', mimeType: 'image/png', fileName: 'cat.png', content: 'AAAA' },
    ]);
    const complete = frames.find((f) => f.type === 'task.complete');
    assert.ok(complete);
    assert.equal(complete!.status.state, 'completed');
  } finally {
    await fake.close();
  }
});

test('handle(): data part fails fast with unsupported_data_part without touching the gateway', async () => {
  let chatSendSeen = false;
  const fake = await createFakeGateway({
    onRequest: (_sock, req) => {
      if (req.method === 'chat.send') chatSendSeen = true;
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    const frames: UpFrame[] = [];
    const task: TaskAssignFrame = {
      type: 'task.assign',
      taskId: 't1',
      contextId: 'ctx-t1',
      message: {
        role: 'user',
        messageId: 'm1',
        parts: [
          { kind: 'text', text: 'context' },
          { kind: 'data', data: { hello: 'world' } },
        ],
      },
    };
    await backend.handle(task, (f) => frames.push(f), NEVER);
    const fail = frames.find((f) => f.type === 'task.fail');
    assert.ok(fail, 'unsupported data part must fail the task');
    assert.equal(fail!.error.code, 'unsupported_data_part');
    // Give any racing chat.send a chance to land so the assertion is meaningful.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(chatSendSeen, false, 'gateway must not see chat.send for malformed input');
  } finally {
    await fake.close();
  }
});

test('handle(): file.uri fails fast with unsupported_file_uri', async () => {
  let chatSendSeen = false;
  const fake = await createFakeGateway({
    onRequest: (_sock, req) => {
      if (req.method === 'chat.send') chatSendSeen = true;
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    const frames: UpFrame[] = [];
    const task: TaskAssignFrame = {
      type: 'task.assign',
      taskId: 't1',
      contextId: 'ctx-t1',
      message: {
        role: 'user',
        messageId: 'm1',
        parts: [{ kind: 'file', file: { uri: 'https://example.com/x.png', mimeType: 'image/png' } }],
      },
    };
    await backend.handle(task, (f) => frames.push(f), NEVER);
    const fail = frames.find((f) => f.type === 'task.fail');
    assert.ok(fail);
    assert.equal(fail!.error.code, 'unsupported_file_uri');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(chatSendSeen, false);
  } finally {
    await fake.close();
  }
});

test('streaming: assistant session.message events emit as distinct artifacts before final completion', async () => {
  // Simulates openclaw's in-run transcript writes: two assistant messages
  // arrive via session.message, then the chat run terminates with `final`.
  // Each session.message should surface as its own task.artifact (distinct
  // artifactId, lastChunk:true), and the terminal `final` must NOT tack on
  // a redundant final-result artifact because streaming already delivered
  // content. task.complete still carries the final text in status.message.
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method !== 'chat.send') return;
      const params = req.params as { sessionKey: string; idempotencyKey: string };
      const runId = `run-${params.idempotencyKey}`;
      sock.send(
        JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId, status: 'started' } }),
      );
      setImmediate(() => {
        fake.emitSessionMessage(sock, {
          sessionKey: params.sessionKey,
          messageId: 'm1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'thinking out loud' }] },
        });
        fake.emitSessionMessage(sock, {
          sessionKey: params.sessionKey,
          messageId: 'm2',
          message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
        });
        fake.emitChat(sock, {
          runId,
          sessionKey: params.sessionKey,
          seq: 1,
          state: 'final',
          message: { text: 'final answer' },
        });
      });
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    const frames: UpFrame[] = [];
    await backend.handle(makeTask('t-stream', 'hi'), (f) => frames.push(f), NEVER);

    const artifacts = frames.filter((f) => f.type === 'task.artifact');
    assert.equal(artifacts.length, 2, 'each assistant message should emit its own artifact');
    const ids = new Set(artifacts.map((a) => a.artifact.artifactId));
    assert.equal(ids.size, 2, 'artifactIds should be distinct per message (option b: independent artifacts)');
    for (const a of artifacts) {
      assert.equal(a.lastChunk, true, 'each message-artifact is complete on emission');
      assert.equal(a.artifact.name, 'openclaw-message');
    }
    assert.equal(
      (artifacts[0].artifact.parts[0] as { kind: 'text'; text: string }).text,
      'thinking out loud',
    );
    assert.equal(
      (artifacts[1].artifact.parts[0] as { kind: 'text'; text: string }).text,
      'final answer',
    );

    const complete = frames.find((f) => f.type === 'task.complete');
    assert.ok(complete);
    assert.equal(complete!.status.state, 'completed');
    // Sanity: exactly one completion + one status(working) + two artifacts,
    // no third artifact emitted from the final event's text.
    assert.deepEqual(
      frames.map((f) => f.type),
      ['task.status', 'task.artifact', 'task.artifact', 'task.complete'],
    );
  } finally {
    await fake.close();
  }
});

test('streaming: no session.message events falls back to single final-result artifact', async () => {
  // When the gateway never emits session.message (e.g. subscription failed or
  // the agent wrote no intermediate messages), handle() must still behave
  // like today: one final artifact derived from the terminal chat.final
  // message, then task.complete.
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method !== 'chat.send') return;
      const params = req.params as { sessionKey: string; idempotencyKey: string };
      const runId = `run-${params.idempotencyKey}`;
      sock.send(
        JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId, status: 'started' } }),
      );
      setImmediate(() => {
        fake.emitChat(sock, {
          runId,
          sessionKey: params.sessionKey,
          seq: 1,
          state: 'final',
          message: { text: 'hello' },
        });
      });
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    const frames: UpFrame[] = [];
    await backend.handle(makeTask('t-noop', 'hi'), (f) => frames.push(f), NEVER);
    assert.deepEqual(
      frames.map((f) => f.type),
      ['task.status', 'task.artifact', 'task.complete'],
    );
    const artifact = frames.find((f) => f.type === 'task.artifact');
    assert.equal(artifact!.artifact.name, 'openclaw-result');
    assert.equal(
      (artifact!.artifact.parts[0] as { kind: 'text'; text: string }).text,
      'hello',
    );
  } finally {
    await fake.close();
  }
});

test('streaming: non-assistant session.message events are ignored', async () => {
  // Transcript records user inputs and tool outputs as well as assistant
  // replies. Only `role:"assistant"` entries should map to A2A artifacts;
  // echoing user input back would loop the caller's own message to them.
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method !== 'chat.send') return;
      const params = req.params as { sessionKey: string; idempotencyKey: string };
      const runId = `run-${params.idempotencyKey}`;
      sock.send(
        JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId, status: 'started' } }),
      );
      setImmediate(() => {
        fake.emitSessionMessage(sock, {
          sessionKey: params.sessionKey,
          messageId: 'u1',
          message: { role: 'user', content: [{ type: 'text', text: 'the prompt' }] },
        });
        fake.emitSessionMessage(sock, {
          sessionKey: params.sessionKey,
          messageId: 't1',
          message: { role: 'tool', content: [{ type: 'text', text: 'tool output' }] },
        });
        fake.emitSessionMessage(sock, {
          sessionKey: params.sessionKey,
          messageId: 'a1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'the reply' }] },
        });
        fake.emitChat(sock, {
          runId,
          sessionKey: params.sessionKey,
          seq: 1,
          state: 'final',
          message: { text: 'the reply' },
        });
      });
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    const frames: UpFrame[] = [];
    await backend.handle(makeTask('t-roles', 'hi'), (f) => frames.push(f), NEVER);
    const artifacts = frames.filter((f) => f.type === 'task.artifact');
    assert.equal(artifacts.length, 1, 'only the assistant message should emit an artifact');
    assert.equal(
      (artifacts[0].artifact.parts[0] as { kind: 'text'; text: string }).text,
      'the reply',
    );
  } finally {
    await fake.close();
  }
});

test('streaming: duplicate messageId for an assistant message is deduplicated', async () => {
  // openclaw can republish a transcript entry (e.g. after a rewrite). The
  // adapter must not emit two artifacts for the same messageId even though
  // the event payload itself was valid both times.
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method !== 'chat.send') return;
      const params = req.params as { sessionKey: string; idempotencyKey: string };
      const runId = `run-${params.idempotencyKey}`;
      sock.send(
        JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId, status: 'started' } }),
      );
      setImmediate(() => {
        const msg = {
          sessionKey: params.sessionKey,
          messageId: 'dup',
          message: { role: 'assistant', content: [{ type: 'text', text: 'once' }] },
        };
        fake.emitSessionMessage(sock, msg);
        fake.emitSessionMessage(sock, msg);
        fake.emitChat(sock, {
          runId,
          sessionKey: params.sessionKey,
          seq: 1,
          state: 'final',
          message: { text: 'once' },
        });
      });
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    const frames: UpFrame[] = [];
    await backend.handle(makeTask('t-dup', 'hi'), (f) => frames.push(f), NEVER);
    const artifacts = frames.filter((f) => f.type === 'task.artifact');
    assert.equal(artifacts.length, 1, 'duplicate messageId must not double-emit');
  } finally {
    await fake.close();
  }
});

test('streaming: sessions.messages.subscribe RPC failure degrades gracefully to single final artifact', async () => {
  // The subscribe call must not be fatal. If the gateway rejects it (e.g.
  // older openclaw without session message subscription, or scope denied),
  // handle() should log, skip streaming, and behave like the no-events
  // fallback path — one final-result artifact derived from chat.final.
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  const failingGateway = await createFakeGatewaySubscribeError();
  try {
    const backend = createOpenclawBackend({ url: failingGateway.url });
    const frames: UpFrame[] = [];
    await backend.handle(makeTask('t-noSub', 'hi'), (f) => frames.push(f), NEVER);
    assert.deepEqual(
      frames.map((f) => f.type),
      ['task.status', 'task.artifact', 'task.complete'],
    );
    assert.ok(
      warnings.some((w) => w.includes('sessions.messages.subscribe failed')),
      `expected warn about failed subscribe, got: ${warnings.join(' | ')}`,
    );
  } finally {
    console.warn = originalWarn;
    await failingGateway.close();
  }
});

// Dedicated fake gateway that responds with an error to
// `sessions.messages.subscribe` but still handles chat.send normally. Used
// by the graceful-degradation test above; kept separate from the main
// helper because the main helper auto-acks subscribes for convenience.
async function createFakeGatewaySubscribeError(): Promise<FakeGateway> {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const connections: WebSocket[] = [];
  wss.on('connection', (sock) => {
    connections.push(sock);
    sock.send(
      JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'nonce-sub-err' },
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
      if (frame.method === 'connect') {
        sock.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: {} }));
        return;
      }
      if (frame.method === 'sessions.messages.subscribe') {
        sock.send(
          JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: false,
            error: { code: 'forbidden', message: 'subscription unavailable' },
          }),
        );
        return;
      }
      if (frame.method === 'chat.send') {
        const params = frame.params as { sessionKey: string; idempotencyKey: string };
        const runId = `run-${params.idempotencyKey}`;
        sock.send(
          JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { runId, status: 'started' } }),
        );
        setImmediate(() => {
          sock.send(
            JSON.stringify({
              type: 'event',
              event: 'chat',
              payload: {
                runId,
                sessionKey: params.sessionKey,
                seq: 1,
                state: 'final',
                message: { text: 'no-stream result' },
              },
            }),
          );
        });
      }
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    connections,
    waitForConnection: () => Promise.resolve(connections[0]),
    respond: () => undefined,
    respondError: () => undefined,
    emitChat: () => undefined,
    emitSessionMessage: () => undefined,
    closeSocket: () => Promise.resolve(),
    close: async () => {
      for (const s of connections) if (s.readyState !== WebSocket.CLOSED) s.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

test('parseLsofListeningPorts extracts loopback/wildcard listeners and preserves host', () => {
  const sample = [
    'COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'openclaw 1234 me    7u  IPv4 0x1111111111111111      0t0  TCP 127.0.0.1:3000 (LISTEN)',
    'openclaw 1234 me    8u  IPv6 0x2222222222222222      0t0  TCP [::1]:4000 (LISTEN)',
    'openclaw 1234 me    9u  IPv4 0x3333333333333333      0t0  TCP *:18789 (LISTEN)',
    'openclaw 1234 me   10u  IPv4 0x4444444444444444      0t0  TCP 192.168.1.10:5000 (LISTEN)',
    'openclaw 1234 me   11u  IPv4 0x5555555555555555      0t0  TCP 127.0.0.1:6000->127.0.0.1:7000 (ESTABLISHED)',
  ].join('\n');
  const listeners = parseLsofListeningPorts(sample).sort((a, b) => a.port - b.port);
  assert.deepEqual(listeners, [
    { host: '127.0.0.1', port: 3000 },
    { host: '[::1]', port: 4000 },
    { host: '*', port: 18789 },
  ]);
});

test('parseLsofListeningPorts returns empty for empty / header-only input', () => {
  assert.deepEqual(parseLsofListeningPorts(''), []);
  assert.deepEqual(parseLsofListeningPorts('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME'), []);
});

test('listenersToGatewayUrls maps each bind family correctly', () => {
  const tpl = 'ws://127.0.0.1:18789/';
  // IPv4 loopback and IPv4 wildcards stay on IPv4 loopback.
  assert.deepEqual(listenersToGatewayUrls([{ host: '127.0.0.1', port: 3000 }], tpl), ['ws://127.0.0.1:3000/']);
  assert.deepEqual(listenersToGatewayUrls([{ host: '*', port: 5000 }], tpl), ['ws://127.0.0.1:5000/']);
  assert.deepEqual(listenersToGatewayUrls([{ host: '0.0.0.0', port: 5000 }], tpl), ['ws://127.0.0.1:5000/']);
  // IPv6 loopback stays on IPv6.
  assert.deepEqual(listenersToGatewayUrls([{ host: '[::1]', port: 4000 }], tpl), ['ws://[::1]:4000/']);
  // Only the IPv6 wildcard expands to both families — a dual-stack listener
  // is reachable via either 127.0.0.1 or [::1].
  assert.deepEqual(listenersToGatewayUrls([{ host: '[::]', port: 6000 }], tpl).sort(), [
    'ws://127.0.0.1:6000/',
    'ws://[::1]:6000/',
  ]);
});

test('redactUrl strips query, hash, and userinfo but keeps protocol/host/port/path', () => {
  assert.equal(
    redactUrl('wss://user:pass@127.0.0.1:18789/gateway?token=secret#frag'),
    'wss://127.0.0.1:18789/gateway',
  );
  assert.equal(redactUrl('ws://127.0.0.1:3000?token=abc'), 'ws://127.0.0.1:3000/');
  assert.equal(redactUrl('ws://[::1]:4000/path'), 'ws://[::1]:4000/path');
  assert.equal(redactUrl('not a url'), '<unparseable-url>');
});

test('listenersToGatewayUrls preserves template protocol / pathname / search', () => {
  const tpl = 'wss://127.0.0.1:18789/gateway?token=abc#frag';
  assert.deepEqual(listenersToGatewayUrls([{ host: '127.0.0.1', port: 3000 }], tpl), [
    'wss://127.0.0.1:3000/gateway?token=abc#frag',
  ]);
  assert.deepEqual(listenersToGatewayUrls([{ host: '[::1]', port: 3000 }], tpl), [
    'wss://[::1]:3000/gateway?token=abc#frag',
  ]);
});

test('listenersToGatewayUrls preserves template userinfo when credentials are embedded', () => {
  assert.deepEqual(
    listenersToGatewayUrls(
      [{ host: '127.0.0.1', port: 3000 }],
      'ws://user:pass@127.0.0.1:18789/',
    ),
    ['ws://user:pass@127.0.0.1:3000/'],
  );
  // Username-only (no password) is preserved without a trailing colon.
  assert.deepEqual(
    listenersToGatewayUrls([{ host: '[::1]', port: 3000 }], 'ws://user@127.0.0.1:18789/'),
    ['ws://user@[::1]:3000/'],
  );
});

test('listenersToGatewayUrls keeps percent-encoded userinfo intact for reserved chars', () => {
  // `@` in a username and `:` in a password must remain percent-encoded in
  // the rebuilt candidate, otherwise the authority component parses wrong.
  const tpl = 'ws://alice%40admin:p%3Ass@127.0.0.1:18789/gateway';
  const [candidate] = listenersToGatewayUrls([{ host: '127.0.0.1', port: 3000 }], tpl);
  // Round-trip through URL to confirm the encoded userinfo is preserved in
  // URL.username / URL.password for these reserved characters.
  const parsed = new URL(candidate);
  assert.equal(parsed.username, 'alice%40admin');
  assert.equal(parsed.password, 'p%3Ass');
  assert.equal(parsed.host, '127.0.0.1:3000');
  assert.equal(parsed.pathname, '/gateway');
});

test('discovery fallback: when primary URL is dead and no candidates match, original error propagates', async () => {
  const backend = createOpenclawBackend({
    url: 'ws://127.0.0.1:1', // port 1 refuses TCP immediately
    handshakeTimeoutMs: 1500,
    discoverGatewayUrls: async () => [],
  });
  const frames: UpFrame[] = [];
  await backend.handle(makeTask('t-disc', 'hi'), (f) => frames.push(f), NEVER);
  const fail = frames.find((f) => f.type === 'task.fail');
  assert.ok(fail, 'task must fail when no gateway is reachable');
  assert.equal(fail!.error.code, 'gateway_closed');
});

test('discovery fallback: primary URL dead, discovered candidate completes handshake, task succeeds', async () => {
  let runCounter = 0;
  const real = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        const runId = `run-disc-${++runCounter}`;
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
                sessionKey: `agent:main:ctx-td${runCounter}`,
                seq: 1,
                state: 'final',
                message: { text: `discovered-${runCounter}` },
              },
            }),
          );
        });
      }
    },
  });
  let discoverCalls = 0;
  try {
    const backend = createOpenclawBackend({
      url: 'ws://127.0.0.1:1', // dead
      handshakeTimeoutMs: 1500,
      discoverGatewayUrls: async () => {
        discoverCalls++;
        return [real.url];
      },
    });
    const frames: UpFrame[] = [];
    await backend.handle(makeTask('td1', 'hi'), (f) => frames.push(f), NEVER);
    const complete = frames.find((f) => f.type === 'task.complete');
    assert.ok(complete, 'task must complete via discovered URL');
    assert.equal(complete!.status.state, 'completed');
    assert.equal(discoverCalls, 1, 'discover should be invoked once on primary failure');

    // Cache check: close the socket to force a reconnect, then send a second
    // task. ensureConnected() should try the discovered URL directly without
    // invoking discover again.
    const sock = await real.waitForConnection(0);
    await real.closeSocket(sock);
    // Let the client process the WebSocket close event.
    await new Promise((r) => setTimeout(r, 20));
    const frames2: UpFrame[] = [];
    await backend.handle(makeTask('td2', 'hi2'), (f) => frames2.push(f), NEVER);
    const complete2 = frames2.find((f) => f.type === 'task.complete');
    assert.ok(complete2, 'second task must complete on reconnect');
    assert.equal(discoverCalls, 1, 'discover must not re-run when primary (discovered) URL works');
  } finally {
    await real.close();
  }
});

test('discovery: when all candidates fail, the original primary connect error is surfaced', async () => {
  // Candidates are all dead loopback ports. The final task.fail message must
  // match the primary URL's connect error, not whichever candidate happened
  // to fail last — the operator configured the primary URL, that's what
  // diagnostics should point at.
  const backend = createOpenclawBackend({
    url: 'ws://127.0.0.1:1', // dead primary
    handshakeTimeoutMs: 1500,
    discoverGatewayUrls: async () => ['ws://127.0.0.1:2', 'ws://127.0.0.1:3'],
  });
  const frames: UpFrame[] = [];
  await backend.handle(makeTask('t-allfail', 'hi'), (f) => frames.push(f), NEVER);
  const fail = frames.find((f) => f.type === 'task.fail');
  assert.ok(fail);
  assert.equal(fail!.error.code, 'gateway_closed');
  // Primary URL was 127.0.0.1:1. The error message from connect ECONNREFUSED
  // mentions the port that failed. The surfaced error must reference port 1
  // (the configured primary), not 3 (the last candidate).
  assert.ok(
    /127\.0\.0\.1:1\b/.test(fail!.error.message),
    `expected primary URL error (port 1), got: ${fail!.error.message}`,
  );
});

test('discovery errors are swallowed so the primary connect failure still propagates', async () => {
  const backend = createOpenclawBackend({
    url: 'ws://127.0.0.1:1', // dead
    handshakeTimeoutMs: 1500,
    discoverGatewayUrls: async () => {
      throw new Error('boom: discovery exploded');
    },
  });
  const frames: UpFrame[] = [];
  await backend.handle(makeTask('t-boom', 'hi'), (f) => frames.push(f), NEVER);
  const fail = frames.find((f) => f.type === 'task.fail');
  assert.ok(fail, 'task must fail even when discovery itself throws');
  assert.equal(fail!.error.code, 'gateway_closed');
  // The message should be the original connect error, not "boom: discovery
  // exploded" — discovery failures are best-effort and must not mask it.
  assert.ok(
    !/boom: discovery exploded/.test(fail!.error.message),
    `expected primary connect error, got: ${fail!.error.message}`,
  );
});

test('discovery error logging is defensive against non-Error rejections', async () => {
  // Reject with `null` — reading `.message` on it would throw TypeError and
  // could mask the primary connect failure. errorMessage() must render it as
  // a string without throwing, so the primary error still surfaces.
  const backend = createOpenclawBackend({
    url: 'ws://127.0.0.1:1',
    handshakeTimeoutMs: 1500,
    debug: true, // exercise the debug log path
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    discoverGatewayUrls: (async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw null as unknown;
    }) as () => Promise<string[]>,
  });
  const frames: UpFrame[] = [];
  await backend.handle(makeTask('t-null', 'hi'), (f) => frames.push(f), NEVER);
  const fail = frames.find((f) => f.type === 'task.fail');
  assert.ok(fail, 'task must fail, not hang, on a null discovery rejection');
  assert.equal(fail!.error.code, 'gateway_closed');
});

test('discovery runs when configured URL uses a wildcard bind address (0.0.0.0 / ::)', async () => {
  // Users sometimes copy a local bind URL (ws://0.0.0.0:<port>) into config.
  // Those should be treated as local for the purpose of allowing discovery.
  let discoverCalls = 0;
  const backend = createOpenclawBackend({
    url: 'ws://0.0.0.0:1', // wildcard bind, port 1 refuses TCP
    handshakeTimeoutMs: 1500,
    discoverGatewayUrls: async () => {
      discoverCalls++;
      return [];
    },
  });
  const frames: UpFrame[] = [];
  await backend.handle(makeTask('t-wild', 'hi'), (f) => frames.push(f), NEVER);
  assert.equal(discoverCalls, 1, 'discover must run for wildcard bind URLs');
  const fail = frames.find((f) => f.type === 'task.fail');
  assert.ok(fail);
  assert.equal(fail!.error.code, 'gateway_closed');
});

test('discovery skipped when configured URL is remote (non-loopback)', async () => {
  let discoverCalls = 0;
  const backend = createOpenclawBackend({
    // Non-loopback host that cannot connect quickly. Using .invalid TLD keeps
    // DNS resolution local/fast-failing on most platforms, but we also bound
    // the handshake to avoid a long hang.
    url: 'ws://gateway.invalid:9999',
    handshakeTimeoutMs: 1500,
    discoverGatewayUrls: async () => {
      discoverCalls++;
      return ['ws://127.0.0.1:18789'];
    },
  });
  const frames: UpFrame[] = [];
  await backend.handle(makeTask('t-remote', 'hi'), (f) => frames.push(f), NEVER);
  const fail = frames.find((f) => f.type === 'task.fail');
  assert.ok(fail, 'task must fail when remote gateway is unreachable');
  assert.equal(fail!.error.code, 'gateway_closed');
  assert.equal(discoverCalls, 0, 'discover must not be invoked for non-loopback URLs');
});

test('resolveCapabilities: returns streaming:true when gateway accepts sessions.messages.subscribe', async () => {
  const seenMethods: string[] = [];
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      seenMethods.push(req.method);
      if (req.method === 'sessions.messages.unsubscribe') {
        sock.send(JSON.stringify({ type: 'res', id: req.id, ok: true, payload: {} }));
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    assert.ok(backend.resolveCapabilities, 'openclaw backend must expose resolveCapabilities');
    const caps = await backend.resolveCapabilities!();
    assert.deepEqual(caps, { streaming: true });
    assert.ok(
      seenMethods.includes('sessions.messages.subscribe'),
      'probe must have attempted sessions.messages.subscribe',
    );
    assert.ok(
      seenMethods.includes('sessions.messages.unsubscribe'),
      'probe must attempt unsubscribe cleanup after a successful subscribe',
    );
  } finally {
    await fake.close();
  }
});

// Reusable helper for probe tests that need a subscribe error the main fake
// gateway helper cannot express (it auto-acks subscribe before onRequest). The
// teardown terminates existing WebSocket connections before closing the WSS so
// `wss.close()` doesn't hang waiting for the backend's still-open client.
async function createFakeGatewayWithSubscribeResponse(
  subscribeError: { code: string; message: string },
): Promise<FakeGateway> {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const connections: WebSocket[] = [];
  wss.on('connection', (sock) => {
    connections.push(sock);
    sock.send(
      JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: `nonce-probe-${connections.length}` },
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
      if (frame.method === 'connect') {
        sock.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: {} }));
        return;
      }
      if (frame.method === 'sessions.messages.subscribe') {
        sock.send(
          JSON.stringify({ type: 'res', id: frame.id, ok: false, error: subscribeError }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    connections,
    waitForConnection: () => Promise.reject(new Error('not used')),
    respond: () => undefined,
    respondError: () => undefined,
    emitChat: () => undefined,
    emitSessionMessage: () => undefined,
    closeSocket: () => Promise.resolve(),
    async close() {
      for (const s of connections) {
        if (s.readyState !== WebSocket.CLOSED) s.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

test('resolveCapabilities: returns streaming:false when gateway reports unknown method', async () => {
  // Shape matches what OpenClaw v2026.3.13 and earlier return when the RPC
  // doesn't exist: `errorShape(ErrorCodes.INVALID_REQUEST, "unknown method: <name>")`.
  const fake = await createFakeGatewayWithSubscribeResponse({
    code: 'invalid_request',
    message: 'unknown method: sessions.messages.subscribe',
  });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    const caps = await backend.resolveCapabilities!();
    assert.deepEqual(caps, { streaming: false });
    assert.ok(
      warnings.some((w) => w.includes('streaming:false') && w.includes('v2026.3.22')),
      `expected warning about streaming downgrade, got: ${warnings.join(' | ')}`,
    );
  } finally {
    console.warn = originalWarn;
    await fake.close();
  }
});

test('resolveCapabilities: treats non-method errors as "method exists" and keeps streaming:true', async () => {
  // If the gateway implements the RPC but rejects the probe for another
  // reason (scope denied, invalid key, session not found, etc.), the method
  // clearly dispatched — we must not downgrade. Only the literal
  // "unknown method" shape signals absence.
  const fake = await createFakeGatewayWithSubscribeResponse({
    code: 'forbidden',
    message: 'scope operator.read required',
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    const caps = await backend.resolveCapabilities!();
    assert.deepEqual(caps, { streaming: true });
  } finally {
    await fake.close();
  }
});

test('resolveCapabilities: returns empty override when gateway is unreachable', async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const backend = createOpenclawBackend({
      url: 'ws://127.0.0.1:1', // port 1 is almost never listening
      handshakeTimeoutMs: 500,
      discoverGatewayUrls: async () => [],
    });
    const caps = await backend.resolveCapabilities!();
    assert.deepEqual(caps, {}, 'unreachable gateway must leave the card unmodified');
    assert.ok(
      warnings.some((w) => w.includes('capability probe skipped')),
      `expected skip warning, got: ${warnings.join(' | ')}`,
    );
  } finally {
    console.warn = originalWarn;
  }
});

export { createFakeGateway, makeTask };
