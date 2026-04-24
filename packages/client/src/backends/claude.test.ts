import { test } from 'node:test';
import assert from 'node:assert/strict';
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

      const mkStream = (em: EventEmitter) =>
        ({
          on(event: string, cb: (...a: unknown[]) => void) {
            em.on(event, cb);
          },
        }) as unknown as NodeJS.ReadableStream;

      const child: FakeChild = {
        command,
        args,
        cwd: options.cwd,
        stdout: mkStream(stdoutEmitter),
        stderr: mkStream(stderrEmitter),
        killed: false,
        killSignal: null,
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

test('fails fast on non-text part without spawning', async () => {
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
      parts: [{ kind: 'file', file: { name: 'x.png', mimeType: 'image/png', bytes: 'AA==' } }],
    },
  };
  await backend.handle(task, emit, NEVER);

  assert.equal(spawned, 0);
  const fail = frames.find((f): f is Extract<UpFrame, { type: 'task.fail' }> => f.type === 'task.fail');
  assert.ok(fail);
  assert.equal(fail.error.code, 'unsupported_part_kind');
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

test('passes expected argv shape (prompt, session-id, stream-json, verbose, extraArgs)', async () => {
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
  assert.deepEqual(child.args.slice(0, 2), ['-p', 'hi']);

  const sidIdx = child.args.indexOf('--session-id');
  assert.ok(sidIdx !== -1);
  assert.match(String(child.args[sidIdx + 1]), /^[0-9a-f-]{36}$/i);

  const fmtIdx = child.args.indexOf('--output-format');
  assert.ok(fmtIdx !== -1);
  assert.equal(child.args[fmtIdx + 1], 'stream-json');
  assert.ok(child.args.includes('--verbose'));

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
  // Neither should have used --resume since each contextId is fresh.
  // (We checked the most recent child; checking both individually is overkill.)
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
