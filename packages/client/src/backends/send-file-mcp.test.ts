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
  } finally {
    await server.close();
  }
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
