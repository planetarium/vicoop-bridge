import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createCodexBackend,
  type CodexChildHandle,
  type CodexSpawnOptions,
} from './codex.js';
import type { Logger } from '../logger.js';
import {
  OPENAI_COMPAT_EXTENSION_URI,
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

  const backend = createCodexBackend({ spawn: fake.spawn, cwd: '/repo' });
  const { emit, frames } = collect();
  await backend.handle(assign('say hi'), emit, NEVER);

  const child = fake.lastChild()!;
  assert.equal(child.command, 'codex');
  assert.deepEqual(child.args, [
    'exec',
    '--json',
    '-c',
    'sandbox_mode="read-only"',
    '--skip-git-repo-check',
    '-',
  ]);
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
    '--skip-git-repo-check',
    '-',
  ]);
  assert.deepEqual(fake.children[1].args, [
    'exec',
    'resume',
    '--json',
    '-c',
    'sandbox_mode="read-only"',
    '--skip-git-repo-check',
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
    '--skip-git-repo-check',
    '-',
  ]);
  assert.deepEqual(fake.children[1].args, [
    'exec',
    'resume',
    '--json',
    '-c',
    'sandbox_mode="read-only"',
    '--skip-git-repo-check',
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
    '--skip-git-repo-check',
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
    '--skip-git-repo-check',
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
    '--skip-git-repo-check',
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
    '--skip-git-repo-check',
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

test('nonzero exit emits task.fail with stderr tail (no host-local argv/cwd on the wire)', async () => {
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
  // argv and cwd are host-local — they go to the local logger, not the
  // wire-level error.message which the bridge forwards to the caller.
  assert.doesNotMatch(fail.error.message, /argv=/);
  assert.doesNotMatch(fail.error.message, /cwd=/);
});

test('exec-failure repro line goes to the local logger, not the wire (#147)', async () => {
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      child.emitStderr('boom\n');
      setImmediate(() => child.finish(1));
    });
  });

  const warnLines: string[] = [];
  const stubLogger: Logger = {
    level: 'info',
    error: () => {},
    warn: (...a: unknown[]) => warnLines.push(a.map(String).join(' ')),
    info: () => {},
    debug: () => {},
  };

  const backend = createCodexBackend({
    spawn: fake.spawn,
    cwd: '/srv/agent-work',
    logger: stubLogger,
  });
  const { emit, frames } = collect();
  await backend.handle(assign('x'), emit, NEVER);

  // Wire-level message stays free of host-local detail.
  const fail = frames.find((f): f is Extract<UpFrame, { type: 'task.fail' }> => f.type === 'task.fail');
  assert.ok(fail);
  assert.equal(fail.error.code, 'codex_exit_nonzero');
  assert.doesNotMatch(fail.error.message, /\/srv\/agent-work/);

  // Local logger receives an argv summary (clipped to 400 chars in
  // codex.ts) + cwd for operator debugging.
  const repro = warnLines.find((l) => l.includes('codex exec-failure repro'));
  assert.ok(repro, `expected a repro warn line, got: ${JSON.stringify(warnLines)}`);
  assert.match(repro, /argv=\[/);
  assert.match(repro, /"codex"/);
  assert.match(repro, /cwd="\/srv\/agent-work"/);
});

test('exec-failure repro line sanitizes taskId and escapes line separators (#147)', async () => {
  // Wire-derived taskId can contain newlines / control chars; argv / cwd
  // values can contain U+2028 / U+2029 which JSON.stringify leaves raw
  // but some log sinks treat as line breaks. The repro line must stay
  // single-line and must not let an attacker inject fake [client] lines.
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      child.emitStderr('boom\n');
      setImmediate(() => child.finish(1));
    });
  });

  const warnLines: string[] = [];
  const stubLogger: Logger = {
    level: 'info',
    error: () => {},
    warn: (...a: unknown[]) => warnLines.push(a.map(String).join(' ')),
    info: () => {},
    debug: () => {},
  };

  const backend = createCodexBackend({
    spawn: fake.spawn,
    cwd: '/srv/a\u2028b', // U+2028 in cwd
    logger: stubLogger,
  });
  const hostileTask: TaskAssignFrame = {
    type: 'task.assign',
    taskId: 'evil\n[client] FAKE',
    contextId: 'ctx',
    message: { role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: 'x' }] },
  };

  await backend.handle(hostileTask, collect().emit, NEVER);

  const repro = warnLines.find((l) => l.includes('codex exec-failure repro'));
  assert.ok(repro);
  // taskId's embedded newline must be escaped, not preserved as a real LF.
  assert.doesNotMatch(repro, /\n\[client\] FAKE/);
  assert.match(repro, /taskId=evil\\n\[client\] FAKE/);
  // U+2028 in cwd must be escaped to its \uXXXX form. (RegExp ctor used
  // so the source file doesn't carry a raw U+2028 of its own — esbuild
  // parses raw U+2028 in a regex literal as a line terminator.)
  assert.doesNotMatch(repro, /\u2028/);
  assert.match(repro, /\\u2028/);
});

test('--skip-git-repo-check is auto-added so non-git cwds work out of the box (#147)', async () => {
  const fake = scriptedSpawn([
    [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })],
  ]);
  const backend = createCodexBackend({ spawn: fake.spawn, cwd: '/tmp/not-a-repo' });
  const { emit, frames } = collect();
  await backend.handle(assign('x'), emit, NEVER);

  const child = fake.lastChild()!;
  assert.ok(
    child.args.includes('--skip-git-repo-check'),
    `expected --skip-git-repo-check in argv, got ${JSON.stringify(child.args)}`,
  );
  assert.ok(frames.some((f) => f.type === 'task.complete'));
});

test('--skip-git-repo-check is not duplicated when extraArgs already lists it (#147)', async () => {
  const fake = scriptedSpawn([
    [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })],
  ]);
  const backend = createCodexBackend({
    spawn: fake.spawn,
    extraArgs: ['--skip-git-repo-check'],
  });
  await backend.handle(assign('x'), collect().emit, NEVER);

  const args = fake.lastChild()!.args;
  const occurrences = args.filter((a) => a === '--skip-git-repo-check').length;
  assert.equal(occurrences, 1, `expected exactly one --skip-git-repo-check, got ${occurrences} in ${JSON.stringify(args)}`);
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
    '--skip-git-repo-check',
    '--image',
    '/tmp/vicoop-codex-test/image-1.png',
    '-',
  ]);
  assert.deepEqual(removed, ['/tmp/vicoop-codex-test']);
});

test('unsupported file parts fail fast before spawn', async () => {
  let spawned = 0;
  const backend = createCodexBackend({
    spawn: () => {
      spawned++;
      throw new Error('should not spawn');
    },
  });

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

  const frames = collect();
  await backend.handle(pdfTask, frames.emit, NEVER);

  assert.equal(spawned, 0);
  assert.equal((frames.frames[0] as Extract<UpFrame, { type: 'task.fail' }>).error.code, 'unsupported_file_mime');
});

test('data parts are serialized into the codex prompt as tagged JSON', async () => {
  const fake = scriptedSpawn([
    [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })],
  ]);
  const backend = createCodexBackend({ spawn: fake.spawn });

  const task: TaskAssignFrame = {
    type: 'task.assign',
    taskId: 't-data',
    contextId: 'c',
    message: {
      role: 'user',
      messageId: 'm1',
      parts: [
        { kind: 'text', text: 'summarize' },
        { kind: 'data', data: { ticket: 42, priority: 'high' } },
      ],
    },
  };

  const { emit, frames } = collect();
  await backend.handle(task, emit, NEVER);

  const child = fake.lastChild()!;
  assert.match(child.stdinPayload, /^summarize\n\n<context kind="application\/json">\n/);
  assert.ok(child.stdinPayload.includes('"ticket": 42'));
  assert.ok(child.stdinPayload.includes('"priority": "high"'));
  assert.ok(child.stdinPayload.endsWith('</context>'));

  const failFrame = frames.find((f) => f.type === 'task.fail');
  assert.equal(failFrame, undefined);
});

test('data-only message produces a prompt with just the JSON context block', async () => {
  const fake = scriptedSpawn([
    [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })],
  ]);
  const backend = createCodexBackend({ spawn: fake.spawn });

  const task: TaskAssignFrame = {
    type: 'task.assign',
    taskId: 't-data-only',
    contextId: 'c',
    message: {
      role: 'user',
      messageId: 'm1',
      parts: [{ kind: 'data', data: { hello: 'world' } }],
    },
  };

  const { emit } = collect();
  await backend.handle(task, emit, NEVER);

  const child = fake.lastChild()!;
  assert.match(child.stdinPayload, /^<context kind="application\/json">\n/);
  assert.ok(child.stdinPayload.includes('"hello": "world"'));
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

// ---------------------------------------------------------------------------
// openai-compat extension
//
// The pure helpers (parseOpenAICompatMetadata, buildOpenAICompatSystemPrompt,
// formatToolCallHistory, tryParseToolCallsEnvelope) live in claude.ts and are
// covered by claude.test.ts — codex.ts imports them verbatim, so we only test
// the codex-specific wiring here: argv injection of the `-c
// model_instructions_file=...` seam, file write/cleanup lifecycle, history
// prepend on the stdin prompt, and envelope→data-part artifact conversion.
// ---------------------------------------------------------------------------

const SAMPLE_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
      },
    },
  },
];

function assignWithOpenAICompat(
  text: string,
  payload: Record<string, unknown>,
  contextId = 'ctx-1',
): TaskAssignFrame {
  const base = assign(text, contextId);
  return {
    ...base,
    message: {
      ...base.message,
      metadata: { [OPENAI_COMPAT_EXTENSION_URI]: payload },
    },
  };
}

test('argv carries `-c model_instructions_file=...` and the file contains the envelope contract', async () => {
  const fake = scriptedSpawn([
    [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })],
  ]);
  const written: Array<{ path: string; data: Buffer }> = [];
  const removed: string[] = [];
  const backend = createCodexBackend({
    spawn: fake.spawn,
    mkdtemp: async () => '/tmp/vicoop-codex-instr',
    writeFile: async (filePath, data) => {
      written.push({ path: String(filePath), data: Buffer.from(data as Buffer) });
    },
    rm: async (filePath) => {
      removed.push(String(filePath));
    },
  });

  await backend.handle(
    assignWithOpenAICompat('what is the weather?', {
      system: 'You are concise.',
      tools: SAMPLE_TOOLS,
      tool_choice: 'auto',
    }),
    collect().emit,
    NEVER,
  );

  // Exactly one instructions file written under the freshly-minted temp dir.
  assert.equal(written.length, 1);
  assert.equal(written[0].path, '/tmp/vicoop-codex-instr/instructions.md');
  const body = written[0].data.toString('utf8');
  // The user system precedes the envelope contract in the rendered file.
  assert.match(body, /^You are concise\./);
  assert.match(body, /"tool_calls":\[\{"id":"call_<unique>"/);
  assert.match(body, /"name": "get_weather"/);
  assert.match(body, /tool_choice="auto"/);

  // The argv carries the `-c model_instructions_file="..."` pair; the value
  // is TOML-quoted (so paths with spaces / unicode survive). Position is
  // after the sandbox `-c` block and `--skip-git-repo-check`, before any
  // operator extras — pin it precisely.
  assert.deepEqual(fake.lastChild()!.args, [
    'exec',
    '--json',
    '-c',
    'sandbox_mode="read-only"',
    '--skip-git-repo-check',
    '-c',
    'model_instructions_file="/tmp/vicoop-codex-instr/instructions.md"',
    '-',
  ]);

  // Cleanup ran on the instructions temp dir.
  assert.deepEqual(removed, ['/tmp/vicoop-codex-instr']);
});

test('absent metadata → no instructions file is written and no `model_instructions_file` arg appears', async () => {
  const fake = scriptedSpawn([
    [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })],
  ]);
  let mkdtempCalls = 0;
  const written: string[] = [];
  const backend = createCodexBackend({
    spawn: fake.spawn,
    mkdtemp: async () => {
      mkdtempCalls++;
      return '/tmp/vicoop-codex-instr';
    },
    writeFile: async (filePath) => {
      written.push(String(filePath));
    },
    rm: async () => {},
  });

  await backend.handle(assign('hello'), collect().emit, NEVER);

  // No openai-compat metadata → no temp dir, no instructions file.
  assert.equal(mkdtempCalls, 0);
  assert.deepEqual(written, []);
  const args = fake.lastChild()!.args;
  assert.equal(
    args.some((a) => typeof a === 'string' && a.startsWith('model_instructions_file=')),
    false,
  );
});

test('instructions file is co-located with the image temp dir when both are present (single cleanup)', async () => {
  // When the task also carries images, mapPartsToCodexInput already minted
  // a temp dir for them. The instructions file MUST land in that same dir
  // so a single `rm -r` cleans both, and no second mkdtemp is issued.
  const fake = scriptedSpawn([
    [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })],
  ]);
  let mkdtempCalls = 0;
  const written: Array<{ path: string; data: Buffer }> = [];
  const removed: string[] = [];
  const backend = createCodexBackend({
    spawn: fake.spawn,
    mkdtemp: async () => {
      mkdtempCalls++;
      return '/tmp/vicoop-codex-mix';
    },
    writeFile: async (filePath, data) => {
      written.push({ path: String(filePath), data: Buffer.from(data as Buffer) });
    },
    rm: async (filePath) => {
      removed.push(String(filePath));
    },
  });

  const taskWithImage: TaskAssignFrame = {
    ...assignWithOpenAICompat('what is this?', {
      tools: SAMPLE_TOOLS,
      tool_choice: 'auto',
    }),
    message: {
      role: 'user',
      messageId: 'm1',
      parts: [
        { kind: 'text', text: 'what is this?' },
        { kind: 'file', file: { mimeType: 'image/png', bytes: Buffer.from('png').toString('base64') } },
      ],
      metadata: {
        [OPENAI_COMPAT_EXTENSION_URI]: {
          tools: SAMPLE_TOOLS,
          tool_choice: 'auto',
        },
      },
    },
  };

  await backend.handle(taskWithImage, collect().emit, NEVER);

  // mkdtemp ran exactly once (the image path); the instructions file
  // landed in the same dir so cleanup is a single rm.
  assert.equal(mkdtempCalls, 1);
  const paths = written.map((w) => w.path);
  assert.ok(paths.includes('/tmp/vicoop-codex-mix/image-1.png'));
  assert.ok(paths.includes('/tmp/vicoop-codex-mix/instructions.md'));
  // Only one rm — for the shared dir.
  assert.deepEqual(removed, ['/tmp/vicoop-codex-mix']);
});

test('instructions write failure emits task.fail and cleans the freshly-minted temp dir', async () => {
  // Mirror the image write-failure path: the file the operator could see
  // referenced in the failure message is the system prompt one. The
  // instructions temp dir was minted just for this run, so it must be
  // cleaned even though the child never spawned.
  let spawned = 0;
  const removed: string[] = [];
  const backend = createCodexBackend({
    spawn: () => {
      spawned++;
      throw new Error('should not spawn');
    },
    mkdtemp: async () => '/tmp/vicoop-codex-instr-fail',
    writeFile: async () => {
      throw new Error('disk full');
    },
    rm: async (filePath) => {
      removed.push(String(filePath));
    },
  });

  const { emit, frames } = collect();
  await backend.handle(
    assignWithOpenAICompat('go', { tools: SAMPLE_TOOLS, tool_choice: 'auto' }),
    emit,
    NEVER,
  );

  assert.equal(spawned, 0);
  assert.deepEqual(removed, ['/tmp/vicoop-codex-instr-fail']);
  const fail = frames[0] as Extract<UpFrame, { type: 'task.fail' }>;
  assert.equal(fail.type, 'task.fail');
  assert.equal(fail.error.code, 'input_file_write_failed');
  assert.match(fail.error.message, /failed to materialize codex instructions/);
  assert.match(fail.error.message, /disk full/);
});

test('agent_message envelope JSON becomes a data-part artifact tagged with the extension URI', async () => {
  const envelope = {
    tool_calls: [
      { id: 'call_abc', function: { name: 'get_weather', arguments: { city: 'Seoul' } } },
    ],
  };
  const fake = scriptedSpawn([
    [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify(envelope) },
      }),
    ],
  ]);
  const backend = createCodexBackend({
    spawn: fake.spawn,
    mkdtemp: async () => '/tmp/vicoop-codex-env',
    writeFile: async () => {},
    rm: async () => {},
  });

  const { emit, frames } = collect();
  await backend.handle(
    assignWithOpenAICompat('what is the weather in Seoul?', { tools: SAMPLE_TOOLS }),
    emit,
    NEVER,
  );

  const artifacts = frames.filter(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact',
  );
  assert.equal(artifacts.length, 1);
  const part = artifacts[0].artifact.parts[0];
  assert.equal(part.kind, 'data');
  if (part.kind !== 'data') throw new Error('expected data part');
  assert.deepEqual(part.data, envelope);
  // Tagged so downstream gateways can route on the extension.
  assert.deepEqual(artifacts[0].artifact.extensions, [OPENAI_COMPAT_EXTENSION_URI]);
});

test('extension off: a coincidental {"tool_calls":[...]} agent_message stays a text artifact', async () => {
  // No metadata → no envelope contract is in force, so a model emitting
  // JSON-shaped text by coincidence MUST NOT be routed as a tool call.
  // Guards against false positives polluting natural-language tasks.
  const coincidental = JSON.stringify({ tool_calls: [] });
  const fake = scriptedSpawn([
    [
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: coincidental },
      }),
    ],
  ]);
  const backend = createCodexBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('hi'), emit, NEVER);

  const artifacts = frames.filter(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact',
  );
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].artifact.parts[0].kind, 'text');
  assert.equal(textOf(artifacts[0]), coincidental);
  assert.equal(artifacts[0].artifact.extensions, undefined);
});

test('extension on but the model answered in prose → text artifact, no extension tag', async () => {
  // The extension being active does not mean every turn is a tool turn:
  // tool_choice="auto" lets the model answer naturally. Non-envelope text
  // must still flow through as a text artifact and must NOT carry the
  // extension URI tag, which would mis-claim a data-part contract.
  const fake = scriptedSpawn([
    [
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'No tool needed; the answer is 42.' },
      }),
    ],
  ]);
  const backend = createCodexBackend({
    spawn: fake.spawn,
    mkdtemp: async () => '/tmp/vicoop-codex-prose',
    writeFile: async () => {},
    rm: async () => {},
  });
  const { emit, frames } = collect();
  await backend.handle(
    assignWithOpenAICompat('hi', { tools: SAMPLE_TOOLS, tool_choice: 'auto' }),
    emit,
    NEVER,
  );

  const artifacts = frames.filter(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact',
  );
  assert.equal(artifacts.length, 1);
  assert.equal(textOf(artifacts[0]), 'No tool needed; the answer is 42.');
  assert.equal(artifacts[0].artifact.extensions, undefined);
});

test('tool_choice="none" writes a no-envelope directive to the instructions file', async () => {
  const fake = scriptedSpawn([
    [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })],
  ]);
  const written: Array<{ path: string; data: Buffer }> = [];
  const backend = createCodexBackend({
    spawn: fake.spawn,
    mkdtemp: async () => '/tmp/vicoop-codex-none',
    writeFile: async (filePath, data) => {
      written.push({ path: String(filePath), data: Buffer.from(data as Buffer) });
    },
    rm: async () => {},
  });

  await backend.handle(
    assignWithOpenAICompat('hi', {
      tools: SAMPLE_TOOLS,
      tool_choice: 'none',
    }),
    collect().emit,
    NEVER,
  );

  assert.equal(written.length, 1);
  const body = written[0].data.toString('utf8');
  // The envelope contract block is suppressed under tool_choice="none";
  // an explicit "do not emit" directive replaces it so the gateway's
  // intent (no tool calls this turn) is preserved.
  assert.doesNotMatch(body, /"tool_calls":\[\{"id":"call_<unique>"/);
  assert.match(body, /tool_choice="none"/);
});
