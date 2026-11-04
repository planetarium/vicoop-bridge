// Real Claude -> execution-bound MCP -> WS -> Postgres -> A2A HTTP file test.
// Prerequisites: pnpm -r build, authenticated claude, disposable DATABASE_URL.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import postgres from 'postgres';
import WebSocket from 'ws';
import { encodeFrame, parseDownFrame, PROTOCOL_VERSION, TASK_REPLAY_CAPABILITY } from '@vicoop-bridge/protocol';
import { createClaudeBackend } from '../../client/dist/backends/claude.js';
import { ensureSchema } from '../dist/db.js';
import { createHttpApp } from '../dist/http.js';
import { Registry } from '../dist/registry.js';
import { hashToken } from '../dist/token.js';
import { attachWsServer } from '../dist/ws.js';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point to a disposable database');
const sql = postgres(process.env.DATABASE_URL, { onnotice() {} });
const agentId = `file-routing-${randomUUID()}`;
const token = randomUUID();
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-file-routing-'));
const abort = new AbortController();
const runs = [];
let socket, server, backend;
let maxActive = 0;
let poll;
try {
  await ensureSchema(sql);
  await sql`INSERT INTO agents (id, owner_principal, name, token_hash, allowed_callers)
    VALUES (${agentId}, 'eth:0xowner', 'Claude file routing test', ${hashToken(token)}, ${[]})`;
  const registry = new Registry();
  const app = createHttpApp({ registry, db: sql, publicUrl: 'http://localhost' });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  attachWsServer(server, { registry, db: sql });
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/agents/${agentId}`;
  backend = createClaudeBackend({
    extraArgs: ['--max-turns', '4'],
    sendFileMcp: { allowedRoots: [root], maxBytes: 1024 * 1024 },
  });
  socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/connect`);
  await once(socket, 'open');
  const hello = once(socket, 'message');
  socket.send(encodeFrame({ type: 'hello', version: PROTOCOL_VERSION, agentId, token,
    protocolCapabilities: [TASK_REPLAY_CAPABILITY],
    agentCard: { name: 'file routing test', description: 'Real Claude file delivery', version: '1', protocolVersion: '0.3.0', capabilities: { streaming: true }, skills: [] } }));
  assert.equal(parseDownFrame((await hello)[0].toString()).type, 'hello.ack');
  socket.on('message', raw => {
    const frame = parseDownFrame(raw.toString());
    if (frame.type !== 'task.assign') return;
    let seq = 0;
    runs.push(backend.handle(frame, output => {
      socket.send(encodeFrame({ ...output, executionId: frame.executionId, seq: seq++ }));
    }, abort.signal));
  });
  poll = setInterval(() => { maxActive = Math.max(maxActive, backend.getSendFileMcpServer()?.activeTaskCount() ?? 0); }, 5);
  const rpc = async (v1, method, params) => {
    const response = await fetch(base + (v1 ? '/v1' : ''), { method: 'POST', signal: AbortSignal.timeout(120_000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.result, JSON.stringify(body.error));
    return body.result;
  };
  for (const v1 of [false, true]) {
    maxActive = 0;
    const tasks = await Promise.all(['a', 'b'].map(async caller => {
      const filename = `${v1 ? 'v1' : 'v03'}-${caller}.txt`;
      const content = `private fixture for ${filename}: ${randomUUID()}`;
      const file = path.join(root, filename);
      await fs.writeFile(file, content);
      const prompt = `Call the send_file MCP tool with path ${JSON.stringify(file)} now. After the tool succeeds, reply only "sent". Do not use other tools.`;
      const sent = await rpc(v1, v1 ? 'SendMessage' : 'message/send', {
        message: { messageId: randomUUID(), contextId: randomUUID(), role: 'user', parts: v1 ? [{ text: prompt }] : [{ kind: 'text', text: prompt }] },
        configuration: { blocking: true, returnImmediately: false },
      });
      for (const task of [sent, await rpc(v1, v1 ? 'GetTask' : 'tasks/get', { id: sent.id })]) {
        assert.equal(task.status.state, v1 ? 'TASK_STATE_COMPLETED' : 'completed', JSON.stringify(task.status));
        const files = (task.artifacts ?? []).flatMap(artifact => artifact.parts).filter(part => v1 ? part.raw : part.kind === 'file');
        assert.ok(files.length > 0, `No file received for ${filename}`);
        for (const part of files) {
          assert.equal(v1 ? part.filename : part.file.name, filename);
          assert.equal(Buffer.from(v1 ? part.raw : part.file.bytes, 'base64').toString(), content);
        }
      }
      return sent.id;
    }));
    assert.notEqual(tasks[0], tasks[1]);
    assert.equal(maxActive, 2, `Both real Claude executions must overlap for A2A ${v1 ? '1.0' : '0.3'}`);
    console.log(`PASS A2A ${v1 ? '1.0' : '0.3'} overlapping tasks and completed-task lookup preserve each file`);
  }
  await Promise.all(runs);
  assert.equal(backend.getSendFileMcpServer().activeTaskCount(), 0);
  console.log('PASS real concurrent Claude file routing, both A2A versions, persistent lookup');
} finally {
  clearInterval(poll);
  abort.abort();
  await Promise.allSettled(runs);
  await backend?.getSendFileMcpServer()?.close();
  if (socket?.readyState === WebSocket.OPEN) { const closed = once(socket, 'close'); socket.close(); await closed; }
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  await sql`DELETE FROM infra.a2a_tasks WHERE owner_agent = ${agentId}`;
  await sql`DELETE FROM agents WHERE id = ${agentId}`;
  await sql.end();
  await fs.rm(root, { recursive: true, force: true });
}
