import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { encodeFrame, parseUpFrame, TASK_REPLAY_CAPABILITY } from '@vicoop-bridge/protocol';
import { Client } from './client.js';
import { CallerRuntimeConfig } from './caller-runtime-config.js';
import { CallerFileDeliveryConfig, callerFilePendingBytes, createCallerFileDelivery,
  MAX_CALLER_FILE_PENDING_BYTES, type CallerFileDeliveryOptions } from './caller-file-delivery.js';

const MiB = 1024 * 1024;
const roots = { allowedRoots: ['/workspace/output'] };

test('retention uses effective aggregate, independently padded files, and scope count with a finite ceiling', () => {
  assert.equal(callerFilePendingBytes(undefined, 32), undefined);
  const defaults = CallerFileDeliveryConfig.parse(roots);
  const perScope = 4 * Math.floor((24 * MiB + 16) / 3) + 8 * 64 * 1024 + MiB;
  assert.equal(callerFilePendingBytes(defaults), 8 * perScope);
  assert.equal(callerFilePendingBytes({ ...roots, maxBytes: MiB, maxFiles: 2 }, 4),
    4 * (4 * Math.floor((2 * MiB + 4) / 3) + 2 * 64 * 1024 + MiB));
  // Sixteen independently encoded one-byte files require 64 bytes, not ceil(16/3)*4.
  assert.equal(callerFilePendingBytes({ ...roots, maxBytes: 1, maxFiles: 16 }, 32),
    32 * (64 + 16 * 64 * 1024 + MiB));
  assert.ok(callerFilePendingBytes({ ...roots, maxTotalBytes: 48 * MiB, maxFiles: 16 }, 7)! < MAX_CALLER_FILE_PENDING_BYTES);
  const runtime = { image: `sha256:${'a'.repeat(64)}`, stateDirectory: '/tmp/file-retention' };
  assert.ok(CallerRuntimeConfig.parse({ ...runtime, maxScopes: 32 }));
  assert.ok(CallerRuntimeConfig.parse({ ...runtime, fileDelivery: roots }));
  assert.throws(() => CallerRuntimeConfig.parse({ ...runtime, maxScopes: 32, fileDelivery: roots }), /reduce .*maxScopes/);
  assert.throws(() => CallerRuntimeConfig.parse({ ...runtime, maxScopes: 8,
    fileDelivery: { ...roots, maxTotalBytes: 48 * MiB, maxFiles: 16 } }), /512 MiB/);
});

async function waitFor(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, description);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// Only Docker's byte reader is replaced. Production delivery emits through the
// real Client and socket, with replay negotiation and deliberately withheld ACKs.
async function exerciseBatch(config: CallerFileDeliveryOptions, count: number, size: number,
  scopes: number, oldBudget = false, replay = false) {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bytes = Buffer.alloc(size, 0x9d).toString('base64');
  const digest = createHash('sha256').update(Buffer.from(bytes, 'base64')).digest('hex');
  const artifacts: Array<{ taskId: string; seq: number | undefined; name: string | undefined }> = [];
  const terminals: Array<{ taskId: string; executionId: string; seq: number }> = [];
  const failures: string[] = [];
  let socket!: WebSocket, connections = 0, active = 0, maxActive = 0;
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  let entered = 0;
  const assignBatch = (generation: number) => {
    for (let scope = 0; scope < scopes; scope++) socket.send(encodeFrame({
      type: 'task.assign', taskId: `task-${generation}-${scope}`, executionId: `exec-${generation}-${scope}`,
      contextId: `context-${scope}`,
      executionScope: { policy: 'federated-principal-v1', agentId: 'agent', principalId: `caller-${scope}`,
        id: scope.toString(16).padStart(64, '0') },
      message: { role: 'user', messageId: `message-${generation}-${scope}`, parts: [{ kind: 'text', text: 'send files' }] },
    }));
  };
  wss.on('connection', ws => {
    socket = ws;
    ws.on('message', raw => {
      const frame = parseUpFrame(raw.toString('utf8'));
      if (frame.type === 'hello') {
        connections++;
        ws.send(encodeFrame({ type: 'hello.ack', protocolCapabilities: [TASK_REPLAY_CAPABILITY,
          'caller-context-v2', 'execution-scope-v1', 'caller-runtime-v1', 'federated-execution-scope-v1'],
          disconnectGraceMs: 30_000, maxFrameBytes: 16 * MiB }));
        if (connections === 1) assignBatch(0);
      } else if (frame.type === 'task.artifact') {
        const part = frame.artifact.parts[0];
        assert.equal(part.kind, 'file');
        if (part.kind !== 'file') throw Error('missing file');
        assert.equal(part.file.bytes?.length, bytes.length);
        assert.equal(createHash('sha256').update(Buffer.from(part.file.bytes!, 'base64')).digest('hex'), digest);
        artifacts.push({ taskId: frame.taskId, seq: frame.seq, name: part.file.name });
      } else if (frame.type === 'task.complete') {
        assert.ok(frame.executionId && frame.seq !== undefined);
        terminals.push({ taskId: frame.taskId, executionId: frame.executionId, seq: frame.seq });
      } else if (frame.type === 'task.fail') failures.push(frame.error.code);
    });
  });
  const client = new Client({ serverUrl: url, token: 'test', agentId: 'agent', backendKind: 'claude',
    maxPendingBytes: oldBudget ? 18 * MiB : callerFilePendingBytes(config, scopes),
    heartbeatIntervalMs: 0, reconnectDelayMs: oldBudget ? 60_000 : 10, logLevel: 'silent',
    backend: { name: 'file-retention', requiresCallerScope: true, handle: async (task, emit, signal) => {
      active++; maxActive = Math.max(active, maxActive);
      try {
        if (++entered === scopes) release();
        await gate;
        const delivery = createCallerFileDelivery(`container-${task.executionScope?.id}`, task.taskId, emit, signal,
          config, async () => ({ exitCode: 0, stderr: '', stdout: JSON.stringify({ bytes }) }));
        for (let index = 0; index < count; index++) {
          await delivery.send({ path: '/workspace/output/file.png', name: `한글-${index}.png` }, signal);
          // Let both scope executions and the actual socket progress together.
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        emit({ type: 'task.complete', taskId: task.taskId, status: { state: 'completed' } });
      } finally { active--; }
    } },
  });
  try {
    client.start();
    await waitFor(() => failures.length > 0 || terminals.length === scopes, 'first batches never settled');
    if (oldBudget) {
      assert.deepEqual(failures, ['client_buffer_overflow']);
      assert.equal(artifacts.length, 2, 'the old two-file budget must fail on the third permitted file');
      assert.equal(terminals.length, 0);
      return;
    }
    assert.deepEqual(failures, []);
    assert.equal(maxActive, scopes, 'scope executions must overlap');
    assert.equal(artifacts.length, scopes * count);
    for (let scope = 0; scope < scopes; scope++) assert.deepEqual(
      artifacts.filter(a => a.taskId === `task-0-${scope}`).map(a => a.name),
      Array.from({ length: count }, (_, i) => `한글-${i}.png`));
    if (replay) {
      const originals = [...artifacts];
      socket.terminate();
      await waitFor(() => terminals.length === 2 * scopes, 'unacknowledged batches were not replayed');
      assert.equal(connections, 2);
      assert.deepEqual(artifacts.slice(originals.length), originals);
    }
    // ACK only after the complete batch(es), then prove the retained budget is
    // released by sending a second full batch on the same caller scopes.
    for (const terminal of terminals.slice(-scopes)) socket.send(encodeFrame({ type: 'task.ack',
      taskId: terminal.taskId, executionId: terminal.executionId, acceptedSeq: terminal.seq }));
    const previousTerminals = terminals.length, previousArtifacts = artifacts.length;
    entered = 0;
    gate = new Promise<void>(resolve => { release = resolve; });
    assignBatch(1);
    await waitFor(() => failures.length > 0 || terminals.length === previousTerminals + scopes, 'post-ACK batch never settled');
    assert.deepEqual(failures, []);
    assert.equal(artifacts.length, previousArtifacts + scopes * count);
  } finally {
    release(); client.stop();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => server.close(() => resolve())));
  }
}

test('real Client + delayed ACK: old 18 MiB budget rejects the third valid 6 MiB file', async () => {
  await exerciseBatch(CallerFileDeliveryConfig.parse(roots), 4, 6 * MiB, 1, true);
});

test('real Client + delayed ACK: all four default maximum-size files and post-ACK reuse succeed', async () => {
  await exerciseBatch(CallerFileDeliveryConfig.parse(roots), 4, 6 * MiB, 1);
});

test('real Client + delayed ACK: sixteen files exhaust the configured aggregate without overflow', async () => {
  await exerciseBatch(CallerFileDeliveryConfig.parse({ ...roots, maxBytes: 3 * MiB, maxTotalBytes: 48 * MiB, maxFiles: 16 }),
    16, 3 * MiB, 1);
});

test('real Client + delayed ACK: simultaneous full caller batches survive reconnect replay and reuse', async () => {
  await exerciseBatch(CallerFileDeliveryConfig.parse(roots), 4, 6 * MiB, 2, false, true);
});
