// Real WS ingress, Postgres persistence and HTTP/SDK response mapping. Run with
// DATABASE_URL pointing to a disposable database, like the other DB suites.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import postgres from 'postgres';
import WebSocket from 'ws';
import { TaskState, type Task, type Part as A2XPart } from '@a2x/sdk';
import { encodeFrame, parseDownFrame, PROTOCOL_VERSION, TASK_REPLAY_CAPABILITY,
  type Part, type UpFrame } from '@vicoop-bridge/protocol';
import { ensureSchema } from './db.js';
import { createHttpApp } from './http.js';
import { PostgresTaskStore } from './postgres-task-store.js';
import { Registry } from './registry.js';
import { hashToken } from './token.js';
import { attachWsServer } from './ws.js';

const bytes = Buffer.from(Array.from({ length: 21_414 }, (_, i) => i % 256));
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const wireParts: Part[] = [
  { kind: 'text', text: 'download' },
  { kind: 'file', file: { name: 'fixture.bin', mimeType: 'application/octet-stream', bytes: bytes.toString('base64') } },
  { kind: 'file', file: { name: 'remote.bin', mimeType: 'application/octet-stream', uri: 'https://example.test/remote.bin' } },
  { kind: 'data', data: { size: bytes.length, sha256: digest(bytes) } },
];
const flatParts = [
  { text: 'download' },
  { filename: 'fixture.bin', mediaType: 'application/octet-stream', raw: bytes.toString('base64') },
  { filename: 'remote.bin', mediaType: 'application/octet-stream', url: 'https://example.test/remote.bin' },
  { data: { size: bytes.length, sha256: digest(bytes) } },
];
const metadata = { receipt: 'preserved' };
const extensions = ['urn:test:file-delivery'];
function assertParts(parts: unknown, v1: boolean): void {
  assert.deepEqual(parts, v1 ? flatParts : wireParts);
  const file = (parts as Array<{ raw?: string; file?: { bytes?: string } }>)[1]!;
  const downloaded = Buffer.from((v1 ? file.raw : file.file?.bytes)!, 'base64');
  assert.equal(downloaded.length, bytes.length);
  assert.equal(digest(downloaded), digest(bytes));
}
function assertTask(task: Task, v1: boolean, expectHistory = true): void {
  assert.ok(task?.id);
  assert.equal(task.status.state, v1 ? 'TASK_STATE_COMPLETED' : 'completed');
  assert.equal(task.artifacts?.length, 1);
  assertParts(task.artifacts?.[0]?.parts, v1);
  assertParts(task.status.message?.parts, v1);
  assert.deepEqual(task.artifacts?.[0]?.metadata, metadata);
  assert.deepEqual(task.artifacts?.[0]?.extensions, extensions);
  assert.deepEqual(task.status.message?.metadata, metadata);
  assert.deepEqual(task.status.message?.extensions, extensions);
  const outputs = task.history?.filter((m) => m.messageId.startsWith('output-')) ?? [];
  if (expectHistory) assert.ok(outputs.length > 0);
  for (const message of outputs) assertParts(message.parts, v1);
  for (const message of task.history ?? []) {
    if (message.messageId.startsWith('files-')) assertParts(message.parts, v1);
  }
}

// Every receive is bounded, including hello / replay ACKs and streamed bodies.
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('file delivery timed out')), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

test('native files survive both A2A versions, stream/send, reconnect, restart and legacy reads',
  { skip: !process.env.DATABASE_URL, timeout: 30_000 }, async (t) => {
  const sql = postgres(process.env.DATABASE_URL!, { onnotice() {} });
  const agentId = `files-${randomUUID()}`;
  const token = randomUUID();
  let runtime: Awaited<ReturnType<typeof start>> | undefined;
  t.after(async () => {
    await runtime?.stop();
    await sql`DELETE FROM infra.a2a_tasks WHERE owner_agent = ${agentId}`;
    await sql`DELETE FROM agents WHERE id = ${agentId}`;
    await sql.end();
  });
  await ensureSchema(sql);
  await sql`INSERT INTO agents (id, owner_principal, name, token_hash, allowed_callers)
    VALUES (${agentId}, 'eth:0xowner', 'file delivery', ${hashToken(token)}, ${[]})`;
  let lastTerminal: UpFrame | undefined;
  async function start() {
    const registry = new Registry();
    const server = createServer();
    attachWsServer(server, { registry, db: sql });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;
    const app = createHttpApp({ registry, db: sql, publicUrl: 'http://localhost' });
    let ws: WebSocket;
    let pauseForReconnect = false;
    let pending: UpFrame[] = [];
    let artifactAccepted: (() => void) | undefined;
    async function connect() {
      ws = new WebSocket(`ws://127.0.0.1:${port}/connect`);
      await bounded(once(ws, 'open'));
      const hello = once(ws, 'message');
      ws.send(encodeFrame({ type: 'hello', version: PROTOCOL_VERSION, agentId, token,
        protocolCapabilities: [TASK_REPLAY_CAPABILITY],
        agentCard: { name: 'file delivery', description: 'File interoperability test', version: '1', protocolVersion: '0.3.0', capabilities: { streaming: true }, skills: [] } }));
      const [raw] = await bounded(hello);
      assert.equal(parseDownFrame(raw.toString()).type, 'hello.ack');
      ws.on('message', (raw) => {
        const assign = parseDownFrame(raw.toString());
        if (assign.type === 'task.ack' && assign.acceptedSeq === 0) {
          artifactAccepted?.();
          artifactAccepted = undefined;
        }
        if (assign.type !== 'task.assign') return;
        if (assign.message.messageId.startsWith('files-')) assert.deepEqual(assign.message.parts, wireParts);
        const base = { taskId: assign.taskId, executionId: assign.executionId };
        const message = { messageId: `output-${randomUUID()}`, role: 'agent' as const,
          parts: wireParts, metadata, extensions };
        lastTerminal = { type: 'task.complete', ...base, seq: 2,
          status: { state: 'completed', message: { ...message, messageId: `output-${randomUUID()}` } } };
        const frames: UpFrame[] = [
          { type: 'task.artifact', ...base, seq: 0, lastChunk: true,
            artifact: { artifactId: 'files', parts: wireParts, metadata, extensions } },
          { type: 'task.status', ...base, seq: 1, status: { state: 'working', message } },
          lastTerminal,
        ];
        if (pauseForReconnect) {
          pending = frames;
          ws.send(encodeFrame(frames[0]!));
        } else {
          for (const frame of frames) ws.send(encodeFrame(frame));
        }
      });
    }
    async function disconnect(code = 1000) {
      if (ws?.readyState === WebSocket.OPEN) {
        const closed = once(ws, 'close');
        ws.close(code);
        await bounded(closed);
        // Wait for the server-side close callback before reconnecting.
        for (let i = 0; registry.getAgent(agentId) && i < 100; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(registry.getAgent(agentId), undefined);
      }
    }
    await connect();
    return { app, connect, disconnect,
      pauseAfterArtifact: () => {
        pauseForReconnect = true;
        return bounded(new Promise<void>((resolve) => { artifactAccepted = resolve; }));
      },
      resume: () => {
        assert.equal(pending.length, 3);
        // Replay the acknowledged artifact too, simulating an ACK lost before
        // the client durably advanced its journal cursor.
        for (const frame of pending) ws.send(encodeFrame(frame));
        pending = [];
        pauseForReconnect = false;
      },
      replay: async () => {
        assert.ok(lastTerminal);
        const ack = once(ws, 'message');
        ws.send(encodeFrame(lastTerminal));
        const [raw] = await bounded(ack);
        const frame = parseDownFrame(raw.toString());
        assert.equal(frame.type, 'task.ack');
        if (frame.type === 'task.ack') assert.equal(frame.acceptedSeq, 2);
      },
      stop: async () => {
        await disconnect();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      },
    };
  }
  runtime = await start();
  const rpc = (v1: boolean, method: string, params: unknown) => bounded(Promise.resolve(runtime!.app.request(
    `/agents/${agentId}${v1 ? '/v1' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })));
  async function result(response: Response): Promise<Task> {
    assert.equal(response.status, 200);
    const body = await bounded(response.json()) as { result?: Task; error?: unknown };
    assert.ok(body.result, JSON.stringify(body.error));
    return body.result;
  }
  async function events(response: Response) {
    assert.equal(response.status, 200);
    const body = await bounded(response.text());
    return body.split('\n').filter((line) => line.startsWith('data:')).map((line) => {
      const envelope = JSON.parse(line.slice(5));
      assert.equal(envelope.error, undefined);
      return envelope.result as { taskId: string; artifact?: { parts: unknown }; status?: { message?: { parts: unknown } } };
    });
  }
  const ids: string[] = [];
  for (const v1 of [false, true]) {
    for (const stream of [false, true]) {
      await t.test(`${v1 ? '1.0' : '0.3'} ${stream ? 'stream' : 'blocking send'}`, async () => {
        const response = await rpc(v1, v1 ? (stream ? 'SendStreamingMessage' : 'SendMessage') : (stream ? 'message/stream' : 'message/send'), {
          message: { messageId: `files-${randomUUID()}`, role: 'user', parts: v1 ? flatParts : wireParts },
          configuration: { blocking: true, returnImmediately: false },
        });
        let id: string;
        if (stream) {
          const output = await events(response);
          const artifact = output.find((event) => event.artifact);
          assert.ok(artifact);
          assertParts(artifact.artifact!.parts, v1);
          const statuses = output.filter((event) => event.status?.message);
          assert.equal(statuses.length, 2);
          for (const event of statuses) assertParts(event.status!.message!.parts, v1);
          id = artifact.taskId;
        } else {
          const task = await result(response);
          // SDK 0.3 send responses include only the input message in history.
          assertTask(task, v1, v1);
          assertParts(task.history?.find((m) => m.messageId.startsWith('files-'))?.parts, v1);
          id = task.id;
        }
        ids.push(id);
        assertTask(await result(await rpc(v1, v1 ? 'GetTask' : 'tasks/get', { id })), v1);
      });
    }
  }
  for (const v1 of [false, true]) {
    await t.test(`${v1 ? '1.0' : '0.3'} in-flight artifact replay after disconnect`, async () => {
      const accepted = runtime!.pauseAfterArtifact();
      const response = rpc(v1, v1 ? 'SendStreamingMessage' : 'message/stream', {
        message: { messageId: `files-${randomUUID()}`, role: 'user', parts: v1 ? flatParts : wireParts },
      });
      await accepted;
      await runtime!.disconnect(1012);
      await runtime!.connect();
      runtime!.resume();
      const output = await events(await response);
      const artifacts = output.filter((event) => event.artifact);
      assert.equal(artifacts.length, 1, 'replayed artifact must not duplicate the download');
      assertParts(artifacts[0]!.artifact!.parts, v1);
      const id = artifacts[0]!.taskId;
      ids.push(id);
      assertTask(await result(await rpc(v1, v1 ? 'GetTask' : 'tasks/get', { id })), v1);
    });
  }
  for (const v1 of [false, true]) {
    await t.test(`${v1 ? '1.0' : '0.3'} input with a stray null file field remains readable`, async () => {
      const sent = await result(await rpc(v1, v1 ? 'SendMessage' : 'message/send', {
        message: { messageId: randomUUID(), role: 'user', parts: [{ kind: 'text', text: 'hello', file: null }] },
        configuration: { blocking: true, returnImmediately: false },
      }));
      assertTask(sent, v1, v1);
      assertTask(await result(await rpc(v1, v1 ? 'GetTask' : 'tasks/get', { id: sent.id })), v1);
    });
  }
  for (const action of ['send', 'stream']) {
    await t.test(`1.0 HTTP+JSON ${action} preserves input and output files`, async () => {
      const response = await bounded(Promise.resolve(runtime!.app.request(`/agents/${agentId}/v1/message:${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/a2a+json' },
        body: JSON.stringify({ message: { messageId: `files-${randomUUID()}`, role: 'ROLE_USER', parts: flatParts },
          configuration: { returnImmediately: false } }),
      })));
      assert.equal(response.status, 200, response.status === 200 ? undefined : await bounded(response.text()));
      let id: string;
      if (action === 'send') {
        const body = await bounded(response.json()) as { task: Task };
        assertTask(body.task, true);
        id = body.task.id;
      } else {
        const text = await bounded(response.text());
        const output = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)));
        for (const event of output) assert.equal(event.error, undefined);
        const artifacts = output.filter((event) => event.artifactUpdate);
        assert.equal(artifacts.length, 1);
        assertParts(artifacts[0].artifactUpdate.artifact.parts, true);
        id = artifacts[0].artifactUpdate.taskId;
      }
      const fetched = await bounded(Promise.resolve(runtime!.app.request(`/agents/${agentId}/v1/tasks/${id}`)));
      assert.equal(fetched.status, 200);
      assertTask(await bounded(fetched.json()) as Task, true);
      ids.push(id);
    });
  }
  await runtime.disconnect();
  await runtime.connect();
  await runtime.replay();
  // Recreate the app, SDK caches, registry and WS listener against the same DB.
  await runtime.stop();
  runtime = await start();
  for (const v1 of [false, true]) {
    for (const id of ids) {
      assertTask(await result(await rpc(v1, v1 ? 'GetTask' : 'tasks/get', { id })), v1);
      const replay = await events(await rpc(v1, v1 ? 'SubscribeToTask' : 'tasks/resubscribe', { id }));
      assert.equal(replay.length, 1);
      assertParts(replay[0]!.status!.message!.parts, v1);
    }
  }
  // Simulate rows written by an old server, including mixed already-flat and
  // nested parts. Direct SQL deliberately bypasses the new ingress adapter.
  const store = new PostgresTaskStore(sql, { ownerAgent: agentId });
  const legacy = (await store.getTask(ids[0]!))!;
  legacy.artifacts![0]!.parts = [flatParts[0], wireParts[1], wireParts[2], flatParts[3]] as unknown as A2XPart[];
  legacy.status.message!.parts = wireParts as unknown as A2XPart[];
  for (const m of legacy.history ?? []) if (m.messageId.startsWith('output-')) m.parts = wireParts as unknown as A2XPart[];
  legacy.history!.push({ messageId: 'old-stray-field', role: 'user', parts: [{ text: 'old input', file: null } as A2XPart] });
  await sql`UPDATE infra.a2a_tasks SET task_json = ${sql.json(JSON.parse(JSON.stringify(legacy)))} WHERE task_id = ${legacy.id}`;
  for (const v1 of [false, true]) {
    assertTask(await result(await rpc(v1, v1 ? 'GetTask' : 'tasks/get', { id: legacy.id })), v1);
    const replay = await events(await rpc(v1, v1 ? 'SubscribeToTask' : 'tasks/resubscribe', { id: legacy.id }));
    assertParts(replay[0]!.status!.message!.parts, v1);
  }
  assertParts((await store.listTasks({ includeArtifacts: true })).tasks.find((task) => task.id === legacy.id)!.artifacts![0]!.parts, true);
  // Context replay also normalizes old parts without changing caller scoping.
  await sql`UPDATE infra.a2a_tasks SET owner_principal = 'legacy-caller' WHERE task_id = ${legacy.id}`;
  const context = await store.loadByContextId(legacy.contextId!, 'legacy-caller');
  assert.equal(context.length, 1);
  assertParts(context[0]!.artifacts![0]!.parts, true);
  const updated = await store.updateTask(legacy.id, { status: { ...legacy.status, state: TaskState.COMPLETED, message: undefined } });
  assertParts(updated.artifacts![0]!.parts, true);
});
