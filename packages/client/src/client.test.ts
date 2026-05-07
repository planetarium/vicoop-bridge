import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  parseUpFrame,
  type Part,
  type TaskAssignFrame,
  type UpFrame,
} from '@vicoop-bridge/protocol';
import type { Backend, Emit } from './backend.js';
import { Client, processTask, summarizeParts } from './client.js';
import { type ConsoleSink, createLogger } from './logger.js';

interface CapturedSink {
  log: string[];
  warn: string[];
  error: string[];
  sink: ConsoleSink;
}

function makeSink(): CapturedSink {
  const log: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  const join = (a: unknown[]): string =>
    a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ');
  return {
    log,
    warn,
    error,
    sink: {
      log: (...a: unknown[]) => log.push(join(a)),
      warn: (...a: unknown[]) => warn.push(join(a)),
      error: (...a: unknown[]) => error.push(join(a)),
    },
  };
}

function captureSend(): { sent: UpFrame[]; send: (f: UpFrame) => void } {
  const sent: UpFrame[] = [];
  return {
    sent,
    send: (f) => {
      sent.push(f);
    },
  };
}

function makeAssign(taskId: string): TaskAssignFrame {
  return {
    type: 'task.assign',
    taskId,
    contextId: 'ctx',
    message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }], messageId: 'm1' },
  };
}

function backendOf(name: string, handle: Backend['handle']): Backend {
  return { name, handle };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return `ws://127.0.0.1:${addr.port}`;
}

async function closeServer(server: Server, wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve, reject) => {
    wss.close((wssErr) => {
      server.close((serverErr) => {
        const err = wssErr ?? serverErr;
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test('summarizeParts: empty', () => {
  assert.equal(summarizeParts([]), '(none)');
});

test('summarizeParts: text part reports text/plain', () => {
  const parts: Part[] = [{ kind: 'text', text: 'hi' }];
  assert.equal(summarizeParts(parts), 'text/plain');
});

test('summarizeParts: file part uses declared mimeType', () => {
  const parts: Part[] = [{ kind: 'file', file: { name: 'a.png', mimeType: 'image/png' } }];
  assert.equal(summarizeParts(parts), 'image/png');
});

test('summarizeParts: file part without mimeType falls back to octet-stream', () => {
  const parts: Part[] = [{ kind: 'file', file: { name: 'a.bin' } }];
  assert.equal(summarizeParts(parts), 'application/octet-stream');
});

test('summarizeParts: file part with empty/whitespace mimeType falls back to octet-stream', () => {
  const empty: Part[] = [{ kind: 'file', file: { name: 'a.bin', mimeType: '' } }];
  assert.equal(summarizeParts(empty), 'application/octet-stream');
  const whitespace: Part[] = [{ kind: 'file', file: { name: 'a.bin', mimeType: '   \t' } }];
  assert.equal(summarizeParts(whitespace), 'application/octet-stream');
});

test('summarizeParts: data part reports application/json', () => {
  const parts: Part[] = [{ kind: 'data', data: { foo: 'bar' } }];
  assert.equal(summarizeParts(parts), 'application/json');
});

test('summarizeParts: dedupes mime types and preserves first-seen order', () => {
  const parts: Part[] = [
    { kind: 'text', text: 'one' },
    { kind: 'file', file: { name: 'a.png', mimeType: 'image/png' } },
    { kind: 'text', text: 'two' },
    { kind: 'file', file: { name: 'b.png', mimeType: 'image/png' } },
    { kind: 'data', data: {} },
  ];
  assert.equal(summarizeParts(parts), 'text/plain,image/png,application/json');
});

test('summarizeParts: sanitizes hostile mimeType so it cannot inject newlines', () => {
  const parts: Part[] = [
    {
      kind: 'file',
      file: { name: 'a.png', mimeType: 'image/png\n[client] FAKE INJECTED LINE' },
    },
  ];
  const summary = summarizeParts(parts);
  assert.equal(summary.includes('\n'), false, 'summary must not contain raw newlines');
  assert.match(summary, /image\/png\\n\[client\] FAKE INJECTED LINE/);
});

test('summarizeParts: does not include user-supplied content', () => {
  const secret = 'super-secret-token';
  const parts: Part[] = [
    { kind: 'text', text: secret },
    { kind: 'file', file: { name: secret, mimeType: 'image/png', bytes: secret } },
    { kind: 'data', data: { token: secret } },
  ];
  const summary = summarizeParts(parts);
  assert.equal(summary.includes(secret), false);
});

test('Client reconnects after WebSocket close and sends hello again', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);
  const connections: WebSocket[] = [];
  const hellos: UpFrame[] = [];
  wss.on('connection', (ws) => {
    connections.push(ws);
    ws.on('message', (raw) => {
      hellos.push(parseUpFrame(typeof raw === 'string' ? raw : raw.toString('utf8')));
    });
  });

  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => {
      /* no tasks in this test */
    }),
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    reconnectJitterRatio: 0,
    reconnectStableMs: 0,
    heartbeatIntervalMs: 0,
  });

  try {
    client.start();
    await waitFor(() => hellos.length === 1, 'expected initial hello');
    connections[0]!.close(1012, 'service restart');
    await waitFor(() => hellos.length === 2, 'expected hello after reconnect');
    for (const frame of hellos) {
      assert.equal(frame.type, 'hello');
      if (frame.type === 'hello') {
        assert.equal(frame.agentId, 'agent-1');
        assert.equal(frame.token, 'client-token');
      }
    }
  } finally {
    client.stop();
    await closeServer(server, wss);
  }
});

// processTask lifecycle tests — exercise the runTask body directly with
// stub backends and a capturing send/logger so we don't need a real ws.

test('processTask: backend emits task.complete -> logs backend.start and task.complete', async () => {
  const c = makeSink();
  const s = captureSend();
  const backend = backendOf('stub', async (_t, emit: Emit) => {
    emit({ type: 'task.complete', taskId: 'T1', status: { state: 'completed' } });
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].type, 'task.complete');
  assert.equal(c.log.length, 2);
  assert.match(c.log[0], /backend\.start taskId=T1 backend=stub/);
  assert.match(c.log[1], /task\.complete taskId=T1 elapsedMs=\d+ artifacts=0/);
});

test('processTask: artifacts are deduped by artifactId across chunks', async () => {
  const c = makeSink();
  const s = captureSend();
  const backend = backendOf('stub', async (_t, emit) => {
    emit({
      type: 'task.artifact',
      taskId: 'T1',
      artifact: { artifactId: 'A', parts: [{ kind: 'text', text: 'p1' }] },
    });
    emit({
      type: 'task.artifact',
      taskId: 'T1',
      artifact: { artifactId: 'A', parts: [{ kind: 'text', text: 'p2' }] },
      lastChunk: true,
    });
    emit({
      type: 'task.artifact',
      taskId: 'T1',
      artifact: { artifactId: 'B', parts: [{ kind: 'text', text: 'b' }] },
      lastChunk: true,
    });
    emit({ type: 'task.complete', taskId: 'T1', status: { state: 'completed' } });
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  const completeLog = c.log.find((l) => l.includes('task.complete'));
  assert.ok(completeLog, 'task.complete log should be emitted');
  assert.match(completeLog, /artifacts=2/);
});

test('processTask: backend emits task.fail -> logs task.fail with code', async () => {
  const c = makeSink();
  const s = captureSend();
  const backend = backendOf('stub', async (_t, emit) => {
    emit({
      type: 'task.fail',
      taskId: 'T1',
      error: { code: 'rate_limited', message: 'slow down' },
    });
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  const failLog = c.log.find((l) => l.includes('task.fail'));
  assert.ok(failLog);
  assert.match(failLog, /code=rate_limited/);
});

test('processTask: backend resolves silently -> warns about missing terminal', async () => {
  const c = makeSink();
  const s = captureSend();
  const backend = backendOf('stub', async () => {
    /* no emits */
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  assert.equal(s.sent.length, 0);
  assert.equal(c.warn.length, 1);
  assert.match(c.warn[0], /backend\.end taskId=T1 .* \(no terminal frame\)/);
});

test('processTask: backend throws without emit -> emits backend_error fail and logs task.fail', async () => {
  const c = makeSink();
  const s = captureSend();
  const backend = backendOf('stub', async () => {
    throw new Error('boom');
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  assert.equal(s.sent.length, 1);
  const sent = s.sent[0];
  assert.equal(sent.type, 'task.fail');
  if (sent.type === 'task.fail') {
    assert.equal(sent.error.code, 'backend_error');
    assert.equal(sent.error.message, 'boom');
  }
  const failLog = c.log.find((l) => l.includes('task.fail'));
  assert.ok(failLog);
  assert.match(failLog, /code=backend_error/);
});

test('processTask: late-throw debug log preserves long error messages (not truncated at 200)', async () => {
  const c = makeSink();
  const s = captureSend();
  const longMessage = 'x'.repeat(1500);
  const backend = backendOf('stub', async (_t, emit) => {
    emit({ type: 'task.complete', taskId: 'T1', status: { state: 'completed' } });
    throw new Error(longMessage);
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  const debugLine = c.log.find((l) =>
    /backend threw after terminal taskId=T1.*message=/.test(l),
  );
  assert.ok(debugLine, `expected debug late-throw line, got: ${c.log.join(' | ')}`);
  // The full 1500-char message must be present (default lifecycle-token
  // limit of 200 would truncate it; this debug log uses a generous cap).
  assert.ok(
    debugLine.includes(longMessage),
    `expected full error message, got debug line of length ${debugLine.length}`,
  );
});

test('processTask: backend emits complete then throws -> does not double-emit, warns with errorClass only', async () => {
  const c = makeSink();
  const s = captureSend();
  // Use a custom Error subclass so we can assert the class name in the warn.
  class LateBoom extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'LateBoom';
    }
  }
  const backend = backendOf('stub', async (_t, emit) => {
    emit({ type: 'task.complete', taskId: 'T1', status: { state: 'completed' } });
    throw new LateBoom('user-prompt-secret-leak');
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  // Wire saw only the original task.complete; no fallback fail was sent.
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].type, 'task.complete');
  // warn: includes terminal kind + errorClass, but NOT the raw message.
  const warnLine = c.warn.find((l) => /backend threw after terminal taskId=T1/.test(l));
  assert.ok(warnLine, `expected late-throw warn, got: ${c.warn.join(' | ')}`);
  assert.match(warnLine, /terminal=complete/);
  assert.match(warnLine, /errorClass=LateBoom/);
  assert.equal(
    warnLine.includes('user-prompt-secret-leak'),
    false,
    'warn line must not include the raw error message',
  );
  // debug: full message available for opt-in operators.
  assert.ok(
    c.log.some((l) => /backend threw after terminal taskId=T1.*message=user-prompt-secret-leak/.test(l)),
  );
});

test('processTask: backend emits fail then throws -> does not double-emit, warns with errorClass only', async () => {
  const c = makeSink();
  const s = captureSend();
  const backend = backendOf('stub', async (_t, emit) => {
    emit({
      type: 'task.fail',
      taskId: 'T1',
      error: { code: 'upstream', message: 'gateway 500' },
    });
    throw new Error('post-fail boom');
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  assert.equal(s.sent.length, 1);
  const sent = s.sent[0];
  assert.equal(sent.type, 'task.fail');
  if (sent.type === 'task.fail') assert.equal(sent.error.code, 'upstream');
  const warnLine = c.warn.find((l) => /backend threw after terminal taskId=T1/.test(l));
  assert.ok(warnLine, `expected late-throw warn, got: ${c.warn.join(' | ')}`);
  assert.match(warnLine, /terminal=fail/);
  assert.match(warnLine, /errorClass=Error/);
  assert.equal(warnLine.includes('post-fail boom'), false, 'warn must not include raw message');
});

test('processTask: backend.start log uses the backend name', async () => {
  const c = makeSink();
  const s = captureSend();
  const backend = backendOf('my-special-backend', async (_t, emit) => {
    emit({ type: 'task.complete', taskId: 'T1', status: { state: 'completed' } });
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  assert.match(c.log[0], /backend\.start taskId=T1 backend=my-special-backend/);
});

test('processTask: backend throws after abort -> emits canceled task.complete, logs task.canceled (not task.fail)', async () => {
  const c = makeSink();
  const s = captureSend();
  const controller = new AbortController();
  controller.abort();
  const backend = backendOf('stub', async (_t, emit, signal) => {
    // Backend may have streamed an artifact before observing the abort —
    // the canceled log should still surface the artifact count.
    emit({
      type: 'task.artifact',
      taskId: 'T1',
      artifact: { artifactId: 'A', parts: [{ kind: 'text', text: 'partial' }] },
    });
    if (signal.aborted) throw new Error('aborted');
  });
  await processTask(makeAssign('T1'), controller.signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  // Wire saw the artifact + a canceled-state task.complete — not a backend_error fail.
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[0].type, 'task.artifact');
  const sent = s.sent[1];
  assert.equal(sent.type, 'task.complete');
  if (sent.type === 'task.complete') {
    assert.equal(sent.status.state, 'canceled');
    assert.ok(typeof sent.status.timestamp === 'string' && sent.status.timestamp.length > 0);
  }
  assert.ok(
    c.log.some((l) => /task\.canceled taskId=T1 elapsedMs=\d+ artifacts=1/.test(l)),
    `expected task.canceled log with artifacts=1, got: ${c.log.join(' | ')}`,
  );
  assert.ok(
    !c.log.some((l) => /task\.fail/.test(l)),
    'should not log task.fail when the throw is from cancellation',
  );
});

test('processTask: backend emits canceled task.complete on abort -> uses backend frame, logs task.canceled', async () => {
  // Well-behaved backend (like claude.ts): observes signal and emits its
  // own canceled-state task.complete instead of throwing. processTask
  // must use that frame as-is, not synthesize a fallback, and log it as
  // `task.canceled` (not `task.complete`) so the lifecycle log clearly
  // distinguishes a successful completion from a cancel.
  const c = makeSink();
  const s = captureSend();
  const controller = new AbortController();
  controller.abort();
  const backend = backendOf('stub', async (_t, emit, signal) => {
    if (signal.aborted) {
      emit({
        type: 'task.complete',
        taskId: 'T1',
        status: { state: 'canceled', timestamp: '2026-01-01T00:00:00Z' },
      });
    }
  });
  await processTask(makeAssign('T1'), controller.signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  assert.equal(s.sent.length, 1);
  const sent = s.sent[0];
  assert.equal(sent.type, 'task.complete');
  if (sent.type === 'task.complete') {
    assert.equal(sent.status.state, 'canceled');
    assert.equal(sent.status.timestamp, '2026-01-01T00:00:00Z');
  }
  assert.ok(
    c.log.some((l) => /task\.canceled taskId=T1 elapsedMs=\d+ artifacts=\d+/.test(l)),
    `expected task.canceled log, got: ${c.log.join(' | ')}`,
  );
  assert.ok(
    !c.log.some((l) => /task\.complete taskId=T1/.test(l)),
    'should not log task.complete for a canceled-state completion',
  );
});

test('processTask: sanitizes hostile taskId so wire data cannot inject log lines', async () => {
  const c = makeSink();
  const s = captureSend();
  const hostileTaskId = 'T1\n[client] FAKE INJECTED LINE';
  const backend = backendOf('stub', async (_t, emit) => {
    emit({ type: 'task.complete', taskId: hostileTaskId, status: { state: 'completed' } });
  });
  await processTask(
    { ...makeAssign(hostileTaskId), taskId: hostileTaskId },
    new AbortController().signal,
    {
      backend,
      send: s.send,
      logger: createLogger('debug', c.sink),
    },
  );
  // Every log line must remain single-line — no line should contain a raw
  // newline carried over from the taskId interpolation.
  for (const line of [...c.log, ...c.warn, ...c.error]) {
    assert.equal(
      line.includes('\n'),
      false,
      `log line contained a raw newline (log injection): ${JSON.stringify(line)}`,
    );
  }
  // The hostile suffix must appear escaped — operators can still see what
  // arrived, but it cannot break out of the line.
  assert.ok(
    c.log.some((l) => /backend\.start taskId=T1\\n\[client\] FAKE INJECTED LINE/.test(l)),
    `expected escaped taskId in backend.start, got: ${c.log.join(' | ')}`,
  );
});

test('processTask: forwards non-terminal frames (e.g. task.artifact, task.status) to send', async () => {
  const c = makeSink();
  const s = captureSend();
  const backend = backendOf('stub', async (_t, emit) => {
    emit({ type: 'task.status', taskId: 'T1', status: { state: 'working' } });
    emit({
      type: 'task.artifact',
      taskId: 'T1',
      artifact: { artifactId: 'A', parts: [{ kind: 'text', text: 'a' }] },
    });
    emit({ type: 'task.complete', taskId: 'T1', status: { state: 'completed' } });
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  assert.deepEqual(
    s.sent.map((f) => f.type),
    ['task.status', 'task.artifact', 'task.complete'],
  );
});
