import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Part, TaskAssignFrame, UpFrame } from '@vicoop-bridge/protocol';
import type { Backend, Emit } from './backend.js';
import { processTask, summarizeParts } from './client.js';
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
  const backend = backendOf('stub', async (_t, _emit, signal) => {
    if (signal.aborted) throw new Error('aborted');
  });
  await processTask(makeAssign('T1'), controller.signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  // Wire saw a canceled-state task.complete — not a backend_error fail.
  assert.equal(s.sent.length, 1);
  const sent = s.sent[0];
  assert.equal(sent.type, 'task.complete');
  if (sent.type === 'task.complete') {
    assert.equal(sent.status.state, 'canceled');
    assert.ok(typeof sent.status.timestamp === 'string' && sent.status.timestamp.length > 0);
  }
  assert.ok(
    c.log.some((l) => /task\.canceled taskId=T1 elapsedMs=\d+/.test(l)),
    `expected task.canceled log, got: ${c.log.join(' | ')}`,
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
