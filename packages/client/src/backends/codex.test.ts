import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createCodexBackend,
  type CodexChildHandle,
  type CodexSpawnOptions,
} from './codex.js';
import {
  TRACEABILITY_EXTENSION_URI,
  type TaskAssignFrame,
  type UpFrame,
} from '@vicoop-bridge/protocol';

const NEVER: AbortSignal = new AbortController().signal;

interface FakeChild extends CodexChildHandle {
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
  spawn: (cmd: string, args: readonly string[], options: CodexSpawnOptions) => CodexChildHandle;
  children: FakeChild[];
  lastChild: () => FakeChild | null;
}

function makeFakeSpawn(configure: (child: FakeChild, index: number) => void): FakeSpawn {
  const children: FakeChild[] = [];
  return {
    children,
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
      children.push(child);
      configure(child, children.length - 1);
      return child;
    },
    lastChild: () => children.at(-1) ?? null,
  };
}

function scriptedSpawn(linesByRun: readonly (readonly string[])[], exitCode = 0): FakeSpawn {
  return makeFakeSpawn((child, index) => {
    setImmediate(() => {
      for (const l of linesByRun[index] ?? []) child.emitStdout(l.endsWith('\n') ? l : `${l}\n`);
      setImmediate(() => child.finish(exitCode));
    });
  });
}

function assign(text: string, contextId = 'ctx-1'): TaskAssignFrame {
  return {
    type: 'task.assign',
    taskId: `task-${Math.random().toString(36).slice(2, 8)}`,
    contextId,
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

test('text-only task spawns codex exec --json - and writes prompt to stdin', async () => {
  const fake = scriptedSpawn([
    [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } }),
    ],
  ]);

  const backend = createCodexBackend({
    spawn: fake.spawn,
    cwd: '/repo',
    hasGitDir: async () => true,
  });
  const { emit, frames } = collect();
  await backend.handle(assign('say hi'), emit, NEVER);

  const child = fake.lastChild()!;
  assert.equal(child.command, 'codex');
  assert.deepEqual(child.args, ['exec', '--json', '-c', 'sandbox_mode="read-only"', '-']);
  assert.equal(child.cwd, '/repo');
  assert.equal(child.stdinPayload, 'say hi');
  assert.equal(child.stdinClosed, true);

  assert.deepEqual(
    frames.map((f) => f.type),
    ['task.status', 'task.artifact', 'task.complete'],
  );
  assert.equal(textOf(frames[1]), 'hello');
  assert.equal(textOf(frames[2]), 'hello');
});

test('parses trailing JSONL event without final newline', async () => {
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      child.emitStdout(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'tail' } }));
      setImmediate(() => child.finish(0));
    });
  });

  const backend = createCodexBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('x'), emit, NEVER);

  const artifact = frames.find((f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact');
  assert.ok(artifact);
  assert.equal(textOf(artifact), 'tail');
});


test('thread.started id is reused via codex exec resume on the same contextId', async () => {
  const fake = scriptedSpawn([
    [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-a' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
    ],
    [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'second' } }),
    ],
  ]);

  const backend = createCodexBackend({ spawn: fake.spawn });
  await backend.handle(assign('one', 'ctx'), collect().emit, NEVER);
  await backend.handle(assign('two', 'ctx'), collect().emit, NEVER);

  assert.deepEqual(fake.children[0].args, [
    'exec',
    '--json',
    '-c',
    'sandbox_mode="read-only"',
    '-',
  ]);
  assert.deepEqual(fake.children[1].args, [
    'exec',
    'resume',
    '--json',
    '-c',
    'sandbox_mode="read-only"',
    'thread-a',
    '-',
  ]);
});

test('sandboxMode is passed as a Codex config override on initial and resume runs', async () => {
  const fake = scriptedSpawn([
    [JSON.stringify({ type: 'thread.started', thread_id: 'thread-a' })],
    [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'again' } })],
  ]);

  const backend = createCodexBackend({
    spawn: fake.spawn,
    sandboxMode: 'read-only',
  });
  await backend.handle(assign('one', 'ctx'), collect().emit, NEVER);
  await backend.handle(assign('two', 'ctx'), collect().emit, NEVER);

  assert.deepEqual(fake.children[0].args, [
    'exec',
    '--json',
    '-c',
    'sandbox_mode="read-only"',
    '-',
  ]);
  assert.deepEqual(fake.children[1].args, [
    'exec',
    'resume',
    '--json',
    '-c',
    'sandbox_mode="read-only"',
    'thread-a',
    '-',
  ]);
});

test('extraArgs follow sandboxMode config so tests/operators can override it', async () => {
  const fake = scriptedSpawn([[JSON.stringify({ type: 'thread.started', thread_id: 'thread-a' })]]);

  const backend = createCodexBackend({
    spawn: fake.spawn,
    sandboxMode: 'read-only',
    extraArgs: ['-c', 'sandbox_mode="workspace-write"'],
  });
  await backend.handle(assign('one'), collect().emit, NEVER);

  assert.deepEqual(fake.lastChild()!.args, [
    'exec',
    '--json',
    '-c',
    'sandbox_mode="read-only"',
    '-c',
    'sandbox_mode="workspace-write"',
    '-',
  ]);
});

test('distinct contextIds get distinct sessions', async () => {
  const fake = scriptedSpawn([
    [JSON.stringify({ type: 'thread.started', thread_id: 'thread-a' })],
    [JSON.stringify({ type: 'thread.started', thread_id: 'thread-b' })],
    [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'again' } })],
  ]);

  const backend = createCodexBackend({ spawn: fake.spawn });
  await backend.handle(assign('one', 'ctx-a'), collect().emit, NEVER);
  await backend.handle(assign('two', 'ctx-b'), collect().emit, NEVER);
  await backend.handle(assign('again', 'ctx-a'), collect().emit, NEVER);

  assert.deepEqual(fake.children[2].args, [
    'exec',
    'resume',
    '--json',
    '-c',
    'sandbox_mode="read-only"',
    'thread-a',
    '-',
  ]);
});

test('session TTL expiry starts a new codex exec run', async () => {
  let now = 0;
  const fake = scriptedSpawn([
    [JSON.stringify({ type: 'thread.started', thread_id: 'thread-a' })],
    [JSON.stringify({ type: 'thread.started', thread_id: 'thread-b' })],
  ]);

  const backend = createCodexBackend({
    spawn: fake.spawn,
    sessionTtlMs: 5_000,
    now: () => now,
  });
  await backend.handle(assign('one', 'ctx'), collect().emit, NEVER);
  now = 6_000;
  await backend.handle(assign('two', 'ctx'), collect().emit, NEVER);

  assert.deepEqual(fake.children[1].args, [
    'exec',
    '--json',
    '-c',
    'sandbox_mode="read-only"',
    '-',
  ]);
});

test('abort after image materialization completes before spawn and cleans temp dir', async () => {
  let spawned = 0;
  const removed: string[] = [];
  const controller = new AbortController();
  const backend = createCodexBackend({
    spawn: () => {
      spawned++;
      throw new Error('should not spawn');
    },
    mkdtemp: async () => '/tmp/vicoop-codex-test',
    writeFile: async () => {
      controller.abort();
    },
    rm: async (filePath) => {
      removed.push(String(filePath));
    },
  });
  const task: TaskAssignFrame = {
    type: 'task.assign',
    taskId: 't',
    contextId: 'c',
    message: {
      role: 'user',
      messageId: 'm1',
      parts: [{ kind: 'file', file: { mimeType: 'image/png', bytes: Buffer.from('png').toString('base64') } }],
    },
  };

  const { emit, frames } = collect();
  await backend.handle(task, emit, controller.signal);

  assert.equal(spawned, 0);
  assert.deepEqual(removed, ['/tmp/vicoop-codex-test']);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'task.complete');
  assert.equal((frames[0] as Extract<UpFrame, { type: 'task.complete' }>).status.state, 'canceled');
});

test('resume spawn failure rolls back TTL refresh for the existing session', async () => {
  let now = 0;
  let calls = 0;
  const fake = scriptedSpawn([
    [JSON.stringify({ type: 'thread.started', thread_id: 'thread-a' })],
    [JSON.stringify({ type: 'thread.started', thread_id: 'thread-b' })],
  ]);
  const backend = createCodexBackend({
    sessionTtlMs: 5_000,
    now: () => now,
    spawn: (command, args, options) => {
      calls++;
      if (calls === 2) throw new Error('spawn failed');
      return fake.spawn(command, args, options);
    },
  });

  await backend.handle(assign('one', 'ctx'), collect().emit, NEVER);
  now = 4_000;
  const failed = collect();
  await backend.handle(assign('two', 'ctx'), failed.emit, NEVER);
  now = 6_000;
  await backend.handle(assign('three', 'ctx'), collect().emit, NEVER);

  const fail = failed.frames.find((f): f is Extract<UpFrame, { type: 'task.fail' }> => f.type === 'task.fail');
  assert.equal(fail?.error.code, 'spawn_failed');
  assert.deepEqual(fake.children[1].args, [
    'exec',
    '--json',
    '-c',
    'sandbox_mode="read-only"',
    '-',
  ]);
});

test('command_execution emits trace artifact only when traceability is requested', async () => {
  const line = JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      command: 'npm test',
      aggregated_output: 'ok',
      exit_code: 0,
      status: 'completed',
    },
  });

  const withoutTrace = scriptedSpawn([[line]]);
  const backendA = createCodexBackend({ spawn: withoutTrace.spawn });
  const framesA = collect();
  await backendA.handle(assign('x'), framesA.emit, NEVER);
  assert.equal(framesA.frames.filter((f) => f.type === 'task.artifact').length, 0);

  const withTrace = scriptedSpawn([[line]]);
  const backendB = createCodexBackend({ spawn: withTrace.spawn });
  const framesB = collect();
  await backendB.handle(
    { ...assign('x'), requestedExtensions: [TRACEABILITY_EXTENSION_URI] },
    framesB.emit,
    NEVER,
  );
  const artifact = framesB.frames.find((f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact');
  assert.ok(artifact);
  assert.equal(artifact.artifact.name, 'codex-command-execution');
  assert.equal(artifact.artifact.metadata?.traceType, 'command-execution');
  assert.match(textOf(artifact), /npm test/);
});

test('nonzero exit emits task.fail with stderr tail', async () => {
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      child.emitStderr('codex: auth required\n');
      setImmediate(() => child.finish(2));
    });
  });

  const backend = createCodexBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('x'), emit, NEVER);

  const fail = frames.find((f): f is Extract<UpFrame, { type: 'task.fail' }> => f.type === 'task.fail');
  assert.ok(fail);
  assert.equal(fail.error.code, 'codex_exit_nonzero');
  assert.match(fail.error.message, /code 2/);
  assert.match(fail.error.message, /auth required/);
  assert.match(fail.error.message, /argv=/);
});

test('nonzero exit message includes argv and cwd for repro (#147)', async () => {
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      child.emitStderr('boom\n');
      setImmediate(() => child.finish(1));
    });
  });

  const backend = createCodexBackend({
    spawn: fake.spawn,
    cwd: '/srv/agent-work',
    hasGitDir: async () => true,
  });
  const { emit, frames } = collect();
  await backend.handle(assign('x'), emit, NEVER);

  const fail = frames.find((f): f is Extract<UpFrame, { type: 'task.fail' }> => f.type === 'task.fail');
  assert.ok(fail);
  assert.equal(fail.error.code, 'codex_exit_nonzero');
  assert.match(fail.error.message, /argv=\[/);
  assert.match(fail.error.message, /"codex"/);
  assert.match(fail.error.message, /"exec"/);
  assert.match(fail.error.message, /cwd="\/srv\/agent-work"/);
});

test('cwd that is not a git repository fails fast with codex_cwd_not_git_repo (#147)', async () => {
  let spawned = 0;
  const backend = createCodexBackend({
    spawn: () => {
      spawned++;
      throw new Error('should not spawn');
    },
    cwd: '/tmp/not-a-repo',
    hasGitDir: async () => false,
  });
  const { emit, frames } = collect();
  await backend.handle(assign('x'), emit, NEVER);

  assert.equal(spawned, 0);
  const fail = frames.find((f): f is Extract<UpFrame, { type: 'task.fail' }> => f.type === 'task.fail');
  assert.ok(fail);
  assert.equal(fail.error.code, 'codex_cwd_not_git_repo');
  assert.match(fail.error.message, /not a git repository/);
  assert.match(fail.error.message, /--skip-git-repo-check/);
});

test('--skip-git-repo-check in extraArgs bypasses the git pre-check (#147)', async () => {
  const fake = scriptedSpawn([
    [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })],
  ]);

  const backend = createCodexBackend({
    spawn: fake.spawn,
    cwd: '/tmp/not-a-repo',
    extraArgs: ['--skip-git-repo-check'],
    // Would return false if asked, but the bypass must mean we never ask.
    hasGitDir: async () => {
      throw new Error('hasGitDir should not be called when --skip-git-repo-check is set');
    },
  });
  const { emit, frames } = collect();
  await backend.handle(assign('x'), emit, NEVER);

  const child = fake.lastChild()!;
  assert.ok(child.args.includes('--skip-git-repo-check'));
  assert.ok(frames.some((f) => f.type === 'task.complete'));
});

test('hasGitDir is not invoked when cwd is unset', async () => {
  const fake = scriptedSpawn([
    [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })],
  ]);
  let invoked = false;
  const backend = createCodexBackend({
    spawn: fake.spawn,
    hasGitDir: async () => {
      invoked = true;
      return true;
    },
  });
  const { emit } = collect();
  await backend.handle(assign('x'), emit, NEVER);
  assert.equal(invoked, false);
});

test('signal exit emits task.fail without code null wording', async () => {
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      child.emitStderr('codex: interrupted\n');
      setImmediate(() => child.finish(null, 'SIGTERM'));
    });
  });

  const backend = createCodexBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('x'), emit, NEVER);

  const fail = frames.find((f): f is Extract<UpFrame, { type: 'task.fail' }> => f.type === 'task.fail');
  assert.ok(fail);
  assert.equal(fail.error.code, 'codex_exit_nonzero');
  assert.match(fail.error.message, /terminated by signal SIGTERM/);
  assert.doesNotMatch(fail.error.message, /code null/);
  assert.match(fail.error.message, /interrupted/);
});

test('abort kills the child and emits canceled completion', async () => {
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      child.emitStdout(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }) + '\n');
    });
  });

  const backend = createCodexBackend({ spawn: fake.spawn });
  const controller = new AbortController();
  const { emit, frames } = collect();
  const runP = backend.handle(assign('x'), emit, controller.signal);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  controller.abort();
  await runP;

  assert.ok(fake.lastChild()?.killed);
  assert.equal(fake.lastChild()?.killSignal, 'SIGTERM');
  const last = frames.at(-1) as Extract<UpFrame, { type: 'task.complete' }>;
  assert.equal(last.type, 'task.complete');
  assert.equal(last.status.state, 'canceled');
});

test('image FilePart.bytes creates temp files and passes --image args', async () => {
  const fake = scriptedSpawn([[JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })]]);
  const written: Array<{ path: string; data: Buffer }> = [];
  const removed: string[] = [];
  const backend = createCodexBackend({
    spawn: fake.spawn,
    mkdtemp: async () => '/tmp/vicoop-codex-test',
    writeFile: async (filePath, data) => {
      written.push({ path: String(filePath), data: Buffer.from(data as Buffer) });
    },
    rm: async (filePath) => {
      removed.push(String(filePath));
    },
  });
  const task: TaskAssignFrame = {
    type: 'task.assign',
    taskId: 't',
    contextId: 'c',
    message: {
      role: 'user',
      messageId: 'm1',
      parts: [
        { kind: 'text', text: 'what is this?' },
        { kind: 'file', file: { mimeType: 'image/png', bytes: Buffer.from('png').toString('base64') } },
      ],
    },
  };

  await backend.handle(task, collect().emit, NEVER);

  assert.equal(written.length, 1);
  assert.equal(written[0].path, '/tmp/vicoop-codex-test/image-1.png');
  assert.equal(written[0].data.toString('utf8'), 'png');
  assert.deepEqual(fake.lastChild()!.args, [
    'exec',
    '--json',
    '-c',
    'sandbox_mode="read-only"',
    '--image',
    '/tmp/vicoop-codex-test/image-1.png',
    '-',
  ]);
  assert.deepEqual(removed, ['/tmp/vicoop-codex-test']);
});

test('unsupported file and data parts fail fast before spawn', async () => {
  let spawned = 0;
  const backend = createCodexBackend({
    spawn: () => {
      spawned++;
      throw new Error('should not spawn');
    },
  });

  const dataTask: TaskAssignFrame = {
    type: 'task.assign',
    taskId: 't1',
    contextId: 'c',
    message: { role: 'user', messageId: 'm1', parts: [{ kind: 'data', data: { foo: 'bar' } }] },
  };
  const pdfTask: TaskAssignFrame = {
    type: 'task.assign',
    taskId: 't2',
    contextId: 'c',
    message: {
      role: 'user',
      messageId: 'm2',
      parts: [{ kind: 'file', file: { mimeType: 'application/pdf', bytes: 'JVBERi0K' } }],
    },
  };

  const framesA = collect();
  const framesB = collect();
  await backend.handle(dataTask, framesA.emit, NEVER);
  await backend.handle(pdfTask, framesB.emit, NEVER);

  assert.equal(spawned, 0);
  assert.equal((framesA.frames[0] as Extract<UpFrame, { type: 'task.fail' }>).error.code, 'unsupported_part_kind');
  assert.equal((framesB.frames[0] as Extract<UpFrame, { type: 'task.fail' }>).error.code, 'unsupported_file_mime');
});

test('image materialization failure emits task.fail and cleans temp dir before spawn', async () => {
  let spawned = 0;
  const removed: string[] = [];
  const backend = createCodexBackend({
    spawn: () => {
      spawned++;
      throw new Error('should not spawn');
    },
    mkdtemp: async () => '/tmp/vicoop-codex-test',
    writeFile: async () => {
      throw new Error('disk full');
    },
    rm: async (filePath) => {
      removed.push(String(filePath));
    },
  });
  const task: TaskAssignFrame = {
    type: 'task.assign',
    taskId: 't',
    contextId: 'c',
    message: {
      role: 'user',
      messageId: 'm1',
      parts: [{ kind: 'file', file: { mimeType: 'image/png', bytes: Buffer.from('png').toString('base64') } }],
    },
  };

  const { emit, frames } = collect();
  await backend.handle(task, emit, NEVER);

  assert.equal(spawned, 0);
  assert.deepEqual(removed, ['/tmp/vicoop-codex-test']);
  const fail = frames[0] as Extract<UpFrame, { type: 'task.fail' }>;
  assert.equal(fail.type, 'task.fail');
  assert.equal(fail.error.code, 'input_file_write_failed');
  assert.match(fail.error.message, /disk full/);
});
