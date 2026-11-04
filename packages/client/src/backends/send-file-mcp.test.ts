import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startSendFileMcpServer, type SendFileTaskHandle } from './send-file-mcp.js';

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'send-file-mcp-test-'));
  return await fs.realpath(dir);
}

function makeTaskHandle(taskId: string, capture: { artifacts: unknown[] }): SendFileTaskHandle {
  return {
    taskId,
    contextId: `ctx-${taskId}`,
    emit: (artifact) => {
      capture.artifacts.push(artifact);
    },
  };
}

test('send_file: with one active task, reads file and emits artifact through that task', async () => {
  const root = await tmpDir();
  await fs.writeFile(path.join(root, 'note.txt'), 'note body');
  const server = await startSendFileMcpServer({
    allowedRoots: [root],
    skipHttp: true,
  });
  try {
    const cap = { artifacts: [] as unknown[] };
    const release = server.registerActiveTask(makeTaskHandle('t1', cap));
    try {
      const result = await server.invokeSendFileForTest({
        path: path.join(root, 'note.txt'),
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.size, 'note body'.length);
      assert.equal(cap.artifacts.length, 1);
      const art = cap.artifacts[0] as {
        artifactId: string;
        name: string;
        parts: Array<{ kind: string; file?: { name?: string; mimeType?: string; bytes?: string } }>;
      };
      assert.equal(art.name, 'send-file');
      assert.equal(art.artifactId, result.artifactId);
      assert.equal(art.parts.length, 1);
      assert.equal(art.parts[0].kind, 'file');
      assert.equal(art.parts[0].file!.mimeType, 'text/plain');
      assert.equal(
        Buffer.from(art.parts[0].file!.bytes!, 'base64').toString('utf8'),
        'note body',
      );
    } finally {
      release.release();
    }
  } finally {
    await server.close();
  }
});

test('send_file: with no active task, returns no-active-task error and emits nothing', async () => {
  const root = await tmpDir();
  await fs.writeFile(path.join(root, 'x.txt'), 'x');
  const server = await startSendFileMcpServer({ allowedRoots: [root], skipHttp: true });
  try {
    const result = await server.invokeSendFileForTest({ path: path.join(root, 'x.txt') });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'no-active-task');
  } finally {
    await server.close();
  }
});

test('send_file: with multiple concurrent active tasks, returns ambiguous-task error (R1 routing)', async () => {
  const root = await tmpDir();
  await fs.writeFile(path.join(root, 'x.txt'), 'x');
  const server = await startSendFileMcpServer({ allowedRoots: [root], skipHttp: true });
  try {
    const capA = { artifacts: [] as unknown[] };
    const capB = { artifacts: [] as unknown[] };
    const releaseA = server.registerActiveTask(makeTaskHandle('tA', capA));
    const releaseB = server.registerActiveTask(makeTaskHandle('tB', capB));
    try {
      assert.equal(server.activeTaskCount(), 2);
      const result = await server.invokeSendFileForTest({ path: path.join(root, 'x.txt') });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, 'ambiguous-task');
      assert.equal(capA.artifacts.length, 0, 'no emit on either task on ambiguity');
      assert.equal(capB.artifacts.length, 0);
    } finally {
      releaseA.release();
      releaseB.release();
    }
  } finally {
    await server.close();
  }
});

test('send_file: file outside allowedRoots is rejected with outside-roots; no emit', async () => {
  const root = await tmpDir();
  const outside = await tmpDir();
  await fs.writeFile(path.join(outside, 'secret.txt'), 'no');
  const server = await startSendFileMcpServer({ allowedRoots: [root], skipHttp: true });
  try {
    const cap = { artifacts: [] as unknown[] };
    const release = server.registerActiveTask(makeTaskHandle('t1', cap));
    try {
      const result = await server.invokeSendFileForTest({
        path: path.join(outside, 'secret.txt'),
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, 'outside-roots');
      assert.equal(cap.artifacts.length, 0);
    } finally {
      release.release();
    }
  } finally {
    await server.close();
  }
});

test('send_file: oversized file rejected with too-large; no emit', async () => {
  const root = await tmpDir();
  const big = path.join(root, 'big.bin');
  await fs.writeFile(big, Buffer.alloc(2048));
  const server = await startSendFileMcpServer({
    allowedRoots: [root],
    maxBytes: 1024,
    skipHttp: true,
  });
  try {
    const cap = { artifacts: [] as unknown[] };
    const release = server.registerActiveTask(makeTaskHandle('t1', cap));
    try {
      const result = await server.invokeSendFileForTest({ path: big });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, 'too-large');
      assert.equal(cap.artifacts.length, 0);
    } finally {
      release.release();
    }
  } finally {
    await server.close();
  }
});

test('send_file: optional name overrides default basename', async () => {
  const root = await tmpDir();
  await fs.writeFile(path.join(root, 'orig.txt'), 'data');
  const server = await startSendFileMcpServer({ allowedRoots: [root], skipHttp: true });
  try {
    const cap = { artifacts: [] as unknown[] };
    const release = server.registerActiveTask(makeTaskHandle('t1', cap));
    try {
      const result = await server.invokeSendFileForTest({
        path: path.join(root, 'orig.txt'),
        name: 'pretty.txt',
      });
      assert.equal(result.ok, true);
      const art = cap.artifacts[0] as {
        parts: Array<{ file?: { name?: string } }>;
      };
      assert.equal(art.parts[0].file!.name, 'pretty.txt');
    } finally {
      release.release();
    }
  } finally {
    await server.close();
  }
});

test('start with port:0 and host:127.0.0.1 binds an HTTP listener exposing /mcp', async () => {
  const root = await tmpDir();
  const server = await startSendFileMcpServer({ allowedRoots: [root] });
  try {
    assert.ok(server.port > 0, 'port should be allocated by OS');
    assert.equal(server.host, '127.0.0.1');
    assert.equal(server.url, `http://127.0.0.1:${server.port}/mcp`);
    // Smoke test the listener: a non-MCP request should get 404 (proves the
    // server is up and routing on the path prefix). Real MCP protocol exchange
    // is exercised by the e2e harness; here we only confirm the bind.
    const res = await fetch(`http://127.0.0.1:${server.port}/not-mcp`);
    assert.equal(res.status, 404);
    // Tightened path guard: `/mcp2` must NOT match `/mcp` (the old
    // startsWith check did).
    const sibling = await fetch(`http://127.0.0.1:${server.port}/mcp2`);
    assert.equal(sibling.status, 404);
    // A subpath like `/mcp/extra` is also not the single MCP endpoint.
    const sub = await fetch(`http://127.0.0.1:${server.port}/mcp/extra`);
    assert.equal(sub.status, 404);
  } finally {
    await server.close();
  }
});

test('listen() failure rejects and does not leak the McpServer/transport', async () => {
  // Hold a port so the second start fails to bind, exercising the
  // try/catch around `httpServer.listen`. Without cleanup the McpServer
  // would stay connected and accumulate across retries.
  const root = await tmpDir();
  const occupier = await startSendFileMcpServer({ allowedRoots: [root] });
  try {
    await assert.rejects(
      () =>
        startSendFileMcpServer({
          allowedRoots: [root],
          host: '127.0.0.1',
          port: occupier.port,
        }),
      /EADDRINUSE/i,
    );
  } finally {
    await occupier.close();
  }
});

test('treats empty/whitespace `name` as missing and falls back to basename', async () => {
  const root = await tmpDir();
  await fs.writeFile(path.join(root, 'real.txt'), 'data');
  const server = await startSendFileMcpServer({ allowedRoots: [root], skipHttp: true });
  try {
    const cap = { artifacts: [] as unknown[] };
    const release = server.registerActiveTask(makeTaskHandle('t1', cap));
    try {
      const result = await server.invokeSendFileForTest({
        path: path.join(root, 'real.txt'),
        name: '   ',
      });
      assert.equal(result.ok, true);
      const art = cap.artifacts[0] as {
        parts: Array<{ file?: { name?: string } }>;
      };
      assert.equal(art.parts[0].file!.name, 'real.txt');
    } finally {
      release.release();
    }
  } finally {
    await server.close();
  }
});

test('rejects the literal "localhost" (any case) as host — only loopback IP literals allowed', async () => {
  const root = await tmpDir();
  // `"localhost"` resolves via libc/DNS at listen time and a non-standard
  // /etc/hosts could send it to a routable interface, so it's not in the
  // safe allowlist. Operators must use 127.0.0.1 or ::1 to opt into the
  // safe-by-default loopback bind.
  for (const host of ['localhost', 'Localhost', 'LOCALHOST']) {
    await assert.rejects(
      () => startSendFileMcpServer({ allowedRoots: [root], host, skipHttp: true }),
      /non-loopback/,
    );
  }
});

test('accepts `::1` as IPv6 loopback', async () => {
  const root = await tmpDir();
  const server = await startSendFileMcpServer({
    allowedRoots: [root],
    host: '::1',
    skipHttp: true,
  });
  await server.close();
});

test('refuses to bind a non-loopback host without dangerouslyAllowNonLoopback', async () => {
  const root = await tmpDir();
  await assert.rejects(
    () =>
      startSendFileMcpServer({
        allowedRoots: [root],
        host: '0.0.0.0',
        skipHttp: true,
      }),
    /non-loopback/,
  );
});

test('binds non-loopback when dangerouslyAllowNonLoopback is true', async () => {
  const root = await tmpDir();
  const server = await startSendFileMcpServer({
    allowedRoots: [root],
    host: '0.0.0.0',
    skipHttp: true,
    dangerouslyAllowNonLoopback: true,
  });
  try {
    assert.equal(server.host, '0.0.0.0');
  } finally {
    await server.close();
  }
});

test('::-bound listener advertises [::1] (IPv6 loopback) in url, not 127.0.0.1', async () => {
  const root = await tmpDir();
  const server = await startSendFileMcpServer({
    allowedRoots: [root],
    host: '::',
    dangerouslyAllowNonLoopback: true,
  });
  try {
    assert.match(server.url, /^http:\/\/\[::1\]:\d+\/mcp$/);
  } finally {
    await server.close();
  }
});

test('HTTP MCP supports repeated fresh clients and multiple calls on the same client', async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const root = await tmpDir();
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  await fs.writeFile(path.join(root, 'result.txt'), 'native file');
  const server = await startSendFileMcpServer({allowedRoots:[root]});
  try {
    for (let turn = 0; turn < 2; turn++) {
      const captured = {artifacts:[] as unknown[]};
      const task = server.registerActiveTask(makeTaskHandle(`turn-${turn}`,captured));
      const client = new Client({name:'claude-reconnect-regression',version:'1'});
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
        assert.equal((await client.listTools()).tools[0].name,'send_file');
        for (let call = 0; call < 2; call++) {
          const result = await client.callTool({name:'send_file',arguments:{path:path.join(root,'result.txt')}});
          assert.notEqual(result.isError,true);
        }
        assert.equal(captured.artifacts.length,2);
      } finally { await client.close(); task.release(); }
    }
  } finally { await server.close(); }
});

test('HTTP MCP shutdown closes an in-flight tool response without waiting for the client', async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const root = await tmpDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'pending.txt');
  await fs.writeFile(filePath, 'pending read');

  let signalRead!: () => void;
  let releaseRead!: () => void;
  const readStarted = new Promise<void>(resolve => { signalRead = resolve; });
  const readReleased = new Promise<void>(resolve => { releaseRead = resolve; });
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] === filePath) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, 'read', async (...readArgs: Parameters<typeof handle.read>) => {
        signalRead();
        await readReleased;
        return read(...readArgs);
      });
    }
    return handle;
  });

  async function withinDeadline(promise: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('shutdown regression deadline exceeded')), 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  const server = await startSendFileMcpServer({ allowedRoots: [root] });
  const task = server.registerActiveTask(makeTaskHandle('shutdown', { artifacts: [] }));
  const client = new Client({ name: 'shutdown-regression', version: '1' });
  let closing: Promise<void> | undefined;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    // Attach a rejection handler before shutdown interrupts the HTTP response.
    const call = client.callTool({ name: 'send_file', arguments: { path: filePath } })
      .then(() => 'completed', () => 'interrupted');
    await withinDeadline(readStarted);
    closing = server.close();
    // Keep the read paused and the client open: shutdown must close the response itself.
    await withinDeadline(closing);
    await withinDeadline(call);
    assert.equal(await call, 'interrupted');
  } finally {
    releaseRead();
    await client.close();
    await (closing ?? server.close());
    task.release();
  }
});

test('execution-bound HTTP MCP routes overlapping clients and rejects missing/stale capabilities', async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const root = await tmpDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'caller A');
  await fs.writeFile(path.join(root, 'b.txt'), 'caller B');
  const server = await startSendFileMcpServer({ allowedRoots: [root], requireExecutionBinding: true });
  t.after(() => server.close());
  const artifactsA: unknown[] = [], artifactsB: unknown[] = [];
  const a = server.registerActiveTask(makeTaskHandle('a', { artifacts: artifactsA }));
  const b = server.registerActiveTask(makeTaskHandle('b', { artifacts: artifactsB }));
  const connect = async (token: string) => {
    const client = new Client({ name: 'bound-client', version: '1' });
    t.after(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    return client;
  };
  const [clientA, clientB] = await Promise.all([connect(a.token), connect(b.token)]);
  const tools = await clientA.listTools();
  assert.deepEqual(Object.keys(tools.tools[0].inputSchema.properties!), ['path', 'name']);
  const results = await Promise.all([
    clientA.callTool({ name: 'send_file', arguments: { path: path.join(root, 'a.txt'), taskId: 'b' } }),
    clientB.callTool({ name: 'send_file', arguments: { path: path.join(root, 'b.txt'), contextId: 'ctx-a' } }),
  ]);
  assert.ok(results.every(r => !r.isError));
  const decoded = (artifacts: unknown[]) => Buffer.from((artifacts[0] as { parts: Array<{ file: { bytes: string } }> }).parts[0].file.bytes, 'base64').toString();
  assert.equal(decoded(artifactsA), 'caller A');
  assert.equal(decoded(artifactsB), 'caller B');
  assert.equal((await fetch(server.url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(server.url, { method: 'POST', headers: { Authorization: 'Bearer unknown' } })).status, 401);
  // Fresh helpers can reconnect only to their original still-active execution.
  const reconnected = await connect(b.token);
  assert.ok(!(await reconnected.callTool({ name: 'send_file', arguments: { path: path.join(root, 'b.txt') } })).isError);
  a.release();
  await assert.rejects(clientA.callTool({ name: 'send_file', arguments: { path: path.join(root, 'a.txt') } }));
  await assert.rejects(connect(a.token));
  assert.equal(artifactsA.length, 1);
  assert.equal(artifactsB.length, 2);
  // Re-registering the same A2A task still needs a new execution capability.
  const retry = server.registerActiveTask(makeTaskHandle('a', { artifacts: artifactsA }));
  assert.notEqual(retry.token, a.token);
  await assert.rejects(clientA.callTool({ name: 'send_file', arguments: { path: path.join(root, 'a.txt') } }));
  retry.release(); b.release();
});

test('execution release and shutdown prevent pending reads from emitting into any task', async t => {
  const root = await tmpDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'pending.txt');
  await fs.writeFile(file, 'private');
  const originalOpen = fs.open;
  let releaseRead!: () => void;
  let signalRead!: () => void;
  let started: Promise<void>;
  let paused: Promise<void>;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const read = handle.read.bind(handle);
    t.mock.method(handle, 'read', async (...params: Parameters<typeof handle.read>) => {
      signalRead(); await paused; return read(...params);
    });
    return handle;
  });
  for (const shutdown of [false, true]) {
    started = new Promise<void>(resolve => { signalRead = resolve; });
    paused = new Promise<void>(resolve => { releaseRead = resolve; });
    const server = await startSendFileMcpServer({ allowedRoots: [root], requireExecutionBinding: true, skipHttp: true });
    const cap = { artifacts: [] as unknown[] };
    const task = server.registerActiveTask(makeTaskHandle('old', cap));
    const pending = server.invokeSendFileForTest({ path: file }, task.token);
    await started;
    if (shutdown) await server.close();
    else {
      task.release();
      server.registerActiveTask(makeTaskHandle('new', cap));
    }
    releaseRead();
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'inactive-execution');
    assert.deepEqual(cap.artifacts, []);
    await server.close();
    assert.equal(server.activeTaskCount(), 0);
    assert.throws(() => server.registerActiveTask(makeTaskHandle('after-close', cap)), /closed/);
  }
});
