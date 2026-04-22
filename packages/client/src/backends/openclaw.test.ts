import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { createOpenclawBackend } from './openclaw.js';
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

export { createFakeGateway, makeTask };
