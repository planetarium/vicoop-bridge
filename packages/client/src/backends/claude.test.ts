import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createClaudeBackend, type ClaudeChildHandle, type ClaudeSpawnOptions } from './claude.js';
import type { TaskAssignFrame, UpFrame } from '@vicoop-bridge/protocol';

const NEVER: AbortSignal = new AbortController().signal;

interface FakeChild extends ClaudeChildHandle {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  killed: boolean;
  killSignal: NodeJS.Signals | null;
  stdinPayload: string;
  stdinClosed: boolean;
  emitStdout(text: string): void;
  emitStderr(text: string): void;
  finish(code: number | null, sig?: NodeJS.Signals | null): void;
}

interface FakeSpawn {
  spawn: (cmd: string, args: readonly string[], options: ClaudeSpawnOptions) => ClaudeChildHandle;
  lastChild: () => FakeChild | null;
}

function makeFakeSpawn(configure: (child: FakeChild) => void): FakeSpawn {
  let last: FakeChild | null = null;
  return {
    spawn(command, args, options) {
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const closeListeners: Array<(code: number | null, sig: NodeJS.Signals | null) => void> = [];
      let closed = false;

      const mkReadable = (em: EventEmitter) =>
        ({
          on(event: string, cb: (...a: unknown[]) => void) {
            em.on(event, cb);
          },
        }) as unknown as NodeJS.ReadableStream;

      // Fake writable stream that just captures whatever the backend writes.
      // `end(payload)` is the only write call the backend makes, so we don't
      // bother differentiating write vs end here.
      const stdinChunks: string[] = [];
      const stdin: NodeJS.WritableStream = {
        write(chunk: unknown): boolean {
          stdinChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Buffer).toString('utf8'));
          return true;
        },
        end(chunk?: unknown) {
          if (chunk !== undefined) {
            stdinChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Buffer).toString('utf8'));
          }
          (child as { stdinClosed: boolean }).stdinClosed = true;
          return stdin;
        },
        on() { return stdin; },
        once() { return stdin; },
        emit() { return false; },
      } as unknown as NodeJS.WritableStream;

      const child: FakeChild = {
        command,
        args,
        cwd: options.cwd,
        stdin,
        stdout: mkReadable(stdoutEmitter),
        stderr: mkReadable(stderrEmitter),
        killed: false,
        killSignal: null,
        get stdinPayload() {
          return stdinChunks.join('');
        },
        stdinClosed: false,
        kill(sig?: NodeJS.Signals) {
          this.killed = true;
          this.killSignal = sig ?? 'SIGTERM';
          queueMicrotask(() => {
            if (closed) return;
            closed = true;
            for (const l of closeListeners) l(null, this.killSignal);
          });
          return true;
        },
        on(
          event: 'close' | 'error',
          listener:
            | ((code: number | null, signal: NodeJS.Signals | null) => void)
            | ((err: Error) => void),
        ) {
          if (event === 'close') {
            closeListeners.push(listener as (c: number | null, s: NodeJS.Signals | null) => void);
          }
          // 'error' not exercised by fakes; real spawn errors are covered in
          // the spawn_failed path separately.
        },
        emitStdout(text) {
          stdoutEmitter.emit('data', Buffer.from(text, 'utf8'));
        },
        emitStderr(text) {
          stderrEmitter.emit('data', Buffer.from(text, 'utf8'));
        },
        finish(code, sig = null) {
          if (closed) return;
          closed = true;
          for (const l of closeListeners) l(code, sig);
        },
      };
      last = child;
      configure(child);
      return child;
    },
    lastChild: () => last,
  };
}

function scriptedSpawn(opts: {
  lines?: readonly string[];
  stderr?: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
}): FakeSpawn {
  return makeFakeSpawn((child) => {
    setImmediate(() => {
      for (const l of opts.lines ?? []) child.emitStdout(l.endsWith('\n') ? l : `${l}\n`);
      if (opts.stderr) child.emitStderr(opts.stderr);
      setImmediate(() => child.finish(opts.exitCode ?? 0, opts.exitSignal ?? null));
    });
  });
}

function assign(text: string): TaskAssignFrame {
  return {
    type: 'task.assign',
    taskId: `task-${Math.random().toString(36).slice(2, 8)}`,
    contextId: 'ctx-1',
    message: {
      role: 'user',
      messageId: 'm1',
      parts: [{ kind: 'text', text }],
    },
  };
}

function collect(): { emit: (f: UpFrame) => void; frames: UpFrame[] } {
  const frames: UpFrame[] = [];
  return { emit: (f) => frames.push(f), frames };
}

function textOf(frame: UpFrame): string {
  if (frame.type === 'task.artifact') {
    const p = frame.artifact.parts[0];
    return p?.kind === 'text' ? p.text : '';
  }
  if (frame.type === 'task.complete') {
    const p = frame.status.message?.parts[0];
    return p?.kind === 'text' ? p.text : '';
  }
  return '';
}

test('streams each assistant message as its own artifact and completes with final text', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'second turn' }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'second turn' }),
    ],
    exitCode: 0,
  });

  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('hello'), emit, NEVER);

  assert.deepEqual(
    frames.map((f) => f.type),
    ['task.status', 'task.artifact', 'task.artifact', 'task.complete'],
  );

  const artifacts = frames.filter((f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact');
  assert.equal(artifacts.length, 2);
  assert.equal(textOf(artifacts[0]), 'hi there');
  assert.equal(textOf(artifacts[1]), 'second turn');
  assert.notEqual(artifacts[0].artifact.artifactId, artifacts[1].artifact.artifactId);
  assert.equal(artifacts[0].lastChunk, true);

  const complete = frames.at(-1) as Extract<UpFrame, { type: 'task.complete' }>;
  assert.equal(complete.status.state, 'completed');
  assert.equal(textOf(complete), 'second turn');
});

test('falls back to result artifact when streaming produced nothing', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'only the result' }),
    ],
    exitCode: 0,
  });

  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('x'), emit, NEVER);

  const artifacts = frames.filter((f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact');
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].artifact.name, 'claude-result');
  assert.equal(textOf(artifacts[0]), 'only the result');
});

test('maps non-zero exit to task.fail with stderr tail', async () => {
  const fake = scriptedSpawn({
    lines: [],
    stderr: 'claude: auth required\n',
    exitCode: 2,
  });

  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('x'), emit, NEVER);

  const fail = frames.find((f): f is Extract<UpFrame, { type: 'task.fail' }> => f.type === 'task.fail');
  assert.ok(fail, 'expected task.fail');
  assert.equal(fail.error.code, 'claude_exit_nonzero');
  assert.match(fail.error.message, /code 2/);
  assert.match(fail.error.message, /auth required/);
});

test('abort propagates SIGTERM and completes as canceled', async () => {
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      child.emitStdout(
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
        }) + '\n',
      );
      // Intentionally do NOT finish — the test drives termination via abort.
    });
  });

  const backend = createClaudeBackend({ spawn: fake.spawn });
  const controller = new AbortController();
  const { emit, frames } = collect();

  const runP = backend.handle(assign('x'), emit, controller.signal);
  // Let the partial artifact land before aborting.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  controller.abort();
  await runP;

  const last = frames.at(-1) as Extract<UpFrame, { type: 'task.complete' }>;
  assert.equal(last.type, 'task.complete');
  assert.equal(last.status.state, 'canceled');

  const child = fake.lastChild();
  assert.ok(child?.killed);
  assert.equal(child?.killSignal, 'SIGTERM');

  // The partial artifact still went out before cancel.
  const artifacts = frames.filter((f) => f.type === 'task.artifact');
  assert.equal(artifacts.length, 1);
});

test('rejects data parts as unsupported_part_kind without spawning', async () => {
  let spawned = 0;
  const backend = createClaudeBackend({
    spawn: () => {
      spawned++;
      throw new Error('should not spawn');
    },
  });
  const { emit, frames } = collect();
  const task: TaskAssignFrame = {
    type: 'task.assign',
    taskId: 't',
    contextId: 'c',
    message: {
      role: 'user',
      messageId: 'm1',
      parts: [{ kind: 'data', data: { foo: 'bar' } }],
    },
  };
  await backend.handle(task, emit, NEVER);

  assert.equal(spawned, 0);
  const fail = frames.find((f): f is Extract<UpFrame, { type: 'task.fail' }> => f.type === 'task.fail');
  assert.ok(fail);
  assert.equal(fail.error.code, 'unsupported_part_kind');
});

test('rejects FilePart with unsupported MIME (e.g. application/zip)', async () => {
  let spawned = 0;
  const backend = createClaudeBackend({
    spawn: () => {
      spawned++;
      throw new Error('should not spawn');
    },
  });
  const { emit, frames } = collect();
  const task: TaskAssignFrame = {
    type: 'task.assign',
    taskId: 't',
    contextId: 'c',
    message: {
      role: 'user',
      messageId: 'm1',
      parts: [{ kind: 'file', file: { mimeType: 'application/zip', bytes: 'AA==' } }],
    },
  };
  await backend.handle(task, emit, NEVER);

  assert.equal(spawned, 0);
  const fail = frames.find((f): f is Extract<UpFrame, { type: 'task.fail' }> => f.type === 'task.fail');
  assert.ok(fail);
  assert.equal(fail.error.code, 'unsupported_file_mime');
});

test('rejects FilePart whose decoded bytes exceed INPUT_FILE_MAX_BYTES (5 MiB)', async () => {
  let spawned = 0;
  const backend = createClaudeBackend({
    spawn: () => {
      spawned++;
      throw new Error('should not spawn');
    },
  });
  // 6 MiB of zeros encoded as base64 → ~8 MiB string, decoded size 6 MiB > cap.
  const oversize = Buffer.alloc(6 * 1024 * 1024).toString('base64');
  const { emit, frames } = collect();
  const task: TaskAssignFrame = {
    type: 'task.assign',
    taskId: 't',
    contextId: 'c',
    message: {
      role: 'user',
      messageId: 'm1',
      parts: [{ kind: 'file', file: { mimeType: 'image/png', bytes: oversize } }],
    },
  };
  await backend.handle(task, emit, NEVER);

  assert.equal(spawned, 0);
  const fail = frames.find((f): f is Extract<UpFrame, { type: 'task.fail' }> => f.type === 'task.fail');
  assert.ok(fail);
  assert.equal(fail.error.code, 'file_too_large');
});

test('rejects FilePart with uri-only (no inline bytes)', async () => {
  const backend = createClaudeBackend({
    spawn: () => {
      throw new Error('should not spawn');
    },
  });
  const { emit, frames } = collect();
  const task: TaskAssignFrame = {
    type: 'task.assign',
    taskId: 't',
    contextId: 'c',
    message: {
      role: 'user',
      messageId: 'm1',
      parts: [{ kind: 'file', file: { mimeType: 'image/png', uri: 'https://example.com/x.png' } }],
    },
  };
  await backend.handle(task, emit, NEVER);

  const fail = frames.find((f): f is Extract<UpFrame, { type: 'task.fail' }> => f.type === 'task.fail');
  assert.ok(fail);
  assert.equal(fail.error.code, 'unsupported_file_uri');
});

test('already-aborted signal short-circuits before spawn', async () => {
  let spawned = 0;
  const controller = new AbortController();
  controller.abort();
  const backend = createClaudeBackend({
    spawn: () => {
      spawned++;
      throw new Error('should not spawn');
    },
  });
  const { emit, frames } = collect();
  await backend.handle(assign('x'), emit, controller.signal);

  assert.equal(spawned, 0);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'task.complete');
  assert.equal((frames[0] as Extract<UpFrame, { type: 'task.complete' }>).status.state, 'canceled');
});

test('stdin envelope: text-only message becomes a single text content block', async () => {
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  await backend.handle(assign('hello world'), collect().emit, NEVER);
  const child = fake.lastChild()!;
  assert.equal(child.stdinClosed, true);
  const env = JSON.parse(child.stdinPayload.trim()) as {
    type: string;
    message: { role: string; content: Array<{ type: string; text?: string }> };
  };
  assert.equal(env.type, 'user');
  assert.equal(env.message.role, 'user');
  assert.equal(env.message.content.length, 1);
  assert.equal(env.message.content[0].type, 'text');
  assert.equal(env.message.content[0].text, 'hello world');
});

test('stdin envelope: image FilePart maps to image content block', async () => {
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const task: TaskAssignFrame = {
    type: 'task.assign',
    taskId: 't',
    contextId: 'c',
    message: {
      role: 'user',
      messageId: 'm1',
      parts: [
        { kind: 'text', text: 'what color?' },
        { kind: 'file', file: { mimeType: 'image/png', bytes: 'iVBORw0KAA==' } },
      ],
    },
  };
  await backend.handle(task, collect().emit, NEVER);
  const child = fake.lastChild()!;
  const env = JSON.parse(child.stdinPayload.trim()) as {
    message: {
      content: Array<{
        type: string;
        text?: string;
        source?: { type: string; media_type: string; data: string };
      }>;
    };
  };
  assert.equal(env.message.content.length, 2);
  assert.equal(env.message.content[0].type, 'text');
  assert.equal(env.message.content[1].type, 'image');
  assert.equal(env.message.content[1].source!.type, 'base64');
  assert.equal(env.message.content[1].source!.media_type, 'image/png');
  assert.equal(env.message.content[1].source!.data, 'iVBORw0KAA==');
});

test('stdin envelope: PDF FilePart maps to document content block', async () => {
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const task: TaskAssignFrame = {
    type: 'task.assign',
    taskId: 't',
    contextId: 'c',
    message: {
      role: 'user',
      messageId: 'm1',
      parts: [{ kind: 'file', file: { mimeType: 'application/pdf', bytes: 'JVBERi0K' } }],
    },
  };
  await backend.handle(task, collect().emit, NEVER);
  const child = fake.lastChild()!;
  const env = JSON.parse(child.stdinPayload.trim()) as {
    message: {
      content: Array<{
        type: string;
        source?: { media_type: string; data: string };
      }>;
    };
  };
  assert.equal(env.message.content.length, 1);
  assert.equal(env.message.content[0].type, 'document');
  assert.equal(env.message.content[0].source!.media_type, 'application/pdf');
  assert.equal(env.message.content[0].source!.data, 'JVBERi0K');
});

test('passes expected argv shape (stream-json, session-id, verbose, extraArgs)', async () => {
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      child.emitStdout(JSON.stringify({ type: 'result', result: 'ok' }) + '\n');
      setImmediate(() => child.finish(0));
    });
  });

  const backend = createClaudeBackend({
    spawn: fake.spawn,
    extraArgs: ['--model', 'sonnet'],
  });
  const { emit } = collect();
  await backend.handle(assign('hi'), emit, NEVER);

  const child = fake.lastChild();
  assert.ok(child);
  assert.equal(child.command, 'claude');
  // First positional flag is `-p` with no inline prompt — input now arrives
  // via stdin instead of argv.
  assert.equal(child.args[0], '-p');
  // The prompt text must NOT appear as the second arg (it's on stdin only).
  assert.notEqual(child.args[1], 'hi');

  const inFmtIdx = child.args.indexOf('--input-format');
  assert.ok(inFmtIdx !== -1, 'expected --input-format flag');
  assert.equal(child.args[inFmtIdx + 1], 'stream-json');

  const outFmtIdx = child.args.indexOf('--output-format');
  assert.ok(outFmtIdx !== -1);
  assert.equal(child.args[outFmtIdx + 1], 'stream-json');
  assert.ok(child.args.includes('--verbose'));

  const sidIdx = child.args.indexOf('--session-id');
  assert.ok(sidIdx !== -1);
  assert.match(String(child.args[sidIdx + 1]), /^[0-9a-f-]{36}$/i);

  assert.equal(child.args.at(-2), '--model');
  assert.equal(child.args.at(-1), 'sonnet');
});

test('passes configured cwd through to the Claude subprocess', async () => {
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });

  const backend = createClaudeBackend({
    spawn: fake.spawn,
    cwd: '/tmp/claude-worktree',
  });
  await backend.handle(assign('hi'), collect().emit, NEVER);

  const child = fake.lastChild();
  assert.ok(child);
  assert.equal(child.cwd, '/tmp/claude-worktree');
});

test('reuses session via --resume on a second task with the same contextId', async () => {
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const ctx = 'ctx-multi-turn';

  const t1 = assign('first');
  t1.contextId = ctx;
  const c1 = collect();
  await backend.handle(t1, c1.emit, NEVER);
  const child1 = fake.lastChild();
  assert.ok(child1);
  const sidIdx1 = child1.args.indexOf('--session-id');
  assert.ok(sidIdx1 !== -1, 'first task should pre-assign session id');
  const sid = String(child1.args[sidIdx1 + 1]);
  assert.match(sid, /^[0-9a-f-]{36}$/i);
  assert.equal(child1.args.indexOf('--resume'), -1);

  const t2 = assign('second');
  t2.contextId = ctx;
  const c2 = collect();
  await backend.handle(t2, c2.emit, NEVER);
  const child2 = fake.lastChild();
  assert.ok(child2 && child2 !== child1);
  assert.equal(child2.args.indexOf('--session-id'), -1, 'second task must not pre-assign a new id');
  const resumeIdx = child2.args.indexOf('--resume');
  assert.ok(resumeIdx !== -1);
  assert.equal(child2.args[resumeIdx + 1], sid, 'second task resumes the first session');
});

test('keeps independent sessions for distinct contextIds', async () => {
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });

  const tA = assign('a');
  tA.contextId = 'ctx-A';
  await backend.handle(tA, collect().emit, NEVER);
  const sidA = String(fake.lastChild()!.args[fake.lastChild()!.args.indexOf('--session-id') + 1]);

  const tB = assign('b');
  tB.contextId = 'ctx-B';
  await backend.handle(tB, collect().emit, NEVER);
  const sidB = String(fake.lastChild()!.args[fake.lastChild()!.args.indexOf('--session-id') + 1]);

  assert.notEqual(sidA, sidB);
});

test('expires the session binding past sessionTtlMs and starts fresh', async () => {
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });
  let nowMs = 1_000_000;
  const backend = createClaudeBackend({
    spawn: fake.spawn,
    sessionTtlMs: 5_000,
    now: () => nowMs,
  });
  const ctx = 'ctx-ttl';

  const t1 = assign('one');
  t1.contextId = ctx;
  await backend.handle(t1, collect().emit, NEVER);
  const sid1 = String(fake.lastChild()!.args[fake.lastChild()!.args.indexOf('--session-id') + 1]);

  // Jump past the TTL so the binding evicts before the next call.
  nowMs += 10_000;

  const t2 = assign('two');
  t2.contextId = ctx;
  await backend.handle(t2, collect().emit, NEVER);
  const child2 = fake.lastChild()!;
  assert.equal(child2.args.indexOf('--resume'), -1, 'expired binding should not resume');
  const sid2 = String(child2.args[child2.args.indexOf('--session-id') + 1]);
  assert.notEqual(sid1, sid2);
});

test('sessionTtlMs:0 disables resume even on the same contextId', async () => {
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn, sessionTtlMs: 0 });
  const ctx = 'ctx-disabled';

  const t1 = assign('one');
  t1.contextId = ctx;
  await backend.handle(t1, collect().emit, NEVER);
  const sid1 = String(fake.lastChild()!.args[fake.lastChild()!.args.indexOf('--session-id') + 1]);

  const t2 = assign('two');
  t2.contextId = ctx;
  await backend.handle(t2, collect().emit, NEVER);
  const child2 = fake.lastChild()!;
  assert.equal(child2.args.indexOf('--resume'), -1);
  const sid2 = String(child2.args[child2.args.indexOf('--session-id') + 1]);
  assert.notEqual(sid1, sid2);
});

test('rolls back the session binding when spawn throws', async () => {
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });
  let throwOnce = true;
  const wrappedSpawn = (cmd: string, args: readonly string[], options: ClaudeSpawnOptions) => {
    if (throwOnce) {
      throwOnce = false;
      throw new Error('ENOENT: claude not found');
    }
    return fake.spawn(cmd, args, options);
  };
  const backend = createClaudeBackend({ spawn: wrappedSpawn });
  const ctx = 'ctx-rollback';

  const t1 = assign('one');
  t1.contextId = ctx;
  const c1 = collect();
  await backend.handle(t1, c1.emit, NEVER);
  assert.equal(c1.frames.find((f) => f.type === 'task.fail')?.error.code, 'spawn_failed');

  // Retry: should mint a brand-new session id with --session-id (not --resume
  // a session that was never created).
  const t2 = assign('two');
  t2.contextId = ctx;
  await backend.handle(t2, collect().emit, NEVER);
  const child = fake.lastChild()!;
  assert.equal(child.args.indexOf('--resume'), -1);
  assert.ok(child.args.indexOf('--session-id') !== -1);
});

test('rolls back the session binding when claude exits non-zero on a fresh session', async () => {
  // First task: claude exits with a stderr message but no result. The
  // freshly-minted sessionId was never persisted on disk, so a follow-up
  // task on the same contextId must mint a NEW id rather than --resume.
  const fakeFail = scriptedSpawn({ lines: [], stderr: 'auth required\n', exitCode: 2 });
  const fakeOk = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });
  let firstCall = true;
  const wrappedSpawn = (cmd: string, args: readonly string[], opts: ClaudeSpawnOptions) => {
    if (firstCall) {
      firstCall = false;
      return fakeFail.spawn(cmd, args, opts);
    }
    return fakeOk.spawn(cmd, args, opts);
  };
  const backend = createClaudeBackend({ spawn: wrappedSpawn });
  const ctx = 'ctx-exit-rollback';

  const t1 = assign('first');
  t1.contextId = ctx;
  const c1 = collect();
  await backend.handle(t1, c1.emit, NEVER);
  assert.equal(c1.frames.find((f) => f.type === 'task.fail')?.error.code, 'claude_exit_nonzero');

  const t2 = assign('second');
  t2.contextId = ctx;
  await backend.handle(t2, collect().emit, NEVER);
  const child = fakeOk.lastChild()!;
  assert.equal(child.args.indexOf('--resume'), -1, 'must not resume an aborted session');
  assert.ok(child.args.indexOf('--session-id') !== -1, 'must mint a fresh session id');
});

test('coalesces split stdout chunks (partial line across data events)', async () => {
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      const line =
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'split' }] },
        }) + '\n';
      child.emitStdout(line.slice(0, 10));
      child.emitStdout(line.slice(10));
      child.emitStdout(JSON.stringify({ type: 'result', result: 'split' }) + '\n');
      setImmediate(() => child.finish(0));
    });
  });

  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('x'), emit, NEVER);

  const artifacts = frames.filter((f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact');
  assert.equal(artifacts.length, 1);
  assert.equal(textOf(artifacts[0]), 'split');
});

test('skips tool_result media whose decoded bytes match an inbound FilePart (input echo dedup)', async () => {
  const sharedBytes = 'iVBORw0KAA==';
  const fake = scriptedSpawn({
    lines: [
      // Same base64 the caller sent on stdin — the model "Read" the input.
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              tool_use_id: 'tu_echo',
              type: 'tool_result',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: sharedBytes },
                },
              ],
            },
          ],
        },
      }),
      JSON.stringify({ type: 'result', result: 'done' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  const task: TaskAssignFrame = {
    type: 'task.assign',
    taskId: 't',
    contextId: 'c',
    message: {
      role: 'user',
      messageId: 'm',
      parts: [
        { kind: 'text', text: 'describe' },
        { kind: 'file', file: { mimeType: 'image/png', bytes: sharedBytes } },
      ],
    },
  };
  await backend.handle(task, emit, NEVER);

  const fileArtifacts = frames.filter(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> =>
      f.type === 'task.artifact' && f.artifact.parts[0]?.kind === 'file',
  );
  assert.equal(
    fileArtifacts.length,
    0,
    'tool_result whose bytes echo the inbound FilePart must not re-emit',
  );
});

test('emits FilePart artifact when tool_result contains an image block', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              tool_use_id: 'tu_1',
              type: 'tool_result',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'AAAAB' },
                },
              ],
            },
          ],
        },
      }),
      JSON.stringify({ type: 'result', result: 'done' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('x'), emit, NEVER);

  const fileArtifact = frames.find(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> =>
      f.type === 'task.artifact' && f.artifact.parts[0]?.kind === 'file',
  );
  assert.ok(fileArtifact, 'expected a FilePart artifact for tool_result image');
  const part = fileArtifact.artifact.parts[0];
  assert.equal(part.kind, 'file');
  if (part.kind === 'file') {
    assert.equal(part.file.mimeType, 'image/png');
    assert.equal(part.file.bytes, 'AAAAB');
  }
});

test('send_file MCP: server is registered on first task and a registered handle receives invoked artifacts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sendfile-test-'));
  const realRoot = await fs.realpath(root);
  await fs.writeFile(path.join(realRoot, 'note.txt'), 'note body');

  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });
  const backend = createClaudeBackend({
    spawn: fake.spawn,
    sendFileMcp: { allowedRoots: [realRoot], skipHttp: true },
  });

  // Drive a task. After it ends, the MCP server must be running and have
  // released the task slot. We then exercise the tool path directly.
  await backend.handle(assign('x'), collect().emit, NEVER);
  const server = backend.getSendFileMcpServer();
  assert.ok(server, 'send_file MCP server should be running after the first task');
  assert.equal(server.activeTaskCount(), 0, 'task slot must release at terminal time');

  // argv must include --mcp-config with the running server's URL.
  const child = fake.lastChild();
  assert.ok(child);
  const cfgIdx = child.args.indexOf('--mcp-config');
  assert.ok(cfgIdx !== -1, 'expected --mcp-config when sendFileMcp is enabled');
  const cfg = JSON.parse(String(child.args[cfgIdx + 1])) as {
    mcpServers: Record<string, { type: string; url: string }>;
  };
  assert.equal(cfg.mcpServers['vicoop-bridge'].type, 'http');
  assert.equal(cfg.mcpServers['vicoop-bridge'].url, server.url);

  // Re-register a synthetic handle to check the routing reaches the handle's
  // emit (the lifecycle inside handle() already ran and released).
  const captured: Array<{ artifactId: string; name: string }> = [];
  const release = server.registerActiveTask({
    taskId: 'manual',
    contextId: 'ctx-manual',
    emit: (artifact) => {
      captured.push({ artifactId: artifact.artifactId, name: artifact.name });
    },
  });
  try {
    const result = await server.invokeSendFileForTest({
      path: path.join(realRoot, 'note.txt'),
    });
    assert.equal(result.ok, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, 'send-file');
  } finally {
    release.release();
    await server.close();
    await fs.rm(realRoot, { recursive: true, force: true });
  }
});

test('send_file MCP: tool call landing during an in-flight task emits a task.artifact frame', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sendfile-inflight-'));
  const realRoot = await fs.realpath(root);
  await fs.writeFile(path.join(realRoot, 'doc.txt'), 'inflight');

  // Hold the task open until we have invoked send_file on the registered slot.
  let releaseProcess: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    releaseProcess = resolve;
  });
  const fake = makeFakeSpawn((child) => {
    setImmediate(async () => {
      // Wait until the test signals us to finish.
      await ready;
      child.emitStdout(JSON.stringify({ type: 'result', result: 'ok' }) + '\n');
      setImmediate(() => child.finish(0));
    });
  });
  const backend = createClaudeBackend({
    spawn: fake.spawn,
    sendFileMcp: { allowedRoots: [realRoot], skipHttp: true },
  });
  const { emit, frames } = collect();

  const runP = backend.handle(assign('x'), emit, NEVER);

  // Wait for ensureSendFileMcp + registerActiveTask to land before invoking.
  for (let i = 0; i < 20; i++) {
    if (backend.getSendFileMcpServer()?.activeTaskCount() === 1) break;
    await new Promise((r) => setImmediate(r));
  }
  const server = backend.getSendFileMcpServer();
  assert.ok(server);
  assert.equal(server.activeTaskCount(), 1, 'task slot must register during handle()');

  const result = await server.invokeSendFileForTest({
    path: path.join(realRoot, 'doc.txt'),
  });
  assert.equal(result.ok, true);

  // Now let the child exit so handle() resolves.
  releaseProcess();
  await runP;

  const fileArtifacts = frames.filter(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> =>
      f.type === 'task.artifact' && f.artifact.parts[0]?.kind === 'file',
  );
  assert.equal(fileArtifacts.length, 1);
  const part = fileArtifacts[0].artifact.parts[0];
  if (part.kind !== 'file') throw new Error('expected file part');
  assert.equal(Buffer.from(part.file.bytes!, 'base64').toString('utf8'), 'inflight');

  await server.close();
  await fs.rm(realRoot, { recursive: true, force: true });
});
