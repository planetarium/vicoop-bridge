import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';

// Bind a net server to an ephemeral port, record the port, then close the
// server. The port is unlikely to be rebound by an unrelated process
// before the test reconnects, so ECONNREFUSED is the overwhelmingly
// likely outcome — unlike hard-coding port 1, which can be forwarded or
// listening in some CI environments. It's not a hard guarantee
// (TOCTOU: another process could bind the port between close() and our
// connect), but for an in-process test on loopback the window is small.
async function pickUnusedLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate an unused loopback port'));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}
import {
  composeOpenAICompatUserMessage,
  createOpenclawBackend,
  listenersToGatewayUrls,
  mapPartsToChatInput,
  parseLsofListeningPorts,
  redactUrl,
} from './openclaw.js';
import type { OpenAICompatHistoryEntry } from './claude.js';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  type TaskAssignFrame,
  type UpFrame,
} from '@vicoop-bridge/protocol';

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

test('mapPartsToChatInput: text-only parts are joined with newline and carry no attachments', async () => {
  const result = await mapPartsToChatInput([
    { kind: 'text', text: 'first line' },
    { kind: 'text', text: 'second line' },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.input.message, 'first line\nsecond line');
  assert.deepEqual(result.input.attachments, []);
});

test('mapPartsToChatInput: file part with image bytes maps to an OpenClaw image attachment', async () => {
  const result = await mapPartsToChatInput([
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

test('mapPartsToChatInput: image file without a name omits fileName cleanly', async () => {
  const result = await mapPartsToChatInput([
    { kind: 'file', file: { mimeType: 'image/jpeg', bytes: 'BBBB' } },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.input.attachments.length, 1);
  assert.equal(result.input.attachments[0].fileName, undefined);
});

test('mapPartsToChatInput: file.uri is rejected when URI fetching is disabled', async () => {
  const result = await mapPartsToChatInput([
    { kind: 'file', file: { uri: 'https://example.com/doc.pdf', mimeType: 'application/pdf' } },
  ], { enabled: false });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'unsupported_file_uri');
  assert.match(result.error.message, /part\[0\]/);
});

test('mapPartsToChatInput: file.uri is fetched and mapped to an attachment', async () => {
  const body = Buffer.from('pdf-bytes');
  const result = await mapPartsToChatInput(
    [{ kind: 'file', file: { name: 'doc.pdf', mimeType: 'application/pdf', uri: 'https://example.com/doc.pdf' } }],
    {
      fetchImplForTest: async () =>
        new Response(body, {
          headers: {
            'content-type': 'application/pdf',
            'content-length': String(body.length),
          },
        }),
      resolveHost: async () => ['93.184.216.34'],
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.input.attachments, [
    {
      type: 'file',
      mimeType: 'application/pdf',
      fileName: 'doc.pdf',
      content: body.toString('base64'),
    },
  ]);
});

test('mapPartsToChatInput: non-image file maps to a generic file attachment (OpenClaw >= v2026.4.27 offloads to media://inbound/<id>)', async () => {
  const result = await mapPartsToChatInput([
    { kind: 'text', text: 'summarize' },
    { kind: 'file', file: { name: 'report.pdf', mimeType: 'application/pdf', bytes: 'CCCC' } },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.input.message, 'summarize');
  assert.deepEqual(result.input.attachments, [
    { type: 'file', mimeType: 'application/pdf', fileName: 'report.pdf', content: 'CCCC' },
  ]);
});

test('mapPartsToChatInput: missing both bytes and uri is rejected', async () => {
  const result = await mapPartsToChatInput([
    { kind: 'file', file: { mimeType: 'image/png' } },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'invalid_file_part');
});

test('mapPartsToChatInput: missing mimeType is rejected (gateway needs it for sniff/route)', async () => {
  const result = await mapPartsToChatInput([
    { kind: 'file', file: { name: 'blob.bin', bytes: 'DDDD' } },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'invalid_file_part');
  assert.match(result.error.message, /mimeType/);
});

test('mapPartsToChatInput: data part is serialized into the chat message as a tagged JSON block', async () => {
  const result = await mapPartsToChatInput([
    { kind: 'text', text: 'context follows' },
    { kind: 'data', data: { foo: 'bar', n: 42 } },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.input.attachments, []);
  const msg = result.input.message;
  assert.match(msg, /^context follows\n<context kind="application\/json">\n/);
  assert.ok(msg.includes('"foo": "bar"'));
  assert.ok(msg.includes('"n": 42'));
  assert.ok(msg.endsWith('</context>'));
});

test('mapPartsToChatInput: data-only message produces a chat message with just the JSON context block', async () => {
  const result = await mapPartsToChatInput([
    { kind: 'data', data: { hello: 'world' } },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.input.message, /^<context kind="application\/json">\n/);
  assert.ok(result.input.message.includes('"hello": "world"'));
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

test('handle(): non-image file part is forwarded as a non-image attachment (OpenClaw >= v2026.4.27 will offload it)', async () => {
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
            payload: { runId: 'run-pdf', status: 'started' },
          }),
        );
        setImmediate(() => {
          sock.send(
            JSON.stringify({
              type: 'event',
              event: 'chat',
              payload: {
                runId: 'run-pdf',
                sessionKey: 'agent:main:ctx-t1',
                seq: 1,
                state: 'final',
                message: { text: 'pdf summarized' },
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
          { kind: 'text', text: 'summarize this report' },
          { kind: 'file', file: { name: 'report.pdf', mimeType: 'application/pdf', bytes: 'CCCC' } },
        ],
      },
    };
    await backend.handle(task, (f) => frames.push(f), NEVER);
    assert.equal(observedParams.length, 1, 'chat.send should have been issued exactly once');
    const params = observedParams[0] as { message: string; attachments: unknown };
    assert.equal(params.message, 'summarize this report');
    assert.deepEqual(params.attachments, [
      { type: 'file', mimeType: 'application/pdf', fileName: 'report.pdf', content: 'CCCC' },
    ]);
    const complete = frames.find((f) => f.type === 'task.complete');
    assert.ok(complete);
    assert.equal(complete!.status.state, 'completed');
  } finally {
    await fake.close();
  }
});

test('handle(): data part is folded into the chat.send message as a tagged JSON block', async () => {
  let observedMessage: string | undefined;
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        observedMessage = (req.params as { message?: string } | undefined)?.message;
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: true,
            payload: { runId: 'run-data', status: 'started' },
          }),
        );
        setImmediate(() => {
          sock.send(
            JSON.stringify({
              type: 'event',
              event: 'chat',
              payload: {
                runId: 'run-data',
                sessionKey: 'agent:main:ctx-t1',
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
    assert.equal(fail, undefined, 'data parts must no longer fail the task');
    assert.ok(observedMessage, 'chat.send must have been called with a message');
    assert.match(observedMessage!, /^context\n<context kind="application\/json">\n/);
    assert.ok(observedMessage!.includes('"hello": "world"'));
    assert.ok(observedMessage!.endsWith('</context>'));
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
    const backend = createOpenclawBackend({ url: fake.url, fetchUriPolicy: { enabled: false } });
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
    assert.match(fail!.error.message, /URI fetching is disabled/);
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
  const unreachablePort = await pickUnusedLoopbackPort();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const backend = createOpenclawBackend({
      url: `ws://127.0.0.1:${unreachablePort}`,
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

test('resolveCapabilities: after unknown-method verdict, subsequent handle() skips subscribe and suppresses per-task warn', async () => {
  // Covers the regression Copilot flagged: before this fix, a pre-v2026.3.22
  // gateway would see `ensureSessionMessageSubscription` fire for every task,
  // each producing a "sessions.messages.subscribe failed ... (continuing
  // without streaming)" warn. The probe's verdict must latch so tasks run
  // silently against the known-unsupported gateway.
  const subscribeCalls: Array<{ params: unknown }> = [];
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const sockets: WebSocket[] = [];
  wss.on('connection', (sock) => {
    sockets.push(sock);
    sock.send(
      JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'nonce-latch' },
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
        subscribeCalls.push({ params: frame.params });
        sock.send(
          JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: false,
            error: {
              code: 'invalid_request',
              message: 'unknown method: sessions.messages.subscribe',
            },
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
                message: { text: `done ${params.idempotencyKey}` },
              },
            }),
          );
        });
      }
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const backend = createOpenclawBackend({ url: `ws://127.0.0.1:${port}` });
    const caps = await backend.resolveCapabilities!();
    assert.deepEqual(caps, { streaming: false });
    assert.equal(subscribeCalls.length, 1, 'probe must call subscribe exactly once');

    const frames1: UpFrame[] = [];
    await backend.handle(makeTask('t-latch-1', 'hi'), (f) => frames1.push(f), NEVER);
    const frames2: UpFrame[] = [];
    await backend.handle(makeTask('t-latch-2', 'hi'), (f) => frames2.push(f), NEVER);

    assert.equal(
      subscribeCalls.length,
      1,
      'tasks after the unknown-method verdict must not re-attempt subscribe',
    );
    const perTaskWarns = warnings.filter((w) =>
      w.includes('sessions.messages.subscribe failed for agent:'),
    );
    assert.equal(
      perTaskWarns.length,
      0,
      `per-task subscribe warnings must be suppressed, got: ${perTaskWarns.join(' | ')}`,
    );
  } finally {
    console.warn = originalWarn;
    for (const s of sockets) {
      if (s.readyState !== WebSocket.CLOSED) s.terminate();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// agent -> caller file delivery via [bridge-attach: <path>] markers
// ---------------------------------------------------------------------------

async function attachOutputsRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-attach-test-'));
  return await fs.realpath(dir);
}

test('attachOutputs (streaming): assistant message with bridge-attach marker emits a FilePart in the artifact', async () => {
  const root = await attachOutputsRoot();
  const filePath = path.join(root, 'report.pdf');
  const content = Buffer.from('PDF-FAKE-BYTES-FOR-TEST');
  await fs.writeFile(filePath, content);

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
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `here is the report [bridge-attach: ${filePath}] enjoy`,
              },
            ],
          },
        });
        fake.emitChat(sock, {
          runId,
          sessionKey: params.sessionKey,
          seq: 1,
          state: 'final',
          message: { text: 'done' },
        });
      });
    },
  });
  try {
    const backend = createOpenclawBackend({
      url: fake.url,
      attachOutputs: { allowedRoots: [root] },
    });
    const frames: UpFrame[] = [];
    await backend.handle(makeTask('t-attach-stream', 'do it'), (f) => frames.push(f), NEVER);

    const artifacts = frames.filter((f) => f.type === 'task.artifact');
    assert.equal(artifacts.length, 1, 'one streaming artifact (final not duplicated)');
    const parts = artifacts[0].artifact.parts;
    const textPart = parts.find((p) => p.kind === 'text');
    const filePart = parts.find((p) => p.kind === 'file');
    assert.ok(textPart, 'artifact must include cleaned text');
    assert.ok(filePart, 'artifact must include the resolved file');
    assert.equal(
      (textPart as { kind: 'text'; text: string }).text.includes('[bridge-attach:'),
      false,
      'successful marker must be stripped from artifact text',
    );
    const f = (filePart as { kind: 'file'; file: { name?: string; mimeType?: string; bytes?: string } }).file;
    assert.equal(f.mimeType, 'application/pdf');
    assert.equal(f.name, 'report.pdf');
    assert.ok(f.bytes, 'file must carry inline base64 bytes');
    assert.equal(Buffer.from(f.bytes!, 'base64').toString('utf8'), content.toString('utf8'));

    const complete = frames.find((f) => f.type === 'task.complete');
    assert.ok(complete);
    assert.equal(complete!.status.state, 'completed');
  } finally {
    await fake.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('attachOutputs (non-streaming): final-result artifact carries text + FilePart when streaming produced nothing', async () => {
  const root = await attachOutputsRoot();
  const filePath = path.join(root, 'graph.png');
  const content = Buffer.from('PNGDATA');
  await fs.writeFile(filePath, content);

  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'sessions.messages.subscribe') {
        // Simulate gateway without streaming so we exit via the final
        // (non-streaming) artifact path.
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: false,
            error: { code: 'unknown_method', message: 'unknown method: sessions.messages.subscribe' },
          }),
        );
        return;
      }
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
          message: { text: `done. see [bridge-attach: ${filePath}] for the chart` },
        });
      });
    },
  });
  try {
    const backend = createOpenclawBackend({
      url: fake.url,
      attachOutputs: { allowedRoots: [root] },
    });
    const frames: UpFrame[] = [];
    await backend.handle(makeTask('t-attach-final', 'plot it'), (f) => frames.push(f), NEVER);

    const artifacts = frames.filter((f) => f.type === 'task.artifact');
    assert.equal(artifacts.length, 1);
    const parts = artifacts[0].artifact.parts;
    const filePart = parts.find((p) => p.kind === 'file') as
      | { kind: 'file'; file: { mimeType?: string; bytes?: string } }
      | undefined;
    assert.ok(filePart, 'final artifact must include the resolved file');
    assert.equal(filePart!.file.mimeType, 'image/png');
    assert.equal(Buffer.from(filePart!.file.bytes!, 'base64').toString('utf8'), 'PNGDATA');

    const complete = frames.find((f) => f.type === 'task.complete');
    assert.ok(complete);
    const completeText = (complete!.status.message!.parts[0] as { kind: 'text'; text: string }).text;
    assert.equal(
      completeText.includes('[bridge-attach:'),
      false,
      'task.complete status.message must also have successful marker stripped',
    );
  } finally {
    await fake.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('attachOutputs: marker pointing outside allowedRoots is preserved as text and warns (no FilePart)', async () => {
  const root = await attachOutputsRoot();
  const outside = await attachOutputsRoot();
  const outsideFile = path.join(outside, 'secret.txt');
  await fs.writeFile(outsideFile, 'secret');

  const warnLog: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnLog.push(args.map(String).join(' '));
  };

  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'sessions.messages.subscribe') {
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: false,
            error: { code: 'unknown_method', message: 'unknown method' },
          }),
        );
        return;
      }
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
          message: { text: `try [bridge-attach: ${outsideFile}] now` },
        });
      });
    },
  });
  try {
    const backend = createOpenclawBackend({
      url: fake.url,
      attachOutputs: { allowedRoots: [root] },
    });
    const frames: UpFrame[] = [];
    await backend.handle(makeTask('t-attach-escape', 'leak'), (f) => frames.push(f), NEVER);

    const artifacts = frames.filter((f) => f.type === 'task.artifact');
    assert.equal(artifacts.length, 1);
    const parts = artifacts[0].artifact.parts;
    const fileParts = parts.filter((p) => p.kind === 'file');
    assert.equal(fileParts.length, 0, 'no FilePart for outside-root marker');
    const textPart = parts.find((p) => p.kind === 'text') as { kind: 'text'; text: string };
    assert.ok(
      textPart.text.includes('[bridge-attach:'),
      'marker must remain visible so operator can debug',
    );
    assert.ok(
      warnLog.some((m) => m.includes('bridge-attach skipped') && m.includes('outside-roots')),
      `expected outside-roots warn, got: ${warnLog.join(' | ')}`,
    );
  } finally {
    console.warn = originalWarn;
    await fake.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('attachOutputs disabled (default): bridge-attach markers are passed through as plain text, no disk read', async () => {
  const root = await attachOutputsRoot();
  const filePath = path.join(root, 'should-not-be-read.txt');
  await fs.writeFile(filePath, 'never read');

  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'sessions.messages.subscribe') {
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: false,
            error: { code: 'unknown_method', message: 'unknown method' },
          }),
        );
        return;
      }
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
          message: { text: `[bridge-attach: ${filePath}] inline` },
        });
      });
    },
  });
  try {
    // No attachOutputs option -> feature off.
    const backend = createOpenclawBackend({ url: fake.url });
    const frames: UpFrame[] = [];
    await backend.handle(makeTask('t-attach-off', 'go'), (f) => frames.push(f), NEVER);

    const artifacts = frames.filter((f) => f.type === 'task.artifact');
    const parts = artifacts[0].artifact.parts;
    assert.equal(parts.filter((p) => p.kind === 'file').length, 0, 'no FilePart when feature is off');
    const textPart = parts.find((p) => p.kind === 'text') as { kind: 'text'; text: string };
    assert.ok(textPart.text.includes('[bridge-attach:'), 'marker must remain in text');
  } finally {
    await fake.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('attachOutputs: oversized file is skipped with a too-large warning, marker preserved', async () => {
  const root = await attachOutputsRoot();
  const filePath = path.join(root, 'big.bin');
  await fs.writeFile(filePath, Buffer.alloc(2048));

  const warnLog: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnLog.push(args.map(String).join(' '));
  };

  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'sessions.messages.subscribe') {
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: false,
            error: { code: 'unknown_method', message: 'unknown method' },
          }),
        );
        return;
      }
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
          message: { text: `[bridge-attach: ${filePath}]` },
        });
      });
    },
  });
  try {
    const backend = createOpenclawBackend({
      url: fake.url,
      attachOutputs: { allowedRoots: [root], maxBytes: 1024 },
    });
    const frames: UpFrame[] = [];
    await backend.handle(makeTask('t-attach-toobig', 'go'), (f) => frames.push(f), NEVER);

    const artifacts = frames.filter((f) => f.type === 'task.artifact');
    const parts = artifacts[0].artifact.parts;
    assert.equal(parts.filter((p) => p.kind === 'file').length, 0, 'oversized file must be skipped');
    assert.ok(
      warnLog.some((m) => m.includes('too-large')),
      `expected too-large warn, got: ${warnLog.join(' | ')}`,
    );
  } finally {
    console.warn = originalWarn;
    await fake.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// sendFileMcp wiring (MCP tool path) — integration with handle()
// ---------------------------------------------------------------------------

test('sendFileMcp: handle() registers active task; tool call during run emits FilePart artifact through the same emit; releases on completion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-mcp-int-'));
  const realRoot = await fs.realpath(root);
  const filePath = path.join(realRoot, 'tool-out.txt');
  await fs.writeFile(filePath, 'tool-emitted bytes');

  // Hold the chat run open until the test triggers a tool call so we can
  // observe the FilePart artifact emit BEFORE task.complete lands.
  let releaseRun: (() => void) | null = null;
  const runHeld = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });

  const fake = await createFakeGateway({
    onRequest: async (sock, req) => {
      if (req.method === 'sessions.messages.subscribe') {
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: false,
            error: { code: 'unknown_method', message: 'unknown method' },
          }),
        );
        return;
      }
      if (req.method !== 'chat.send') return;
      const params = req.params as { sessionKey: string; idempotencyKey: string };
      const runId = `run-${params.idempotencyKey}`;
      sock.send(
        JSON.stringify({
          type: 'res',
          id: req.id,
          ok: true,
          payload: { runId, status: 'started' },
        }),
      );
      // Wait until the test invokes the tool, then send terminal final.
      await runHeld;
      sock.send(
        JSON.stringify({
          type: 'event',
          event: 'chat',
          payload: {
            runId,
            sessionKey: params.sessionKey,
            seq: 1,
            state: 'final',
            message: { text: 'done' },
          },
        }),
      );
    },
  });
  try {
    const backend = createOpenclawBackend({
      url: fake.url,
      sendFileMcp: { allowedRoots: [realRoot] },
    });
    const frames: UpFrame[] = [];
    const handlePromise = backend.handle(
      makeTask('t-mcp-int', 'go'),
      (f) => frames.push(f),
      NEVER,
    );

    // Wait until the MCP server is up and the task has been registered.
    // The lazy start happens inside handle(); poll briefly.
    let server = backend.getSendFileMcpServer();
    for (let i = 0; i < 50 && (!server || server.activeTaskCount() === 0); i++) {
      await new Promise((r) => setTimeout(r, 20));
      server = backend.getSendFileMcpServer();
    }
    assert.ok(server, 'MCP server should have started lazily during handle()');
    assert.equal(server!.activeTaskCount(), 1, 'task should be registered while in flight');

    // Invoke send_file directly via the test hook (bypasses HTTP transport).
    const result = await server!.invokeSendFileForTest({ path: filePath });
    assert.equal(result.ok, true);

    // Release the gateway run so handle() can settle.
    releaseRun!();
    await handlePromise;

    // After completion, the registry slot should be released.
    assert.equal(server!.activeTaskCount(), 0, 'task should be released after handle() returns');

    // The FilePart artifact emitted via the MCP tool should appear in the frames.
    const artifacts = frames.filter((f) => f.type === 'task.artifact');
    const fileArtifact = artifacts.find((a) =>
      a.artifact.parts.some((p) => p.kind === 'file'),
    );
    assert.ok(fileArtifact, 'a FilePart artifact must have been emitted via the tool path');
    const filePart = fileArtifact!.artifact.parts.find((p) => p.kind === 'file') as
      | { kind: 'file'; file: { name?: string; mimeType?: string; bytes?: string } }
      | undefined;
    assert.equal(filePart!.file.name, 'tool-out.txt');
    assert.equal(filePart!.file.mimeType, 'text/plain');
    assert.equal(
      Buffer.from(filePart!.file.bytes!, 'base64').toString('utf8'),
      'tool-emitted bytes',
    );

    // Because the MCP tool already emitted an artifact, the final-result
    // path should NOT have produced a duplicate text artifact.
    const finalArtifacts = artifacts.filter(
      (a) => a.artifact.name === 'openclaw-result',
    );
    assert.equal(
      finalArtifacts.length,
      0,
      'final-result artifact must not be emitted when the tool already produced one',
    );

    const complete = frames.find((f) => f.type === 'task.complete');
    assert.ok(complete);
    assert.equal(complete!.status.state, 'completed');

    const finalServer = backend.getSendFileMcpServer();
    if (finalServer) await finalServer.close();
  } finally {
    await fake.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('sendFileMcp: not configured -> getSendFileMcpServer() stays null even after handle() runs', async () => {
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'sessions.messages.subscribe') {
        sock.send(JSON.stringify({ type: 'res', id: req.id, ok: false, error: { code: 'unknown_method', message: 'unknown method' } }));
        return;
      }
      if (req.method !== 'chat.send') return;
      const params = req.params as { sessionKey: string; idempotencyKey: string };
      const runId = `run-${params.idempotencyKey}`;
      sock.send(JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId, status: 'started' } }));
      setImmediate(() => {
        fake.emitChat(sock, {
          runId,
          sessionKey: params.sessionKey,
          seq: 1,
          state: 'final',
          message: { text: 'no tool today' },
        });
      });
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    await backend.handle(makeTask('t-no-mcp', 'go'), () => {}, NEVER);
    assert.equal(
      backend.getSendFileMcpServer(),
      null,
      'no MCP server should be lazily started when sendFileMcp is unset',
    );
  } finally {
    await fake.close();
  }
});

test('heartbeat: emits task.status after heartbeatMs of silence and stops at terminal time', async () => {
  // Initialize as a no-op so the type stays `() => void` instead of
  // `(() => void) | null`. The closure-mutation path through setIntervalFn
  // confuses TS narrowing — easier to start callable.
  let scheduledFn: () => void = () => {};
  let scheduled = false;
  let cleared = false;
  let nowMs = 1_000_000;

  // Hold the chat.send ack so the task stays mid-flight while we drive
  // heartbeat ticks before the run terminates and clears the interval.
  let releaseFinish: () => void = () => {};
  const finishReady = new Promise<void>((r) => {
    releaseFinish = r;
  });
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method !== 'chat.send') return;
      void (async () => {
        await finishReady;
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: true,
            payload: { runId: 'run-hb', status: 'started' },
          }),
        );
        setImmediate(() => {
          fake.emitChat(sock, {
            runId: 'run-hb',
            sessionKey: 'agent:main:ctx-t1',
            seq: 1,
            state: 'final',
            message: { text: 'done' },
          });
        });
      })();
    },
  });
  try {
    const backend = createOpenclawBackend({
      url: fake.url,
      heartbeatMs: 100,
      now: () => nowMs,
      setIntervalFn: (fn) => {
        scheduledFn = fn;
        scheduled = true;
        return { tag: 'fake-interval' };
      },
      clearIntervalFn: () => {
        cleared = true;
      },
    });
    const frames: UpFrame[] = [];
    const runP = backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f), NEVER);

    // Wait for ensureConnected + sessions.messages.subscribe + chat.send
    // to land before driving ticks. 50ms is enough on loopback.
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(scheduled, 'heartbeat must register a setInterval handler');

    const countStatus = () => frames.filter((f) => f.type === 'task.status').length;
    assert.equal(countStatus(), 1, 'only the initial task.status: working has been emitted');

    // Tick with no elapsed time → silence < heartbeat → skip.
    scheduledFn();
    assert.equal(countStatus(), 1);

    // Advance past the heartbeat threshold → tick must emit one status.
    nowMs += 250;
    scheduledFn();
    assert.equal(countStatus(), 2);

    // Subsequent tick at the same instant must NOT double-fire — the prior
    // emit refreshed lastEmitAt through the wrapped emitter.
    scheduledFn();
    assert.equal(countStatus(), 2);

    // Real traffic also resets the silence window. Let the gateway send
    // its ack + final event.
    releaseFinish();
    await runP;

    assert.ok(cleared, 'heartbeat handle must be cleared at terminal time');
    // After the terminal frame, no more status frames may be added even if
    // a stale tick fires (the `terminalSettled` guard inside the closure
    // protects against this — exercise it explicitly).
    scheduledFn();
    const lastStatusAfterTerminal = countStatus();
    assert.equal(
      lastStatusAfterTerminal,
      2,
      'no heartbeat allowed after terminal frame',
    );
  } finally {
    await fake.close();
  }
});

test('heartbeat: heartbeatMs:0 disables the interval entirely', async () => {
  let registered = false;
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method !== 'chat.send') return;
      sock.send(
        JSON.stringify({
          type: 'res',
          id: req.id,
          ok: true,
          payload: { runId: 'run-hb0', status: 'started' },
        }),
      );
      setImmediate(() => {
        fake.emitChat(sock, {
          runId: 'run-hb0',
          sessionKey: 'agent:main:ctx-t1',
          seq: 1,
          state: 'final',
          message: { text: 'ok' },
        });
      });
    },
  });
  try {
    const backend = createOpenclawBackend({
      url: fake.url,
      heartbeatMs: 0,
      setIntervalFn: () => {
        registered = true;
        return null;
      },
      clearIntervalFn: () => {},
    });
    await backend.handle(makeTask('t1', 'hi'), () => {}, NEVER);
    assert.equal(registered, false, 'heartbeatMs:0 must skip setInterval registration');
  } finally {
    await fake.close();
  }
});

test('heartbeat: suppressed after signal.abort so canceled tasks do not look like they are still working', async () => {
  let scheduledFn: () => void = () => {};
  let nowMs = 1_000_000;
  let activeRunId: string | null = null;
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        activeRunId = `run-${(req.params as { idempotencyKey: string }).idempotencyKey}`;
        sock.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: true,
            payload: { runId: activeRunId, status: 'started' },
          }),
        );
        // Stay silent — the test drives the run to abort.
      }
      if (req.method === 'chat.abort') {
        sock.send(JSON.stringify({ type: 'res', id: req.id, ok: true, payload: {} }));
        setImmediate(() => {
          fake.emitChat(sock, {
            runId: activeRunId,
            sessionKey: 'agent:main:ctx-t1',
            seq: 2,
            state: 'aborted',
          });
        });
      }
    },
  });
  try {
    const backend = createOpenclawBackend({
      url: fake.url,
      heartbeatMs: 100,
      now: () => nowMs,
      setIntervalFn: (fn) => {
        scheduledFn = fn;
        return { tag: 'fake-interval' };
      },
      clearIntervalFn: () => {},
    });
    const controller = new AbortController();
    const frames: UpFrame[] = [];
    const runP = backend.handle(makeTask('t1', 'hi'), (f) => frames.push(f), controller.signal);
    // Let the chat.send round-trip land.
    await new Promise((r) => setTimeout(r, 50));

    // Sanity: the heartbeat fires while the task is still working.
    nowMs += 250;
    scheduledFn();
    const before = frames.filter((f) => f.type === 'task.status').length;
    assert.ok(
      before >= 2,
      'heartbeat must emit at least one extra task.status while working',
    );

    // Abort. Subsequent heartbeat ticks must NOT add more `state: working`
    // status frames — the run is on its way to a `canceled` terminal frame.
    controller.abort();
    nowMs += 250;
    scheduledFn();
    nowMs += 250;
    scheduledFn();

    await runP;

    const workingStatusCount = frames.filter(
      (f) =>
        f.type === 'task.status' &&
        (f as Extract<UpFrame, { type: 'task.status' }>).status.state === 'working',
    ).length;
    assert.equal(
      workingStatusCount,
      before,
      'no extra working-state heartbeats may land between abort and terminal frame',
    );
    const last = frames.at(-1) as Extract<UpFrame, { type: 'task.complete' }>;
    assert.equal(last.type, 'task.complete');
    assert.equal(last.status.state, 'canceled');
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// openai-compat extension
//
// The pure helpers (parseOpenAICompatMetadata, buildOpenAICompatSystemPrompt,
// formatToolCallHistory, tryParseToolCallsEnvelope) live in claude.ts and are
// covered by claude.test.ts — openclaw.ts imports them verbatim, so we only
// test the openclaw-specific wiring here: chat.send.message composition with
// the XML-wrapped contract blocks, envelope→data-part on session.message,
// non-streaming envelope on the terminal chat event, and the false-positive
// defence when the extension is off.
// ---------------------------------------------------------------------------

const OAI_SAMPLE_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
      },
    },
  },
];

const OAI_SAMPLE_HISTORY: OpenAICompatHistoryEntry[] = [
  {
    role: 'assistant',
    tool_calls: [
      { id: 'call_abc', function: { name: 'get_weather', arguments: { city: 'Seoul' } } },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'call_abc',
    name: 'get_weather',
    content: '{"temp":15,"cond":"sunny"}',
  },
];

function makeOpenAICompatTask(
  taskId: string,
  text: string,
  payload: Record<string, unknown>,
  contextId = `ctx-${taskId}`,
): TaskAssignFrame {
  return {
    type: 'task.assign',
    taskId,
    contextId,
    message: {
      role: 'user',
      messageId: `msg-${taskId}`,
      parts: [{ kind: 'text', text }],
      metadata: { [OPENAI_COMPAT_EXTENSION_URI]: payload },
    },
  };
}

test('composeOpenAICompatUserMessage: wraps system_instructions + user_message with tools+tool_choice present', () => {
  const out = composeOpenAICompatUserMessage(
    { tools: OAI_SAMPLE_TOOLS, tool_choice: 'auto', system: 'Be terse.' },
    'what is the weather?',
  );
  // User system precedes the envelope contract inside the system_instructions block.
  assert.match(out, /^<system_instructions>\nBe terse\./);
  // Envelope contract wording (the precise text the LLM is being trained
  // against at runtime — pinned to detect accidental rewordings).
  assert.match(out, /"tool_calls":\[\{"id":"call_<unique>"/);
  // tools JSON inlined inside the block.
  assert.match(out, /"name": "get_weather"/);
  // tool_choice descriptor present in the same block.
  assert.match(out, /tool_choice="auto"/);
  // system_instructions block closes before user_message opens.
  assert.match(out, /<\/system_instructions>\n\n<user_message>/);
  // User content sits inside user_message verbatim, no extra wrapping.
  assert.match(out, /<user_message>\nwhat is the weather\?\n<\/user_message>$/);
});

test('composeOpenAICompatUserMessage: history-only payload omits system_instructions but still wraps user content + history', () => {
  // No tools / no system / no tool_choice → buildOpenAICompatSystemPrompt
  // returns "". We MUST NOT emit an empty <system_instructions></system_instructions>
  // shell (the block-presence-vs-absence signal is part of the contract).
  const out = composeOpenAICompatUserMessage(
    { tool_call_history: OAI_SAMPLE_HISTORY },
    'continue, please',
  );
  assert.doesNotMatch(out, /<system_instructions>/);
  // History block is still injected — spec contract requires per-turn replay.
  assert.match(out, /^<tool_call_history>\n/);
  assert.match(out, /"role": "assistant"/);
  assert.match(out, /"tool_call_id": "call_abc"/);
  assert.match(out, /\n<\/tool_call_history_note>\n\n<user_message>/);
  // User content follows.
  assert.match(out, /<user_message>\ncontinue, please\n<\/user_message>$/);
});

test('composeOpenAICompatUserMessage: tool_choice="none" suppresses envelope contract but keeps no-envelope directive', () => {
  const out = composeOpenAICompatUserMessage(
    { tools: OAI_SAMPLE_TOOLS, tool_choice: 'none' },
    'hi',
  );
  // The envelope contract block is gone under tool_choice="none".
  assert.doesNotMatch(out, /"tool_calls":\[\{"id":"call_<unique>"/);
  // The explicit "do not use the envelope" directive replaces it.
  assert.match(out, /tool_choice="none"/);
});

test('chat.send.message carries the XML-wrapped envelope contract when metadata is present', async () => {
  let sentMessage: string | null = null;
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        sentMessage = (req.params as { message: string }).message;
        sock.send(
          JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId: 'r-oai', status: 'started' } }),
        );
        setImmediate(() => {
          fake.emitChat(sock, {
            runId: 'r-oai',
            sessionKey: 'agent:main:ctx-t-oai-argv',
            seq: 1,
            state: 'final',
            // Reply with the envelope so we don't trip the natural-language path.
            message: { text: '{"tool_calls":[{"id":"call_1","function":{"name":"get_weather","arguments":{"city":"Seoul"}}}]}' },
          });
        });
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    await backend.handle(
      makeOpenAICompatTask('t-oai-argv', 'what is the weather?', {
        tools: OAI_SAMPLE_TOOLS,
        tool_choice: 'auto',
      }),
      () => {},
      NEVER,
    );
    assert.ok(sentMessage, 'expected chat.send to fire');
    // The user content was wrapped by the helper before reaching chat.send.
    assert.match(sentMessage!, /^<system_instructions>/);
    assert.match(sentMessage!, /"tool_calls":\[\{"id":"call_<unique>"/);
    assert.match(sentMessage!, /<user_message>\nwhat is the weather\?\n<\/user_message>$/);
  } finally {
    await fake.close();
  }
});

test('absent metadata → chat.send.message is the raw user text (no XML wrapper leaks)', async () => {
  // Guards against the XML wrapping accidentally activating on non-extension
  // tasks (e.g. if metadata parsing started returning a non-null sentinel
  // for shapes that should really be treated as absent).
  let sentMessage: string | null = null;
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        sentMessage = (req.params as { message: string }).message;
        sock.send(
          JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId: 'r-plain', status: 'started' } }),
        );
        setImmediate(() => {
          fake.emitChat(sock, {
            runId: 'r-plain',
            sessionKey: 'agent:main:ctx-t-plain',
            seq: 1,
            state: 'final',
            message: { text: 'ok' },
          });
        });
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    await backend.handle(makeTask('t-plain', 'just a plain hello'), () => {}, NEVER);
    assert.equal(sentMessage, 'just a plain hello');
  } finally {
    await fake.close();
  }
});

test('envelope JSON on session.message becomes a data-part artifact tagged with the extension URI', async () => {
  const frames: UpFrame[] = [];
  const envelope = {
    tool_calls: [
      { id: 'call_abc', function: { name: 'get_weather', arguments: { city: 'Seoul' } } },
    ],
  };
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        sock.send(
          JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId: 'r-env', status: 'started' } }),
        );
        setImmediate(() => {
          fake.emitSessionMessage(sock, {
            sessionKey: 'agent:main:ctx-t-env',
            messageId: 'mid-1',
            message: { role: 'assistant', text: JSON.stringify(envelope) },
          });
          setImmediate(() => {
            fake.emitChat(sock, {
              runId: 'r-env',
              sessionKey: 'agent:main:ctx-t-env',
              seq: 1,
              state: 'final',
              message: { text: JSON.stringify(envelope) },
            });
          });
        });
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    await backend.handle(
      makeOpenAICompatTask('t-env', 'what is the weather in Seoul?', { tools: OAI_SAMPLE_TOOLS }),
      (f) => frames.push(f),
      NEVER,
    );
    const artifacts = frames.filter(
      (f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact',
    );
    assert.equal(artifacts.length, 1);
    const part = artifacts[0].artifact.parts[0];
    assert.equal(part.kind, 'data');
    if (part.kind !== 'data') throw new Error('expected data part');
    assert.deepEqual(part.data, envelope);
    assert.deepEqual(artifacts[0].artifact.extensions, [OPENAI_COMPAT_EXTENSION_URI]);
  } finally {
    await fake.close();
  }
});

test('envelope JSON arriving only on the terminal chat event (no session.message) still becomes a data-part artifact', async () => {
  // Non-streaming fallback: the gateway never broadcasts session.message
  // (older image, or this task lost streaming ownership to a concurrent
  // peer). The bridge MUST still surface the envelope via the terminal
  // chat 'final' event so the cooperating gateway sees `tool_calls`.
  const frames: UpFrame[] = [];
  const envelope = {
    tool_calls: [
      { id: 'call_xyz', function: { name: 'get_weather', arguments: { city: 'Seoul' } } },
    ],
  };
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        sock.send(
          JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId: 'r-env-nostream', status: 'started' } }),
        );
        setImmediate(() => {
          // NO session.message emit — go straight to terminal.
          fake.emitChat(sock, {
            runId: 'r-env-nostream',
            sessionKey: 'agent:main:ctx-t-env-nostream',
            seq: 1,
            state: 'final',
            message: { text: JSON.stringify(envelope) },
          });
        });
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    await backend.handle(
      makeOpenAICompatTask('t-env-nostream', 'what is the weather?', { tools: OAI_SAMPLE_TOOLS }),
      (f) => frames.push(f),
      NEVER,
    );
    const artifacts = frames.filter(
      (f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact',
    );
    assert.equal(artifacts.length, 1);
    const part = artifacts[0].artifact.parts[0];
    assert.equal(part.kind, 'data');
    if (part.kind !== 'data') throw new Error('expected data part');
    assert.deepEqual(part.data, envelope);
    assert.deepEqual(artifacts[0].artifact.extensions, [OPENAI_COMPAT_EXTENSION_URI]);
    // task.complete still carries the envelope JSON as text in status.message
    // (mirrors claude/codex: data-part is the primary surface, text in the
    // terminal slot is the conventional A2A mirror).
    const complete = frames.find((f) => f.type === 'task.complete');
    assert.ok(complete && complete.type === 'task.complete');
    const stamped = complete.status.message?.parts[0];
    assert.equal(stamped?.kind, 'text');
    if (stamped?.kind === 'text') assert.equal(stamped.text, JSON.stringify(envelope));
  } finally {
    await fake.close();
  }
});

test('extension off: a coincidental {"tool_calls":[...]} reply stays a text artifact', async () => {
  // Without the extension we don't claim any envelope contract is in force,
  // so a JSON-shaped reply from a non-cooperating task MUST NOT be routed
  // as a tool call. Guards against false-positive routing.
  const frames: UpFrame[] = [];
  const coincidental = JSON.stringify({ tool_calls: [] });
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        sock.send(
          JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId: 'r-coincidental', status: 'started' } }),
        );
        setImmediate(() => {
          fake.emitSessionMessage(sock, {
            sessionKey: 'agent:main:ctx-t-coincidental',
            messageId: 'mid-c',
            message: { role: 'assistant', text: coincidental },
          });
          setImmediate(() => {
            fake.emitChat(sock, {
              runId: 'r-coincidental',
              sessionKey: 'agent:main:ctx-t-coincidental',
              seq: 1,
              state: 'final',
              message: { text: coincidental },
            });
          });
        });
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    await backend.handle(makeTask('t-coincidental', 'hi'), (f) => frames.push(f), NEVER);
    const artifacts = frames.filter(
      (f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact',
    );
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].artifact.parts[0].kind, 'text');
    assert.equal(artifacts[0].artifact.extensions, undefined);
  } finally {
    await fake.close();
  }
});

test('extension on but model answered in prose → text artifact, no extension tag', async () => {
  // The extension being active does not mean every turn is a tool turn:
  // a tool_choice="auto" model is free to answer in natural language, and
  // a non-cooperating host model may refuse the envelope contract entirely.
  // Either way, non-envelope text must flow through as a text artifact
  // without the extension URI tag — mis-claiming the contract was honored
  // would mislead the upstream gateway.
  const frames: UpFrame[] = [];
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        sock.send(
          JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId: 'r-prose', status: 'started' } }),
        );
        setImmediate(() => {
          fake.emitSessionMessage(sock, {
            sessionKey: 'agent:main:ctx-t-prose',
            messageId: 'mid-p',
            message: { role: 'assistant', text: 'No tool needed; the answer is 42.' },
          });
          setImmediate(() => {
            fake.emitChat(sock, {
              runId: 'r-prose',
              sessionKey: 'agent:main:ctx-t-prose',
              seq: 1,
              state: 'final',
              message: { text: 'No tool needed; the answer is 42.' },
            });
          });
        });
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    await backend.handle(
      makeOpenAICompatTask('t-prose', 'hi', { tools: OAI_SAMPLE_TOOLS, tool_choice: 'auto' }),
      (f) => frames.push(f),
      NEVER,
    );
    const artifacts = frames.filter(
      (f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact',
    );
    assert.equal(artifacts.length, 1);
    const part = artifacts[0].artifact.parts[0];
    assert.equal(part.kind, 'text');
    if (part.kind === 'text') assert.equal(part.text, 'No tool needed; the answer is 42.');
    assert.equal(artifacts[0].artifact.extensions, undefined);
  } finally {
    await fake.close();
  }
});

test('multi-turn: tool_call_history block is prepended to chat.send.message on follow-up turn', async () => {
  let sentMessage: string | null = null;
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        sentMessage = (req.params as { message: string }).message;
        sock.send(
          JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId: 'r-mt', status: 'started' } }),
        );
        setImmediate(() => {
          fake.emitChat(sock, {
            runId: 'r-mt',
            sessionKey: 'agent:main:ctx-t-mt',
            seq: 1,
            state: 'final',
            message: { text: '7°C and clear in Seoul.' },
          });
        });
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url });
    await backend.handle(
      makeOpenAICompatTask('t-mt', 'natural language please', {
        tools: OAI_SAMPLE_TOOLS,
        tool_call_history: OAI_SAMPLE_HISTORY,
      }),
      () => {},
      NEVER,
    );
    assert.ok(sentMessage);
    // System instructions block precedes the history block.
    assert.match(sentMessage!, /^<system_instructions>/);
    // History block is present, in order, between system_instructions and user_message.
    assert.match(sentMessage!, /<\/system_instructions>\n\n<tool_call_history>\n/);
    assert.match(sentMessage!, /"role": "assistant"/);
    assert.match(sentMessage!, /"tool_call_id": "call_abc"/);
    assert.match(sentMessage!, /\n<\/tool_call_history_note>\n\n<user_message>/);
    // User content closes the message.
    assert.match(sentMessage!, /<user_message>\nnatural language please\n<\/user_message>$/);
  } finally {
    await fake.close();
  }
});

test('openaiCompatAgent: chat.send.sessionKey routes openai-compat tasks to the configured secondary agent', async () => {
  // Tasks WITH the extension metadata use `agent:oai:...`; tasks WITHOUT it
  // keep using the default `agent:main:...`. The operator pairs this with
  // an OpenClaw config that puts `tools.deny=["*"]` on the `oai` agent so
  // the host model can't fall back to its own skills (Bash, browser,
  // weather, etc.) and the envelope contract becomes deterministic.
  const sentKeys: string[] = [];
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        const params = req.params as { sessionKey: string };
        sentKeys.push(params.sessionKey);
        sock.send(
          JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId: `run-${sentKeys.length}`, status: 'started' } }),
        );
        setImmediate(() => {
          fake.emitChat(sock, {
            runId: `run-${sentKeys.length}`,
            sessionKey: params.sessionKey,
            seq: 1,
            state: 'final',
            message: { text: 'ok' },
          });
        });
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url, openaiCompatAgent: 'oai' });
    // Extension-bearing task → routed to `oai`.
    await backend.handle(
      makeOpenAICompatTask('t-route-oai', 'what is the weather?', { tools: OAI_SAMPLE_TOOLS }, 'ctx-route-oai'),
      () => {},
      NEVER,
    );
    // Plain task → keeps the default `main`.
    await backend.handle(makeTask('t-route-main', 'hello'), () => {}, NEVER);

    assert.equal(sentKeys.length, 2);
    assert.equal(sentKeys[0], 'agent:oai:ctx-route-oai');
    assert.equal(sentKeys[1], 'agent:main:ctx-t-route-main');
  } finally {
    await fake.close();
  }
});

test('openaiCompatAgent: when unset, openai-compat tasks still use the default agent name', async () => {
  // Default behavior pre-#161 / when the operator hasn't opted into the
  // split: every task — extension or not — goes to the single configured
  // `agent`. Guards against the routing override leaking onto every
  // operator who hasn't set the new option.
  const sentKeys: string[] = [];
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        const params = req.params as { sessionKey: string };
        sentKeys.push(params.sessionKey);
        sock.send(
          JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId: `run-${sentKeys.length}`, status: 'started' } }),
        );
        setImmediate(() => {
          fake.emitChat(sock, {
            runId: `run-${sentKeys.length}`,
            sessionKey: params.sessionKey,
            seq: 1,
            state: 'final',
            message: { text: 'ok' },
          });
        });
      }
    },
  });
  try {
    // No openaiCompatAgent here — both tasks should reach `agent:main:...`.
    const backend = createOpenclawBackend({ url: fake.url });
    await backend.handle(
      makeOpenAICompatTask('t-noroute-oai', 'hi', { tools: OAI_SAMPLE_TOOLS }, 'ctx-noroute-oai'),
      () => {},
      NEVER,
    );
    await backend.handle(makeTask('t-noroute-plain', 'hi'), () => {}, NEVER);

    assert.equal(sentKeys.length, 2);
    assert.equal(sentKeys[0], 'agent:main:ctx-noroute-oai');
    assert.equal(sentKeys[1], 'agent:main:ctx-t-noroute-plain');
  } finally {
    await fake.close();
  }
});

test('openaiCompatAgent: blank string (e.g. empty env template) does not override the default agent', async () => {
  // Mirrors the daemon-level "trim + treat-empty-as-unset" pattern other
  // openclaw options follow so an install.sh env template with the key
  // present-but-blank doesn't accidentally activate the split.
  const sentKeys: string[] = [];
  const fake = await createFakeGateway({
    onRequest: (sock, req) => {
      if (req.method === 'chat.send') {
        const params = req.params as { sessionKey: string };
        sentKeys.push(params.sessionKey);
        sock.send(
          JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { runId: 'run-blank', status: 'started' } }),
        );
        setImmediate(() => {
          fake.emitChat(sock, {
            runId: 'run-blank',
            sessionKey: params.sessionKey,
            seq: 1,
            state: 'final',
            message: { text: 'ok' },
          });
        });
      }
    },
  });
  try {
    const backend = createOpenclawBackend({ url: fake.url, openaiCompatAgent: '   ' });
    await backend.handle(
      makeOpenAICompatTask('t-blank', 'hi', { tools: OAI_SAMPLE_TOOLS }, 'ctx-blank'),
      () => {},
      NEVER,
    );
    assert.equal(sentKeys[0], 'agent:main:ctx-blank');
  } finally {
    await fake.close();
  }
});

export { createFakeGateway, makeTask };
