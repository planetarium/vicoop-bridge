import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  buildClaudeChatCompletionEnvelope,
  buildOpenAICompatNativeSystemPrompt,
  DEFAULT_OPENAI_COMPAT_SYSTEM_PROMPT,
  createClaudeBackend,
  normalizeClaudeModelId,
  openaiToolsToCallerToolDefs,
  parseClaudeModelUsageForOpenAICompat,
  probeClaudeModel,
  summarizeToolInput,
  CLAUDE_PROBE_ARGS,
  type ClaudeChildHandle,
  type ClaudeSpawnOptions,
} from './claude.js';
// The pure helpers in `./openai-compat.js` are covered by
// `openai-compat.test.ts`. `claude.test.ts` only exercises the
// claude-specific wiring (spawn argv, native-MCP dispatch, capabilities
// probe) — the imports below cover that surface only.
import { startCallerToolsMcpServer } from './caller-tools-mcp.js';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  TRACEABILITY_EXTENSION_URI,
  type TaskAssignFrame,
  type UpFrame,
} from '@vicoop-bridge/protocol';

const NEVER: AbortSignal = new AbortController().signal;

interface FakeChild extends ClaudeChildHandle {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
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
        env: options.env,
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

function assignWithTraceability(text: string): TaskAssignFrame {
  return {
    ...assign(text),
    requestedExtensions: [TRACEABILITY_EXTENSION_URI],
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
  assert.equal(artifacts[0].append, true);
  assert.equal(artifacts[0].lastChunk, false);

  const complete = frames.at(-1) as Extract<UpFrame, { type: 'task.complete' }>;
  assert.equal(complete.status.state, 'completed');
  assert.equal(textOf(complete), 'second turn');
});

test('streams cumulative Claude partial messages as append deltas on one artifact', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'one two' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'one two three' }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'one two three' }),
    ],
    exitCode: 0,
  });

  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('hello'), emit, NEVER);

  const child = fake.lastChild();
  assert.ok(child?.args.includes('--include-partial-messages'));

  const artifacts = frames.filter(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact',
  );
  assert.equal(artifacts.length, 3);
  assert.deepEqual(artifacts.map(textOf), ['one', ' two', ' three']);
  assert.equal(new Set(artifacts.map((a) => a.artifact.artifactId)).size, 1);
  assert.deepEqual(artifacts.map((a) => a.append), [true, true, true]);
});

test('streams Claude stream_event text deltas as append chunks', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'one' },
        },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: ' two' },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'one two' }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'one two' }),
    ],
    exitCode: 0,
  });

  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('hello'), emit, NEVER);

  const artifacts = frames.filter(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact',
  );
  assert.equal(artifacts.length, 2);
  assert.deepEqual(artifacts.map(textOf), ['one', ' two']);
  assert.equal(new Set(artifacts.map((a) => a.artifact.artifactId)).size, 1);
  assert.deepEqual(artifacts.map((a) => a.append), [true, true]);
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
  assert.equal(fail.error.code, 'auth_required');
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

test('data parts are serialized into a tagged JSON text content block', async () => {
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
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
      messageId: 'm1',
      parts: [
        { kind: 'text', text: 'please review' },
        { kind: 'data', data: { ticket: 42, priority: 'high' } },
      ],
    },
  };
  await backend.handle(task, emit, NEVER);

  const fail = frames.find((f) => f.type === 'task.fail');
  assert.equal(fail, undefined);

  const child = fake.lastChild()!;
  const env = JSON.parse(child.stdinPayload.trim()) as {
    message: { content: Array<{ type: string; text?: string }> };
  };
  assert.equal(env.message.content.length, 2);
  assert.equal(env.message.content[0].type, 'text');
  assert.equal(env.message.content[0].text, 'please review');
  assert.equal(env.message.content[1].type, 'text');
  const second = env.message.content[1].text ?? '';
  assert.match(second, /^<context kind="application\/json">\n/);
  assert.ok(second.includes('"ticket": 42'));
  assert.ok(second.includes('"priority": "high"'));
  assert.ok(second.endsWith('</context>'));
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

test('rejects FilePart with uri-only when URI fetching is disabled', async () => {
  const backend = createClaudeBackend({
    fetchUriPolicy: { enabled: false },
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
  assert.match(fail.error.message, /URI fetching is disabled/);
});

test('rejects FilePart missing both bytes and uri as invalid', async () => {
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
      parts: [{ kind: 'file', file: { mimeType: 'image/png' } }],
    },
  };
  await backend.handle(task, emit, NEVER);

  assert.equal(spawned, 0);
  const fail = frames.find((f): f is Extract<UpFrame, { type: 'task.fail' }> => f.type === 'task.fail');
  assert.ok(fail);
  assert.equal(fail.error.code, 'invalid_file_part');
});

test('stdin envelope: URI FilePart is fetched and mapped like inline image bytes', async () => {
  const png = Buffer.from('png-bytes');
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });
  const backend = createClaudeBackend({
    spawn: fake.spawn,
    fetchUriPolicy: {
      fetchImplForTest: async () =>
        new Response(png, {
          headers: {
            'content-type': 'image/png',
            'content-length': String(png.length),
          },
        }),
      resolveHost: async () => ['93.184.216.34'],
    },
  });
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
  await backend.handle(task, collect().emit, NEVER);

  const child = fake.lastChild()!;
  const env = JSON.parse(child.stdinPayload.trim()) as {
    message: { content: Array<{ type: string; source?: { media_type: string; data: string } }> };
  };
  assert.equal(env.message.content.length, 1);
  assert.equal(env.message.content[0].type, 'image');
  assert.equal(env.message.content[0].source!.media_type, 'image/png');
  assert.equal(env.message.content[0].source!.data, png.toString('base64'));
});

test('rejects URI FilePart when host resolves to a private address', async () => {
  let spawned = 0;
  const backend = createClaudeBackend({
    spawn: () => {
      spawned++;
      throw new Error('should not spawn');
    },
    fetchUriPolicy: {
      fetchImplForTest: async () => new Response(Buffer.from('unused'), { headers: { 'content-type': 'image/png' } }),
      resolveHost: async () => ['10.0.0.1'],
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

  assert.equal(spawned, 0);
  const fail = frames.find((f): f is Extract<UpFrame, { type: 'task.fail' }> => f.type === 'task.fail');
  assert.ok(fail);
  assert.equal(fail.error.code, 'fetch_blocked_host');
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

test('injects --settings <json> when settings option is provided', async () => {
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });

  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    },
  };
  const backend = createClaudeBackend({ spawn: fake.spawn, settings });
  await backend.handle(assign('hi'), collect().emit, NEVER);

  const child = fake.lastChild();
  assert.ok(child);
  const idx = child.args.indexOf('--settings');
  assert.ok(idx !== -1, 'expected --settings flag');
  // The serialized JSON must round-trip exactly (no shell escaping — spawn
  // takes an argv array, claude reads it as a single argument).
  assert.deepEqual(JSON.parse(String(child.args[idx + 1])), settings);
});

test('injects default sandbox-on --settings when settings option is not provided', async () => {
  // Sandbox-on-by-default is the safe baseline: operators get the OS-level
  // sandbox (Seatbelt / bubblewrap) without having to remember to opt in,
  // and failIfUnavailable: true means a host that can't enable it fails
  // loud at startup instead of silently running unsandboxed.
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });

  const backend = createClaudeBackend({ spawn: fake.spawn });
  await backend.handle(assign('hi'), collect().emit, NEVER);

  const child = fake.lastChild();
  assert.ok(child);
  const idx = child.args.indexOf('--settings');
  assert.ok(idx !== -1, 'expected default --settings flag');
  assert.deepEqual(JSON.parse(String(child.args[idx + 1])), {
    sandbox: { enabled: true, failIfUnavailable: true },
  });
});

test('model option folds into --settings as `model`, keeping the default sandbox', async () => {
  // `--claude-model` with no explicit settings must NOT wipe the
  // sandbox-on-by-default guard: the model is merged onto DEFAULT_SETTINGS,
  // not substituted for it.
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });

  const backend = createClaudeBackend({ spawn: fake.spawn, model: 'claude-opus-4-8' });
  await backend.handle(assign('hi'), collect().emit, NEVER);

  const child = fake.lastChild();
  assert.ok(child);
  const idx = child.args.indexOf('--settings');
  assert.ok(idx !== -1, 'expected --settings flag');
  assert.deepEqual(JSON.parse(String(child.args[idx + 1])), {
    sandbox: { enabled: true, failIfUnavailable: true },
    model: 'claude-opus-4-8',
  });
});

test('model option wins over a `model` already present in operator settings', async () => {
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });

  const backend = createClaudeBackend({
    spawn: fake.spawn,
    settings: { sandbox: { enabled: false }, model: 'claude-sonnet-4-6' },
    model: 'claude-opus-4-8',
  });
  await backend.handle(assign('hi'), collect().emit, NEVER);

  const child = fake.lastChild();
  assert.ok(child);
  const idx = child.args.indexOf('--settings');
  assert.ok(idx !== -1, 'expected --settings flag');
  assert.deepEqual(JSON.parse(String(child.args[idx + 1])), {
    sandbox: { enabled: false },
    model: 'claude-opus-4-8',
  });
});

test('createClaudeBackend throws a named error if settings is not JSON-serializable', () => {
  // Circular reference — JSON.stringify throws TypeError. The wrapped Error
  // must name the option so an operator can find the misconfiguration
  // quickly instead of debugging a raw stack trace from inside the backend.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(
    () => createClaudeBackend({ settings: circular }),
    /createClaudeBackend: failed to serialize `settings` option/,
  );

  // BigInt — different throw inside JSON.stringify, same wrapper outside.
  // `settings` is `Record<string, unknown>`, so `1n` slots in as-is.
  assert.throws(
    () => createClaudeBackend({ settings: { token: 1n } }),
    /createClaudeBackend: failed to serialize `settings` option/,
  );

  // `toJSON()` that returns undefined — JSON.stringify returns undefined
  // (no throw), which would otherwise stringify-coerce to "undefined" in
  // argv. The post-stringify type check must catch this.
  const toJsonReturnsUndefined: Record<string, unknown> = {
    toJSON() {
      return undefined;
    },
  };
  assert.throws(
    () => createClaudeBackend({ settings: toJsonReturnsUndefined }),
    /serialized to `undefined`/,
  );
});

test('--settings precedes extraArgs so operator extraArgs can override', async () => {
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });

  const backend = createClaudeBackend({
    spawn: fake.spawn,
    settings: { sandbox: { enabled: true } },
    extraArgs: ['--model', 'sonnet'],
  });
  await backend.handle(assign('hi'), collect().emit, NEVER);

  const child = fake.lastChild();
  assert.ok(child);
  const settingsIdx = child.args.indexOf('--settings');
  const modelIdx = child.args.indexOf('--model');
  assert.ok(settingsIdx !== -1);
  assert.ok(modelIdx !== -1);
  assert.ok(settingsIdx < modelIdx, '--settings must appear before extraArgs');
});

test('injects --append-system-prompt with self-identity mention when identity is provided', async () => {
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });

  const backend = createClaudeBackend({
    spawn: fake.spawn,
    identity: {
      agentId: '6eec0b6e-claude',
      host: 'vicoop-bridge-server.fly.dev',
      httpOrigin: 'https://vicoop-bridge-server.fly.dev',
    },
  });
  await backend.handle(assign('hi'), collect().emit, NEVER);

  const child = fake.lastChild();
  assert.ok(child);
  const idx = child.args.indexOf('--append-system-prompt');
  assert.ok(idx !== -1, 'expected --append-system-prompt in argv');
  const prompt = String(child.args[idx + 1]);
  assert.match(prompt, /@6eec0b6e-claude@vicoop-bridge-server\.fly\.dev/);
  assert.match(prompt, /acct:6eec0b6e-claude@vicoop-bridge-server\.fly\.dev/);
});

test('omits --append-system-prompt when no identity is configured', async () => {
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });

  const backend = createClaudeBackend({ spawn: fake.spawn });
  await backend.handle(assign('hi'), collect().emit, NEVER);

  const child = fake.lastChild();
  assert.ok(child);
  assert.equal(
    child.args.indexOf('--append-system-prompt'),
    -1,
    'no identity → no system prompt args',
  );
});

test('identity args precede extraArgs so operator extraArgs override', async () => {
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });

  const backend = createClaudeBackend({
    spawn: fake.spawn,
    identity: { agentId: 'me', host: 'example.com', httpOrigin: 'https://example.com' },
    extraArgs: ['--append-system-prompt', 'OPERATOR'],
  });
  await backend.handle(assign('hi'), collect().emit, NEVER);

  const child = fake.lastChild();
  assert.ok(child);
  // claude applies multiple --append-system-prompt occurrences in order, so
  // the operator-supplied one must appear LATER than the identity one.
  const occurrences: number[] = [];
  child.args.forEach((a, i) => {
    if (a === '--append-system-prompt') occurrences.push(i);
  });
  assert.equal(occurrences.length, 2);
  assert.ok(occurrences[1] > occurrences[0]);
  assert.equal(child.args[occurrences[1] + 1], 'OPERATOR');
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

test('debug log records claude spawn shape and spawn errors', async () => {
  const oldLevel = process.env.VICOOP_CLIENT_LOG_LEVEL;
  const oldLog = console.log;
  const logs: string[] = [];
  process.env.VICOOP_CLIENT_LOG_LEVEL = 'debug';
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    const backend = createClaudeBackend({
      spawn: () => {
        throw new Error('ENOENT: claude missing');
      },
      settings: { sandbox: { enabled: true } },
      extraArgs: ['--append-system-prompt', 'operator secret-ish prompt'],
    });

    await backend.handle(assign('one'), collect().emit, NEVER);
  } finally {
    console.log = oldLog;
    if (oldLevel === undefined) delete process.env.VICOOP_CLIENT_LOG_LEVEL;
    else process.env.VICOOP_CLIENT_LOG_LEVEL = oldLevel;
  }

  assert.ok(
    logs.some((line) =>
      /claude\.spawn\.start/.test(line) &&
      /command=claude/.test(line) &&
      /argv=.*--settings/.test(line) &&
      line.includes('sandbox') &&
      line.includes('enabled') &&
      line.includes('true') &&
      line.includes('operator secret-ish prompt')
    ),
    `expected raw spawn start debug log, got:\n${logs.join('\n')}`,
  );
  assert.ok(
    logs.some((line) =>
      /claude\.spawn\.error/.test(line) &&
      /error=ENOENT: claude missing/.test(line)
    ),
    `expected spawn error debug log, got:\n${logs.join('\n')}`,
  );
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
  assert.equal(c1.frames.find((f) => f.type === 'task.fail')?.error.code, 'auth_required');

  const t2 = assign('second');
  t2.contextId = ctx;
  await backend.handle(t2, collect().emit, NEVER);
  const child = fakeOk.lastChild()!;
  assert.equal(child.args.indexOf('--resume'), -1, 'must not resume an aborted session');
  assert.ok(child.args.indexOf('--session-id') !== -1, 'must mint a fresh session id');
});

test('non-zero claude exit includes stdout tail when stderr is empty', async () => {
  const fake = scriptedSpawn({
    lines: ['fatal: stream-json setup failed before stderr'],
    exitCode: 1,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();

  await backend.handle(assign('fail with stdout only'), emit, NEVER);

  const terminal = frames.at(-1);
  assert.ok(terminal && terminal.type === 'task.fail');
  if (terminal.type === 'task.fail') {
    assert.equal(terminal.error.code, 'claude_exit_nonzero');
    assert.match(terminal.error.message, /\[stdout: fatal: stream-json setup failed before stderr\]/);
  }
});

test('non-zero claude exit with completed result and no stderr completes', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({
        type: 'result',
        result: '',
        terminal_reason: 'completed',
        is_error: false,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
      }),
    ],
    exitCode: 1,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();

  await backend.handle(assign('completed but nonzero'), emit, NEVER);

  const terminal = frames.at(-1);
  assert.ok(terminal && terminal.type === 'task.complete');
  if (terminal.type === 'task.complete') {
    assert.equal(terminal.status.state, 'completed');
  }
  assert.equal(frames.find((f) => f.type === 'task.fail'), undefined);
});

test('non-zero claude exit with completed error result still fails', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
        },
        error: 'authentication_failed',
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Not logged in · Please run /login',
        terminal_reason: 'completed',
        modelUsage: {},
        permission_denials: [],
      }),
    ],
    exitCode: 1,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();

  await backend.handle(assign('auth expired'), emit, NEVER);

  const terminal = frames.at(-1);
  assert.ok(terminal && terminal.type === 'task.fail');
  if (terminal.type === 'task.fail') {
    assert.equal(terminal.error.code, 'login_required');
    assert.match(terminal.error.message, /Not logged in/);
  }
});

test('rollback does not delete a binding a concurrent task has refreshed', async () => {
  // Task A (first) holds open without finishing. Task B (second) starts
  // on the same contextId, sees the binding A wrote, refreshes lastUsedAt
  // and bumps writeId. Then A fails. The rollback must NOT delete the
  // entry — task C should still resume B's id.
  const ctx = 'ctx-concurrent-rollback';
  let releaseA: () => void = () => {};
  const aReady = new Promise<void>((resolve) => {
    releaseA = resolve;
  });

  const fakeA = makeFakeSpawn((child) => {
    setImmediate(async () => {
      await aReady;
      child.emitStderr('boom\n');
      setImmediate(() => child.finish(1));
    });
  });
  const fakeB = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok-b' })],
    exitCode: 0,
  });
  const fakeC = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok-c' })],
    exitCode: 0,
  });
  let call = 0;
  const wrappedSpawn = (cmd: string, args: readonly string[], opts: ClaudeSpawnOptions) => {
    call++;
    if (call === 1) return fakeA.spawn(cmd, args, opts);
    if (call === 2) return fakeB.spawn(cmd, args, opts);
    return fakeC.spawn(cmd, args, opts);
  };
  const backend = createClaudeBackend({ spawn: wrappedSpawn });

  const tA = assign('a');
  tA.contextId = ctx;
  const cA = collect();
  const pA = backend.handle(tA, cA.emit, NEVER);
  // Yield so the spawn for A lands and the binding is recorded.
  await new Promise((r) => setImmediate(r));

  const tB = assign('b');
  tB.contextId = ctx;
  const cB = collect();
  await backend.handle(tB, cB.emit, NEVER);
  const childB = fakeB.lastChild()!;
  const resumeIdxB = childB.args.indexOf('--resume');
  assert.ok(resumeIdxB !== -1, 'task B must resume task A\'s session');
  const sidB = String(childB.args[resumeIdxB + 1]);

  // Now let task A fail; its rollback must skip the delete because B
  // refreshed the binding (bumped writeId).
  releaseA();
  await pA;
  assert.equal(
    cA.frames.find((f) => f.type === 'task.fail')?.error.code,
    'claude_exit_nonzero',
  );

  // Task C must still resume B's session id, proving the binding survived
  // A's rollback.
  const tC = assign('c');
  tC.contextId = ctx;
  await backend.handle(tC, collect().emit, NEVER);
  const childC = fakeC.lastChild()!;
  const resumeIdxC = childC.args.indexOf('--resume');
  assert.ok(resumeIdxC !== -1, 'task C must resume — binding must not have been wiped');
  assert.equal(String(childC.args[resumeIdxC + 1]), sidB);
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
  const distinctBytes = 'ZGlzdGluY3Q=';
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
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: distinctBytes },
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
    requestedExtensions: [TRACEABILITY_EXTENSION_URI],
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
    1,
    'Traceability-enabled tool_result media should emit only non-echo files',
  );
  const part = fileArtifacts[0].artifact.parts[0];
  assert.equal(part.kind, 'file');
  if (part.kind === 'file') {
    assert.equal(part.file.bytes, distinctBytes);
  }
  assert.deepEqual(fileArtifacts[0].artifact.extensions, [TRACEABILITY_EXTENSION_URI]);
  assert.equal(fileArtifacts[0].artifact.metadata?.traceType, 'tool-result');
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
  await backend.handle(assignWithTraceability('x'), emit, NEVER);

  const fileArtifact = frames.find(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> =>
      f.type === 'task.artifact' && f.artifact.parts[0]?.kind === 'file',
  );
  assert.ok(fileArtifact, 'expected a FilePart artifact for tool_result image');
  assert.deepEqual(fileArtifact.artifact.extensions, [TRACEABILITY_EXTENSION_URI]);
  assert.equal(fileArtifact.artifact.metadata?.traceType, 'tool-result');
  const part = fileArtifact.artifact.parts[0];
  assert.equal(part.kind, 'file');
  if (part.kind === 'file') {
    assert.equal(part.file.mimeType, 'image/png');
    assert.equal(part.file.bytes, 'AAAAB');
  }
});

test('suppresses Claude tool trace artifacts unless Traceability Extension is requested', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check the directory.' },
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'Bash',
              input: { command: 'ls -la /tmp' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              tool_use_id: 'tu_1',
              type: 'tool_result',
              content: [{ type: 'text', text: 'total 0' }],
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'No files.' }],
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'No files.' }),
    ],
    exitCode: 0,
  });

  const backend = createClaudeBackend({ spawn: fake.spawn, heartbeatMs: 0 });
  const { emit, frames } = collect();
  await backend.handle(assign('list /tmp'), emit, NEVER);

  const artifacts = frames.filter(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact',
  );
  assert.deepEqual(
    artifacts.map((a) => a.artifact.name),
    ['claude-message', 'claude-message'],
  );
});

test('emits a trace claude-tool-call artifact per tool_use block when requested', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check the directory.' },
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'Bash',
              input: { command: 'ls -la /tmp' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              tool_use_id: 'tu_1',
              type: 'tool_result',
              content: [{ type: 'text', text: 'total 0' }],
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'No files.' }],
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'No files.' }),
    ],
    exitCode: 0,
  });

  const backend = createClaudeBackend({ spawn: fake.spawn, heartbeatMs: 0 });
  const { emit, frames } = collect();
  await backend.handle(assignWithTraceability('list /tmp'), emit, NEVER);

  const artifacts = frames.filter(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact',
  );
  const names = artifacts.map((a) => a.artifact.name);
  assert.deepEqual(
    names,
    ['claude-message', 'claude-tool-call', 'claude-message'],
    'order: assistant text, then tool_use, then trailing assistant text',
  );

  const callArtifact = artifacts[1];
  assert.equal(callArtifact.lastChunk, true);
  assert.deepEqual(callArtifact.artifact.extensions, [TRACEABILITY_EXTENSION_URI]);
  assert.equal(callArtifact.artifact.metadata?.traceType, 'tool-call');
  assert.equal(callArtifact.artifact.parts.length, 2);
  const textPart = callArtifact.artifact.parts[0];
  assert.equal(textPart.kind, 'text');
  if (textPart.kind === 'text') {
    assert.match(textPart.text, /^Bash: /);
    assert.ok(textPart.text.includes('ls -la /tmp'));
  }
  const dataPart = callArtifact.artifact.parts[1];
  assert.equal(dataPart.kind, 'data');
  if (dataPart.kind === 'data') {
    assert.equal(dataPart.data.toolName, 'Bash');
    assert.equal(dataPart.data.toolUseId, 'tu_1');
  }

  // Existing assistant text artifacts and the terminal frame remain
  // untouched — new frames are additive, not replacements.
  const complete = frames.at(-1) as Extract<UpFrame, { type: 'task.complete' }>;
  assert.equal(complete.type, 'task.complete');
  assert.equal(complete.status.state, 'completed');
});

test('truncates a long tool_use input summary to a bounded length', async () => {
  const longArg = 'x'.repeat(800);
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_long',
              name: 'Bash',
              input: { command: longArg },
            },
          ],
        },
      }),
      JSON.stringify({ type: 'result', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn, heartbeatMs: 0 });
  const { emit, frames } = collect();
  await backend.handle(assignWithTraceability('x'), emit, NEVER);

  const callArtifact = frames.find(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> =>
      f.type === 'task.artifact' && f.artifact.name === 'claude-tool-call',
  );
  assert.ok(callArtifact, 'expected claude-tool-call artifact');
  const textPart = callArtifact.artifact.parts[0];
  if (textPart.kind !== 'text') throw new Error('expected text part');
  assert.ok(textPart.text.length <= 200, `summary length ${textPart.text.length} > 200`);
  assert.ok(textPart.text.startsWith('Bash: '));
  assert.ok(textPart.text.endsWith('…'), 'truncation marker expected at tail');
});

test('subagent tool_use is silent without traceability opt-in', async () => {
  // The subagent lifecycle is execution-trace detail (which tool ran,
  // when it finished) and must ride the traceability extension just
  // like `claude-tool-call` / `claude-tool-result`. A task that did NOT
  // request the extension sees only assistant text, never the bookend.
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_no_trace',
              name: 'Agent',
              input: { description: 'No trace allowed' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_no_trace',
              content: [{ type: 'text', text: 'subagent done' }],
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Final.' }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Final.' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn, heartbeatMs: 0 });
  const { emit, frames } = collect();
  await backend.handle(assign('no trace'), emit, NEVER);

  const artifacts = frames.filter(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact',
  );
  // Only the final assistant-text artifact survives — no
  // claude-subagent-event, no claude-tool-call, no claude-tool-result.
  assert.deepEqual(
    artifacts.map((a) => a.artifact.name),
    ['claude-message'],
  );
  assert.equal(textOf(artifacts[0]), 'Final.');
});

test('subagent tool_use under the legacy "Task" name also fires the trace bookend', async () => {
  // The wire-level name from `claude -p --output-format stream-json` is
  // `Agent` (verified against claude 2.1.148), but the user-facing
  // surface and historical name is `Task`. We accept both so the
  // bookends keep working if Claude Code renames the wire identifier.
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_legacy_name',
              name: 'Task',
              input: { description: 'Legacy name path' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_legacy_name',
              content: [{ type: 'text', text: 'ok' }],
            },
          ],
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn, heartbeatMs: 0 });
  const { emit, frames } = collect();
  await backend.handle(assignWithTraceability('legacy path'), emit, NEVER);

  const events = frames
    .filter((f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact')
    .filter((a) => a.artifact.name === 'claude-subagent-event')
    .map((a) => a.artifact.metadata?.event);
  assert.deepEqual(events, ['subagent-started', 'subagent-completed']);
});

test('subagent tool_use surfaces start/finish trace artifacts when traceability is requested', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_task_1',
              name: 'Agent',
              input: { description: 'Search Bson transaction handlers', prompt: 'Find …' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_task_1',
              content: [{ type: 'text', text: 'subagent done' }],
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the summary.' }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Here is the summary.' }),
    ],
    exitCode: 0,
  });

  const backend = createClaudeBackend({ spawn: fake.spawn, heartbeatMs: 0 });
  const { emit, frames } = collect();
  await backend.handle(assignWithTraceability('look into Bson'), emit, NEVER);

  const artifacts = frames.filter(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact',
  );
  // Sequence with trace ON: subagent-started, the raw tool-call,
  // subagent-completed, then the final assistant text. Text-only
  // tool_result content does not produce a claude-tool-result.
  assert.deepEqual(
    artifacts.map((a) => a.artifact.name),
    ['claude-subagent-event', 'claude-tool-call', 'claude-subagent-event', 'claude-message'],
  );
  const started = artifacts[0];
  assert.equal(textOf(started), 'Task started: Search Bson transaction handlers');
  assert.equal(started.artifact.metadata?.event, 'subagent-started');
  assert.equal(started.artifact.metadata?.traceType, 'subagent-event');
  assert.equal(started.artifact.metadata?.toolUseId, 'tu_task_1');
  assert.deepEqual(started.artifact.extensions, [TRACEABILITY_EXTENSION_URI]);
  const dataPart = started.artifact.parts[1];
  assert.equal(dataPart.kind, 'data');
  if (dataPart.kind === 'data') {
    assert.equal(dataPart.data.event, 'subagent-started');
    assert.equal(dataPart.data.toolUseId, 'tu_task_1');
    assert.equal(dataPart.data.description, 'Search Bson transaction handlers');
  }
  const completed = artifacts[2];
  assert.equal(textOf(completed), 'Task completed: Search Bson transaction handlers');
  assert.equal(completed.artifact.metadata?.event, 'subagent-completed');
  assert.equal(completed.artifact.metadata?.toolUseId, 'tu_task_1');
  assert.equal(textOf(artifacts[3]), 'Here is the summary.');
});

test('subagent tool_result with is_error=true emits a "Task failed" trace bookend', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_task_err',
              name: 'Agent',
              input: { description: 'Audit migrations', prompt: 'Check …' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_task_err',
              is_error: true,
              content: [{ type: 'text', text: 'subagent error' }],
            },
          ],
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'gave up' }),
    ],
    exitCode: 0,
  });

  const backend = createClaudeBackend({ spawn: fake.spawn, heartbeatMs: 0 });
  const { emit, frames } = collect();
  await backend.handle(assignWithTraceability('try the audit'), emit, NEVER);

  const failed = frames
    .filter((f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact')
    .find((a) => a.artifact.metadata?.event === 'subagent-failed');
  assert.ok(failed, 'expected a subagent-failed trace artifact');
  assert.equal(failed.artifact.name, 'claude-subagent-event');
  assert.equal(textOf(failed), 'Task failed: Audit migrations');
});

test('subagent description falls back to bare "Task" when input.description is missing', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_task_nodesc',
              name: 'Agent',
              input: { prompt: 'Do something' },
            },
          ],
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });

  const backend = createClaudeBackend({ spawn: fake.spawn, heartbeatMs: 0 });
  const { emit, frames } = collect();
  await backend.handle(assignWithTraceability('go'), emit, NEVER);

  const started = frames
    .filter((f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact')
    .find((a) => a.artifact.metadata?.event === 'subagent-started');
  assert.ok(started, 'expected a subagent-started trace artifact even without description');
  assert.equal(textOf(started), 'Task started: Task');
});

test('heartbeat: emits task.status after heartbeatMs of silence and stops at terminal time', async () => {
  // Initialize as a no-op so the type stays `() => void` instead of
  // `(() => void) | null`. The closure-mutation path through setIntervalFn
  // confuses TS narrowing — easier to start callable.
  let scheduledFn: () => void = () => {};
  let scheduled = false;
  let cleared = false;
  let nowMs = 1_000_000;

  // Hold the child open so we can drive heartbeat ticks before the run
  // terminates and clears the interval.
  let releaseFinish: () => void = () => {};
  const finishReady = new Promise<void>((r) => {
    releaseFinish = r;
  });
  const fake = makeFakeSpawn((child) => {
    setImmediate(async () => {
      await finishReady;
      child.emitStdout(JSON.stringify({ type: 'result', result: 'ok' }) + '\n');
      setImmediate(() => child.finish(0));
    });
  });

  const backend = createClaudeBackend({
    spawn: fake.spawn,
    heartbeatMs: 100,
    now: () => nowMs,
    setIntervalFn: (fn) => {
      scheduledFn = fn;
      scheduled = true;
      return { tag: 'fake-interval' };
    },
    clearIntervalFn: () => {
      cleared = true;
    },
  });
  const { emit, frames } = collect();

  const runP = backend.handle(assign('x'), emit, NEVER);
  // Yield enough microtasks for spawn → register-listeners → schedule
  // heartbeat to run before we drive ticks.
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.ok(scheduled, 'heartbeat must register a setInterval handler');

  const countStatus = () => frames.filter((f) => f.type === 'task.status').length;
  assert.equal(countStatus(), 1, 'only the initial task.status: working has been emitted');

  // Tick with no elapsed time → silence < heartbeat → skip.
  scheduledFn();
  assert.equal(countStatus(), 1);

  // Advance past the heartbeat threshold → tick must emit one status.
  nowMs += 250;
  scheduledFn();
  assert.equal(countStatus(), 2);

  // Subsequent tick at the same instant must NOT double-fire — the prior
  // emit refreshed lastEmitAt through the wrapped emitter.
  scheduledFn();
  assert.equal(countStatus(), 2);

  // Real traffic also resets the silence window. Let the child finish.
  releaseFinish();
  await runP;

  assert.ok(cleared, 'heartbeat handle must be cleared at terminal time');
  // After terminal frame, no more status frames may be added even if a
  // stale tick fires (the `settled` guard inside the closure protects
  // against this — exercise it explicitly).
  scheduledFn();
  const lastStatusAfterTerminal = countStatus();
  assert.equal(
    lastStatusAfterTerminal,
    2,
    'no heartbeat allowed after terminal frame',
  );
});

test('heartbeat: suppressed after signal.abort so canceled tasks do not look like they are still working', async () => {
  let scheduledFn: () => void = () => {};
  let nowMs = 1_000_000;
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      // Hold the child open. Termination is driven by abort → kill().
      void child;
    });
  });
  const backend = createClaudeBackend({
    spawn: fake.spawn,
    heartbeatMs: 100,
    now: () => nowMs,
    setIntervalFn: (fn) => {
      scheduledFn = fn;
      return { tag: 'fake-interval' };
    },
    clearIntervalFn: () => {},
  });
  const controller = new AbortController();
  const { emit, frames } = collect();
  const runP = backend.handle(assign('x'), emit, controller.signal);
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

  // Sanity: the heartbeat fires while the task is still working.
  nowMs += 250;
  scheduledFn();
  const before = frames.filter((f) => f.type === 'task.status').length;
  assert.ok(before >= 2, 'heartbeat must emit at least one extra task.status while working');

  // Abort. Subsequent heartbeat ticks must NOT add more `state: working`
  // status frames — the run is on its way to a `canceled` terminal frame.
  controller.abort();
  nowMs += 250;
  scheduledFn();
  nowMs += 250;
  scheduledFn();

  await runP;

  const workingStatusCount = frames.filter(
    (f) =>
      f.type === 'task.status' &&
      (f as Extract<UpFrame, { type: 'task.status' }>).status.state === 'working',
  ).length;
  assert.equal(
    workingStatusCount,
    before,
    'no extra working-state heartbeats may land between abort and terminal frame',
  );
  const last = frames.at(-1) as Extract<UpFrame, { type: 'task.complete' }>;
  assert.equal(last.type, 'task.complete');
  assert.equal(last.status.state, 'canceled');
});

test('summarizeToolInput bails early on a top-level object with many keys (deterministic visit count)', async () => {
  // Deterministic regression guard for the bounded-walk behavior.
  // Each key is an instrumented enumerable getter that records when
  // its value is read. With ~80-char string values, 3 keys' worth of
  // serialization already pushes the accumulator past `budget`
  // (200 + 16 = 216 chars), so the walker MUST bail before reading
  // the 4th value. A regression that materializes the full key list
  // (e.g. reverting to `Object.keys`) or that fails to early-break
  // would walk into the tripwire keys and blow the assertion.
  //
  // Going through the backend handle() path would force the test
  // itself to JSON.stringify the input as part of the stream-json
  // line, triggering every getter and ruining the count — so we
  // call summarizeToolInput directly. The production wiring is
  // already exercised by other tests in this file.
  const probed: string[] = [];
  const inp: Record<string, unknown> = {};
  const layout: Array<[string, string]> = [
    ['a', 'x'.repeat(80)],
    ['b', 'y'.repeat(80)],
    ['c', 'z'.repeat(80)],
    // Tripwires: walker must NOT reach these. Their getters push
    // onto `probed` just like the real keys, so a regression makes
    // them visible.
    ['tripwire_1', 'should-not-be-read'],
    ['tripwire_2', 'should-not-be-read'],
    ['tripwire_3', 'should-not-be-read'],
  ];
  for (const [k, v] of layout) {
    Object.defineProperty(inp, k, {
      enumerable: true,
      configurable: true,
      get() {
        probed.push(k);
        return v;
      },
    });
  }

  const summary = summarizeToolInput(inp, 200);

  // Deterministic guarantee: only the first 3 keys' values were ever
  // read. The walker hits the budget check at the top of iteration 4
  // and bails before touching the tripwire getters. The summary's
  // own length is bounded by O(visited × clipPerString) — not
  // O(total keys × clipPerString) — so it's strictly smaller than a
  // full JSON.stringify would produce, but we don't assert an exact
  // ceiling because one iteration can overshoot the soft budget by
  // up to one clipped key + clipped value.
  assert.deepEqual(
    probed,
    ['a', 'b', 'c'],
    `walker should bail after 3 keys; visited ${probed.join(',')}`,
  );
  assert.ok(!summary.includes('tripwire'), 'tripwire keys must not appear in summary');
});

test('summarizeToolInput clips both keys and values so a giant key cannot blow the budget', async () => {
  // A 50k-char top-level key alone would, before key-clipping, drive
  // a 50k-char JSON.stringify allocation just to land that one
  // property — defeating the bounded-cost guarantee on the *first*
  // iteration. With key clipping in place the produced summary is
  // bounded by the same per-string cap that values use.
  const giantKey = 'K'.repeat(50_000);
  const inp = { [giantKey]: 'tiny' };
  const summary = summarizeToolInput(inp, 200);
  assert.ok(summary.length <= 216, `summary length ${summary.length} exceeds budget`);
  // The clipped key prefix is present, but not the full 50k-char form.
  assert.ok(summary.includes('KKKK'));
  assert.ok(!summary.includes('K'.repeat(1000)), 'giant key must not appear verbatim');
});

test('heartbeat: heartbeatMs:0 disables the interval entirely', async () => {
  let registered = false;
  const fake = scriptedSpawn({
    lines: [JSON.stringify({ type: 'result', result: 'ok' })],
    exitCode: 0,
  });
  const backend = createClaudeBackend({
    spawn: fake.spawn,
    heartbeatMs: 0,
    setIntervalFn: () => {
      registered = true;
      return null;
    },
    clearIntervalFn: () => {},
  });
  await backend.handle(assign('x'), collect().emit, NEVER);
  assert.equal(registered, false, 'heartbeatMs:0 must skip setInterval registration');
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
  assert.equal(cfg.mcpServers['_vb-send-file'].type, 'http');
  assert.equal(cfg.mcpServers['_vb-send-file'].url, server.url);

  // argv must also pre-approve the send_file MCP server's tools so the
  // model's `send_file` invocation survives a default permission policy
  // (#235). Without --allowedTools, claude's `defaultMode: "default"`
  // would auto-deny in -p mode since there's no TTY to answer the prompt.
  const allowedIdx = child.args.indexOf('--allowedTools');
  assert.notEqual(allowedIdx, -1, '--allowedTools required when an MCP server is registered (#235)');
  assert.equal(child.args[allowedIdx + 1], 'mcp___vb-send-file');

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

// ---------------------------------------------------------------------------
// openai-compat extension
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

// Shape decomposed test inputs into a `chat_completions_request` envelope
// so the same fixture style the legacy tests used (a flat `{ system, tools,
// tool_choice, chat_history, model }` map) continues to work after the
// envelope-direct migration (#302). The helper folds `system` into a
// leading system message, `chat_history` into the middle, and appends a
// trailing user message matching the A2A `parts` text so backends that
// excise the trailing user from the history projection still receive the
// caller's request through the regular A2A parts path.
function assignWithOpenAICompat(
  text: string,
  payload: {
    system?: string;
    tools?: unknown;
    tool_choice?: unknown;
    chat_history?: readonly unknown[];
    model?: string;
    // Escape hatch for tests that already supply a full envelope and want
    // to override the convenience-mapping above.
    chat_completions_request?: Record<string, unknown>;
  },
): TaskAssignFrame {
  const messages: Array<Record<string, unknown>> = [];
  if (typeof payload.system === 'string' && payload.system.length > 0) {
    messages.push({ role: 'system', content: payload.system });
  }
  if (Array.isArray(payload.chat_history)) {
    for (const entry of payload.chat_history) {
      messages.push(entry as Record<string, unknown>);
    }
  }
  // Trailing user — split into A2A parts for non-extension-aware consumers
  // per the spec; the backend's history projection drops this entry.
  messages.push({ role: 'user', content: text });
  const envelope: Record<string, unknown> = payload.chat_completions_request ?? {
    messages,
    ...(payload.model !== undefined ? { model: payload.model } : {}),
    ...(payload.tools !== undefined ? { tools: payload.tools } : {}),
    ...(payload.tool_choice !== undefined ? { tool_choice: payload.tool_choice } : {}),
  };
  return {
    ...assign(text),
    message: {
      ...assign(text).message,
      metadata: { [OPENAI_COMPAT_EXTENSION_URI]: { chat_completions_request: envelope } },
    },
  };
}

test('envelope.model is forwarded as --model on the claude spawn (#302)', async () => {
  // Per #302, the gateway-resolved model id (planetarium/oai2a2a#80
  // ResolvedAgent.modelOverride) reaches claude as `--model <id>` so
  // claude dispatches to the caller's selection instead of its own
  // default.
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit } = collect();
  await backend.handle(
    assignWithOpenAICompat('hi', { model: 'claude-opus-4-7' }),
    emit,
    NEVER,
  );
  const args = fake.lastChild()?.args ?? [];
  const modelIdx = args.indexOf('--model');
  assert.notEqual(modelIdx, -1, '--model present');
  assert.equal(args[modelIdx + 1], 'claude-opus-4-7');
});

test('envelope without model omits --model from claude spawn (#302)', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit } = collect();
  // No `model` in payload → no --model on argv.
  await backend.handle(assignWithOpenAICompat('hi', {}), emit, NEVER);
  const args = fake.lastChild()?.args ?? [];
  assert.equal(args.indexOf('--model'), -1);
});

test('openai-compat spawn trims cold-start context (--disable-slash-commands)', async () => {
  // Every openai-compat task spawns a fresh session, so the skills catalogue is
  // re-paid on each request for no benefit (the caller drives tool use). The
  // flag is auth-neutral (unlike `--bare`) and applies whenever the envelope is
  // present — tools or not. `--exclude-dynamic-system-prompt-sections` is NOT
  // passed: replacing the default prompt via `--system-prompt` makes it a no-op.
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit } = collect();
  await backend.handle(assignWithOpenAICompat('hi', {}), emit, NEVER);
  const args = fake.lastChild()?.args ?? [];
  assert.ok(
    args.includes('--disable-slash-commands'),
    'expected --disable-slash-commands on the openai-compat spawn',
  );
  assert.equal(
    args.includes('--exclude-dynamic-system-prompt-sections'),
    false,
    'no --exclude-dynamic-system-prompt-sections (redundant once --system-prompt replaces the default)',
  );
});

test('non-openai-compat spawn keeps skills intact (no lean-context flags)', async () => {
  // The trims are scoped to the stateless openai-compat path; a plain A2A
  // task keeps claude's full context (skills, memory, env) intact.
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit } = collect();
  await backend.handle(assign('hi'), emit, NEVER);
  const args = fake.lastChild()?.args ?? [];
  assert.equal(args.includes('--disable-slash-commands'), false);
});

test('openai-compat task spawns in the isolation cwd, not the operator cwd', async () => {
  // The operator cwd carries CLAUDE.md / project settings / hooks that are
  // off-target for a stateless chat/completions proxy turn; openai-compat
  // spawns are redirected to an empty isolation dir instead.
  const isolation = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-oai-cwd-'));
  try {
    const fake = scriptedSpawn({
      lines: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
        JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
      ],
      exitCode: 0,
    });
    const backend = createClaudeBackend({
      spawn: fake.spawn,
      cwd: '/operator/project',
      openaiCompatCwd: isolation,
    });
    const { emit } = collect();
    await backend.handle(assignWithOpenAICompat('hi', {}), emit, NEVER);
    assert.equal(fake.lastChild()?.cwd, isolation);
  } finally {
    await fs.rm(isolation, { recursive: true, force: true });
  }
});

test('non-openai-compat task keeps the operator cwd', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({
    spawn: fake.spawn,
    cwd: '/operator/project',
    openaiCompatCwd: '/should/not/be/used',
  });
  const { emit } = collect();
  await backend.handle(assign('hi'), emit, NEVER);
  assert.equal(fake.lastChild()?.cwd, '/operator/project');
});

test('openai-compat spawn opts into the 1-hour prompt cache (ENABLE_PROMPT_CACHING_1H)', async () => {
  // Stateless openai-compat turns can pause minutes between turns; the 1h cache
  // keeps the byte-stable system+tools prefix warm past the 5-min default.
  // Claude Code reads this only from the env, so we set it on the child.
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit } = collect();
  await backend.handle(assignWithOpenAICompat('hi', {}), emit, NEVER);
  assert.equal(fake.lastChild()?.env?.ENABLE_PROMPT_CACHING_1H, '1');
});

test('non-openai-compat spawn does not set the 1-hour cache env', async () => {
  // The 1h opt-in is scoped to openai-compat; plain A2A tasks keep the default
  // (a 1h cache write costs 2x, only worth it for the stateless proxy pattern).
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit } = collect();
  await backend.handle(assign('hi'), emit, NEVER);
  // No env override at all on the plain path (child inherits parent env only).
  assert.equal(fake.lastChild()?.env, undefined);
});

test('envelope.model is dropped when claude probed model differs (#302)', async () => {
  // Regression guard for the gateway sending an unresolved routing key
  // (e.g. `a2a/<card-url>`) as `envelope.model`. Without the gate, the
  // bridge would pass the garbage to claude via `--model <…>` and the
  // run would fail at the Anthropic API. With the gate, the override is
  // dropped and claude falls back to its own default.
  const fake = scriptedSpawn({
    lines: [
      // probe + handle share the same scripted stream; system/init carries
      // the advertised model id so resolveCapabilities's probe captures it
      // into the backend's cache for the handle that follows.
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sid',
        model: 'claude-opus-4-7',
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  // Daemon-mode contract: resolveCapabilities runs once at startup so the
  // backend caches the probed model id before any task lands. Reproduce
  // that ordering here.
  await backend.resolveCapabilities?.();
  const { emit } = collect();
  await backend.handle(
    assignWithOpenAICompat('hi', {
      model: 'a2a/https://example.com/agents/x/.well-known/agent-card.json',
    }),
    emit,
    NEVER,
  );
  const args = fake.lastChild()?.args ?? [];
  // No --model override on argv — claude uses its own default.
  assert.equal(args.indexOf('--model'), -1);
});

test('envelope.model is forwarded when it matches claude probed model (#302)', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sid',
        model: 'claude-opus-4-7',
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  await backend.resolveCapabilities?.();
  const { emit } = collect();
  await backend.handle(
    assignWithOpenAICompat('hi', { model: 'claude-opus-4-7' }),
    emit,
    NEVER,
  );
  const args = fake.lastChild()?.args ?? [];
  const modelIdx = args.indexOf('--model');
  assert.notEqual(modelIdx, -1, '--model present when envelope.model matches the probe');
  assert.equal(args[modelIdx + 1], 'claude-opus-4-7');
});

test('a --claude-model pin makes resolveCapabilities advertise the pin without probing', async () => {
  // The pin IS the advertised model, so resolveCapabilities must not spawn
  // the probe (it can't see our --settings) — it just reports the pin.
  let spawned = 0;
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sid',
        // Probe would report claude's own default if it ran — assert it does
        // not by watching the spawn count and the advertised id.
        model: 'claude-sonnet-4-6',
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const countingSpawn: typeof fake.spawn = (cmd, a, o) => {
    spawned += 1;
    return fake.spawn(cmd, a, o);
  };
  const backend = createClaudeBackend({ spawn: countingSpawn, model: 'claude-opus-4-8' });
  const caps = await backend.resolveCapabilities!();
  assert.deepEqual(caps, {
    openaiCompatModels: [{ id: 'claude-opus-4-8', default: true }],
  });
  assert.equal(spawned, 0, 'pinned model must not trigger a probe spawn');
});

test('envelope.model matching the --claude-model pin rides through as --model', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn, model: 'claude-opus-4-8' });
  await backend.resolveCapabilities?.();
  const { emit } = collect();
  await backend.handle(
    assignWithOpenAICompat('hi', { model: 'claude-opus-4-8' }),
    emit,
    NEVER,
  );
  const args = fake.lastChild()?.args ?? [];
  const modelIdx = args.indexOf('--model');
  assert.notEqual(modelIdx, -1, '--model present');
  assert.equal(args[modelIdx + 1], 'claude-opus-4-8');
});

test('envelope.model differing from the --claude-model pin falls back to the pin, not the envelope', async () => {
  // Regression guard for the pin-defeat bug: the probe runs WITHOUT our
  // --settings, so before seeding the cache with the pin an envelope echoing
  // the unpinned default would have overridden the pin via --model. With the
  // seed, a non-matching envelope.model is dropped and the spawn falls back
  // to settings.model (= the pin), so claude never runs a different model
  // than the operator pinned.
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn, model: 'claude-opus-4-8' });
  await backend.resolveCapabilities?.();
  const { emit } = collect();
  await backend.handle(
    assignWithOpenAICompat('hi', { model: 'claude-sonnet-4-6' }),
    emit,
    NEVER,
  );
  const args = fake.lastChild()?.args ?? [];
  // No --model override (sonnet dropped); the pin survives via --settings.
  assert.equal(args.indexOf('--model'), -1, 'mismatched envelope.model must be dropped');
  const settingsIdx = args.indexOf('--settings');
  assert.notEqual(settingsIdx, -1);
  assert.equal(JSON.parse(String(args[settingsIdx + 1])).model, 'claude-opus-4-8');
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-model declarations (`models` option / --claude-supported-models). Claude Code
// has no headless model listing, so extra models are operator-declared:
// advertised after the default and accepted by the envelope.model gate.
// ─────────────────────────────────────────────────────────────────────────────

test('declared models are advertised after the probed default', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sid',
        model: 'claude-opus-4-8',
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({
    spawn: fake.spawn,
    supportedModels: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
  });
  const caps = await backend.resolveCapabilities!();
  assert.deepEqual(caps, {
    openaiCompatModels: [
      { id: 'claude-opus-4-8', default: true },
      { id: 'claude-sonnet-4-6' },
      { id: 'claude-haiku-4-5' },
    ],
  });
});

test('declared models are advertised after a --claude-model pin without probing', async () => {
  let spawned = 0;
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const countingSpawn: typeof fake.spawn = (cmd, a, o) => {
    spawned += 1;
    return fake.spawn(cmd, a, o);
  };
  const backend = createClaudeBackend({
    spawn: countingSpawn,
    model: 'claude-opus-4-8',
    supportedModels: ['claude-sonnet-4-6'],
  });
  const caps = await backend.resolveCapabilities!();
  assert.deepEqual(caps, {
    openaiCompatModels: [
      { id: 'claude-opus-4-8', default: true },
      { id: 'claude-sonnet-4-6' },
    ],
  });
  assert.equal(spawned, 0, 'pinned model must not trigger a probe spawn');
});

test('declared models deduplicate against the pin and the probed default on the normalized form', async () => {
  // Pin path: a declared entry that normalizes to the pin must not produce
  // a second advertise entry (the operator wrote the same canonical model
  // twice, once with a tier suffix).
  const fakePin = scriptedSpawn({ lines: [], exitCode: 0 });
  const pinned = createClaudeBackend({
    spawn: fakePin.spawn,
    model: 'claude-opus-4-8',
    supportedModels: ['claude-opus-4-8[1m]', 'claude-sonnet-4-6', 'claude-sonnet-4-6'],
  });
  assert.deepEqual(await pinned.resolveCapabilities!(), {
    openaiCompatModels: [
      { id: 'claude-opus-4-8', default: true },
      { id: 'claude-sonnet-4-6' },
    ],
  });

  // Probe path: the probed default may collide with a declared entry too —
  // construction-time dedupe can't see it, so resolveCapabilities drops it.
  const fakeProbe = scriptedSpawn({
    lines: [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sid',
        model: 'claude-opus-4-8',
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const probed = createClaudeBackend({
    spawn: fakeProbe.spawn,
    supportedModels: ['claude-opus-4-8', 'claude-haiku-4-5'],
  });
  assert.deepEqual(await probed.resolveCapabilities!(), {
    openaiCompatModels: [
      { id: 'claude-opus-4-8', default: true },
      { id: 'claude-haiku-4-5' },
    ],
  });
});

test('envelope.model matching a declared model rides through as --model', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({
    spawn: fake.spawn,
    model: 'claude-opus-4-8',
    supportedModels: ['claude-sonnet-4-6'],
  });
  await backend.resolveCapabilities?.();
  const { emit } = collect();
  await backend.handle(
    assignWithOpenAICompat('hi', { model: 'claude-sonnet-4-6' }),
    emit,
    NEVER,
  );
  const args = fake.lastChild()?.args ?? [];
  const modelIdx = args.indexOf('--model');
  assert.notEqual(modelIdx, -1, '--model present for a declared model');
  assert.equal(args[modelIdx + 1], 'claude-sonnet-4-6');
});

test('envelope.model outside the declared set is still dropped', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({
    spawn: fake.spawn,
    model: 'claude-opus-4-8',
    supportedModels: ['claude-sonnet-4-6'],
  });
  await backend.resolveCapabilities?.();
  const { emit } = collect();
  await backend.handle(
    assignWithOpenAICompat('hi', {
      model: 'a2a/https://example.com/agents/x/.well-known/agent-card.json',
    }),
    emit,
    NEVER,
  );
  const args = fake.lastChild()?.args ?? [];
  assert.equal(args.indexOf('--model'), -1, 'undeclared envelope.model must be dropped');
});

test('envelope.model gate matches on the normalized form but forwards the raw value', async () => {
  // A caller selecting the 1M tier of an advertised model
  // (`claude-opus-4-8[1m]` vs advertised `claude-opus-4-8`) must pass the
  // gate AND keep the tier suffix on the spawned argv — the suffix is how
  // Claude Code picks the context tier.
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn, model: 'claude-opus-4-8' });
  await backend.resolveCapabilities?.();
  const { emit } = collect();
  await backend.handle(
    assignWithOpenAICompat('hi', { model: 'claude-opus-4-8[1m]' }),
    emit,
    NEVER,
  );
  const args = fake.lastChild()?.args ?? [];
  const modelIdx = args.indexOf('--model');
  assert.notEqual(modelIdx, -1, 'tier-suffixed request for an advertised model must pass');
  assert.equal(args[modelIdx + 1], 'claude-opus-4-8[1m]', 'raw tiered id rides to the spawn');
});

test('probeTimeoutMs:0 with declared models advertises them without a default entry', async () => {
  let spawned = 0;
  const fake = scriptedSpawn({ lines: [], exitCode: 0 });
  const countingSpawn: typeof fake.spawn = (cmd, a, o) => {
    spawned += 1;
    return fake.spawn(cmd, a, o);
  };
  const backend = createClaudeBackend({
    spawn: countingSpawn,
    probeTimeoutMs: 0,
    supportedModels: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
  });
  const caps = await backend.resolveCapabilities!();
  assert.deepEqual(caps, {
    openaiCompatModels: [{ id: 'claude-sonnet-4-6' }, { id: 'claude-haiku-4-5' }],
  });
  assert.equal(spawned, 0, 'probeTimeoutMs:0 must skip the probe spawn');
});

test('spawn argv carries --system-prompt with the native directive when metadata is present', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({
    spawn: fake.spawn,
    // Skip the real HTTP listener — the assertion targets argv composition,
    // not the running MCP server.
    onCallerToolsMcpReady: () => {},
  });
  const { emit } = collect();
  await backend.handle(
    assignWithOpenAICompat('what is the weather?', {
      system: 'You are concise.',
      tools: SAMPLE_TOOLS,
      tool_choice: 'auto',
    }),
    emit,
    NEVER,
  );

  const args = fake.lastChild()?.args ?? [];
  // The openai-compat path REPLACES claude's default prompt via --system-prompt
  // (no identity configured here, so this is the only --system-prompt). The
  // value carries the user's `system` text plus the native-dispatch directive
  // — NOT the old envelope JSON contract, which #213 removed.
  const idx = args.findIndex(
    (a, i) =>
      args[i - 1] === '--system-prompt' &&
      typeof a === 'string' &&
      a.includes('You are concise.'),
  );
  assert.ok(idx >= 0, 'expected --system-prompt carrying the openai-compat system text');
  // The slim native prompt teaches the model to use the native tool surface
  // and how to read the history block — nothing more.
  assert.match(args[idx] as string, /native tool list/);
  assert.match(args[idx] as string, /<chat_history>/);
  // Envelope contract phrase MUST NOT appear under #213.
  assert.equal(
    (args[idx] as string).includes('"tool_calls":[{"id":"call_<unique>"'),
    false,
  );
  // The "stop after invoking" directive was dropped because `--max-turns 1`
  // enforces single-turn semantics mechanically.
  assert.equal(
    (args[idx] as string).toLowerCase().includes('after invoking'),
    false,
    'stop-after-invoke directive should be absent (--max-turns 1 enforces)',
  );
});

test('absent metadata → no openai-compat system prompt is injected', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit } = collect();
  await backend.handle(assign('hello'), emit, NEVER);

  const args = fake.lastChild()?.args ?? [];
  // No tool-envelope contract anywhere in argv when the caller didn't ask
  // for the extension.
  const hasEnvelope = args.some(
    (a) => typeof a === 'string' && a.includes('"tool_calls":[{"id":"call_<unique>"'),
  );
  assert.equal(hasEnvelope, false);
});

test('caller tools active → spawn argv carries `--tools ""` to disable claude built-ins', async () => {
  // Without this, claude silently uses its own Read / Glob / Bash to satisfy
  // requests that should round-trip through the caller's tool dispatch — see
  // #178. Mirrors the codex backend's `--disable shell_tool` /
  // `--disable unified_exec` gating on the same `callerToolDispatchActive`.
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit } = collect();
  await backend.handle(
    assignWithOpenAICompat('hi', { tools: SAMPLE_TOOLS, tool_choice: 'auto' }),
    emit,
    NEVER,
  );

  const args = fake.lastChild()?.args ?? [];
  const idx = args.indexOf('--tools');
  assert.ok(idx >= 0, 'expected --tools in argv when caller tools are active');
  // The empty-string value is the documented switch for blanket-disabling
  // built-ins; any other value would re-enable the offending tools.
  assert.equal(args[idx + 1], '');
});

test('history-only payload (no tools) leaves claude built-in tools enabled', async () => {
  // Counterpart to the active-tools case: when the caller's payload carries
  // only `chat_history` (replay context for a follow-up turn) and no
  // `tools` array, there is no caller-side dispatch contract to protect this
  // turn — `--tools ""` MUST NOT appear or claude would lose its built-ins
  // for a turn the caller never intended to constrain.
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit } = collect();
  await backend.handle(
    assignWithOpenAICompat('continue', { chat_history: SAMPLE_HISTORY }),
    emit,
    NEVER,
  );

  const args = fake.lastChild()?.args ?? [];
  assert.equal(args.includes('--tools'), false);
});

test('tool_choice="none" suppresses `--tools ""` even when `tools` are present', async () => {
  // `tool_choice="none"` is the caller explicitly opting out of tool
  // dispatch for this turn even though it sent a catalogue (e.g. for future
  // turns of the same conversation). The envelope contract block in the
  // system prompt is suppressed under the same gate, so handicapping
  // claude's built-ins here would be incoherent.
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit } = collect();
  await backend.handle(
    assignWithOpenAICompat('hi', { tools: SAMPLE_TOOLS, tool_choice: 'none' }),
    emit,
    NEVER,
  );

  const args = fake.lastChild()?.args ?? [];
  assert.equal(args.includes('--tools'), false);
});

test('non-envelope assistant text still streams as a text artifact under the extension', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'No tool needed; the answer is 42.' }],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'No tool needed; the answer is 42.',
      }),
    ],
    exitCode: 0,
  });

  const backend = createClaudeBackend({ spawn: fake.spawn });
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
  // Plain-text path leaves the artifact untagged — no extension URI claim
  // that doesn't apply to this turn.
  assert.equal(artifacts[0].artifact.extensions, undefined);
});

test('extension off: a coincidental {"tool_calls":[...]} text stays a text artifact', async () => {
  // Without the extension we don't claim any envelope contract is in
  // force, so this defends against false-positive routing if the model
  // happens to emit a JSON-shaped reply for unrelated reasons.
  const envelope = JSON.stringify({ tool_calls: [] });
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: envelope }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: envelope }),
    ],
    exitCode: 0,
  });

  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('hi'), emit, NEVER);

  const artifacts = frames.filter(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact',
  );
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].artifact.parts[0].kind, 'text');
});

// ---------------------------------------------------------------------------
// openai-compat extension: multi-turn (chat_history)
// ---------------------------------------------------------------------------

const SAMPLE_HISTORY: ReadonlyArray<Record<string, unknown>> = [
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call_abc', function: { name: 'get_weather', arguments: { city: 'Seoul' } } },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'call_abc',
    name: 'get_weather',
    content: '{"temp":15,"cond":"sunny"}',
  },
];


test('multi-turn: chat_history block is prepended to the final user content (single envelope)', async () => {
  // Claude's stream-json input treats every `{type:"user"}` envelope as a
  // fresh LLM call and ignores `{type:"assistant"}` envelopes — so we
  // fold the entire transcript into a single user envelope under a
  // `<chat_history>` JSON block prepended to the live prompt.
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit } = collect();
  await backend.handle(
    assignWithOpenAICompat('continue, please', {
      tools: SAMPLE_TOOLS,
      chat_history: SAMPLE_HISTORY,
    }),
    emit,
    NEVER,
  );

  const child = fake.lastChild();
  assert.ok(child, 'expected a spawned child');
  // Single newline-delimited envelope on stdin.
  const lines = child.stdinPayload.split('\n').filter((l: string) => l.length > 0);
  assert.equal(lines.length, 1, 'exactly one envelope (no native multi-turn split)');
  const envelope = JSON.parse(lines[0]) as {
    message: { content: Array<{ type: string; text?: string }> };
  };
  assert.equal(envelope.message.content[0].type, 'text');
  // First block is the history; the user's actual prompt is second.
  assert.match(envelope.message.content[0].text ?? '', /^<chat_history>/);
  assert.match(envelope.message.content[0].text ?? '', /"role": "assistant"/);
  assert.equal(envelope.message.content[1].type, 'text');
  assert.equal(envelope.message.content[1].text, 'continue, please');
});

test('multi-turn: prior plain user/assistant text turns land inside the single chat_history block', async () => {
  // Prior text turns ride the same `<chat_history>` block as tool
  // round-trips — single envelope on the wire (multi-envelope
  // stream-json gets reinterpreted by claude as N separate LLM calls;
  // see formatChatHistory for the rationale).
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit } = collect();
  await backend.handle(
    assignWithOpenAICompat('follow up question', {
      tools: SAMPLE_TOOLS,
      chat_history: [
        { role: 'user', content: 'what was the weather?' },
        { role: 'assistant', content: 'sunny, 18°C' },
      ],
    }),
    emit,
    NEVER,
  );

  const child = fake.lastChild();
  assert.ok(child);
  const lines = child.stdinPayload.split('\n').filter((l: string) => l.length > 0);
  assert.equal(lines.length, 1, 'exactly one envelope');
  const envelope = JSON.parse(lines[0]) as {
    type: string;
    message: { content: Array<{ type: string; text?: string }> };
  };
  assert.equal(envelope.type, 'user');
  const blockText = envelope.message.content[0]?.text ?? '';
  assert.match(blockText, /^<chat_history>/);
  // Both prior text turns appear in the block.
  assert.match(blockText, /"role": "user"/);
  assert.match(blockText, /what was the weather\?/);
  assert.match(blockText, /sunny, 18/);
  // The trailing user (the new question) is its own content block.
  assert.equal(envelope.message.content[1]?.text, 'follow up question');
});

test('multi-turn: absent chat_history leaves the user content untouched', async () => {
  // First-turn / no-history path: only the user text reaches claude, no
  // injected XML wrapper. Guards against the history block leaking onto
  // tasks that didn't ask for it.
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit } = collect();
  await backend.handle(
    assignWithOpenAICompat('what is the weather in Seoul?', { tools: SAMPLE_TOOLS }),
    emit,
    NEVER,
  );

  const child = fake.lastChild();
  assert.ok(child);
  const envelope = JSON.parse(child.stdinPayload.trim()) as {
    message: { content: Array<{ type: string; text?: string }> };
  };
  assert.equal(envelope.message.content.length, 1);
  assert.equal(envelope.message.content[0].text, 'what is the weather in Seoul?');
});

// ---------------------------------------------------------------------------
// openai-compat/v1 response-side `usage` forwarding
//
// Claude Code's terminal `result` event carries a `modelUsage` object keyed
// by model id; we sum across entries to capture internal sub-model
// invocations (e.g. haiku for summarisation) that the top-level `result.usage`
// omits. The summed counts are forwarded under
// `Task.status.message.metadata[<openai-compat URI>].usage` so the gateway
// can hand authoritative numbers to OpenAI clients.
// ---------------------------------------------------------------------------

function completionMessageMetadata(frames: readonly UpFrame[]): Record<string, unknown> | undefined {
  const complete = frames.find((f) => f.type === 'task.complete');
  if (complete?.type !== 'task.complete') return undefined;
  return complete.status.message?.metadata;
}

test('result.modelUsage is summed across models and forwarded as openai-compat usage', async () => {
  // Real shape observed on claude-code 2.1.141 (per the spike): a single
  // turn routes through the primary opus model AND an internal haiku call.
  // Native fields per the openai-compat/v1 mapping table:
  //   input_tokens          → component of prompt_tokens
  //   cache_creation_input  → component of prompt_tokens
  //   cache_read_input      → component of prompt_tokens AND mirrored to cached_tokens
  //   output_tokens         → completion_tokens
  const modelUsage = {
    'claude-haiku-4-5-20251001': {
      inputTokens: 348,
      outputTokens: 13,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    'claude-opus-4-7[1m]': {
      inputTokens: 6,
      outputTokens: 8,
      cacheReadInputTokens: 18029,
      cacheCreationInputTokens: 6904,
    },
  };
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'HELLO',
        modelUsage,
      }),
    ],
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('hi'), emit, NEVER);

  const metadata = completionMessageMetadata(frames);
  assert.ok(metadata, 'task.complete message should carry metadata');
  const payload = metadata[OPENAI_COMPAT_EXTENSION_URI] as { usage?: Record<string, unknown> };
  assert.ok(payload?.usage, 'metadata should contain openai-compat usage');
  // Σ_M (input + cacheCreate + cacheRead): (348+0+0) + (6+6904+18029) = 25287.
  assert.equal(payload.usage.prompt_tokens, 25287);
  // Σ_M output: 13 + 8 = 21.
  assert.equal(payload.usage.completion_tokens, 21);
  // MUST invariant.
  assert.equal(payload.usage.total_tokens, 25287 + 21);
  // cached_tokens mirrors Σ_M cacheRead (lossless): 0 + 18029.
  assert.deepEqual(payload.usage.prompt_tokens_details, { cached_tokens: 18029 });
  // No `model` label: `parseClaudeModelUsageForOpenAICompat` only sums tokens
  // now — the model is resolved from the assistant turn / requested id, not a
  // largest-output-share heuristic over modelUsage (#348). This fixture has
  // no assistant event and is a plain (non-openai-compat) task, so no model
  // is resolved and the field is omitted rather than guessed.
  assert.equal('model' in payload.usage, false);
});

test('single-model modelUsage maps cleanly and advertises the extension', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'ok',
        modelUsage: {
          'claude-opus-4-7[1m]': {
            inputTokens: 6,
            outputTokens: 8,
            cacheReadInputTokens: 24933,
            cacheCreationInputTokens: 23,
          },
        },
      }),
    ],
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('hi'), emit, NEVER);

  const complete = frames.find((f) => f.type === 'task.complete');
  assert.ok(complete && complete.type === 'task.complete');
  assert.deepEqual(complete.status.message?.extensions, [OPENAI_COMPAT_EXTENSION_URI]);
  const payload = complete.status.message?.metadata?.[OPENAI_COMPAT_EXTENSION_URI] as {
    usage?: Record<string, unknown>;
  };
  assert.equal(payload?.usage?.prompt_tokens, 6 + 24933 + 23);
  assert.equal(payload?.usage?.completion_tokens, 8);
  assert.equal(payload?.usage?.total_tokens, 6 + 24933 + 23 + 8);
  assert.deepEqual(payload?.usage?.prompt_tokens_details, { cached_tokens: 24933 });
  // Token sums only — no model label is derived from modelUsage anymore (#348);
  // this plain task has no assistant event to name one.
  assert.equal(payload?.usage && 'model' in payload.usage, false);
});

test('absent modelUsage → no openai-compat metadata is attached', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('hi'), emit, NEVER);

  const complete = frames.find((f) => f.type === 'task.complete');
  assert.ok(complete && complete.type === 'task.complete');
  assert.equal(complete.status.message?.metadata, undefined);
  assert.equal(complete.status.message?.extensions, undefined);
});

test('envelope.model reports the assistant turn model, not the modelUsage winner (#348)', async () => {
  // Repro for #348: a short response ("router-ok") routes the user-facing
  // turn through claude-sonnet-4-6, but an internal haiku sub-model
  // out-produces it in raw output_tokens. The `result.modelUsage`
  // largest-output heuristic therefore reports haiku — correct for usage
  // telemetry, WRONG for the envelope's top-level `model`. The assistant
  // event names the model that actually answered, so the envelope must use
  // that.
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          // CC stamps the running tier suffix; the envelope normalises it off.
          model: 'claude-sonnet-4-6[1m]',
          content: [{ type: 'text', text: 'router-ok' }],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'router-ok',
        modelUsage: {
          // haiku wins by raw output_tokens (13 > 8) — the heuristic trap.
          'claude-haiku-4-5-20251001': {
            inputTokens: 348,
            outputTokens: 13,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          'claude-sonnet-4-6[1m]': {
            inputTokens: 6,
            outputTokens: 8,
            cacheReadInputTokens: 18029,
            cacheCreationInputTokens: 6904,
          },
        },
      }),
    ],
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(
    assignWithOpenAICompat('reply router-ok', { model: 'claude-sonnet-4-6' }),
    emit,
    NEVER,
  );

  const metadata = completionMessageMetadata(frames);
  assert.ok(metadata, 'task.complete message should carry metadata');
  const payload = metadata[OPENAI_COMPAT_EXTENSION_URI] as {
    chat_completion?: Record<string, unknown>;
    usage?: Record<string, unknown>;
  };
  const envelope = payload?.chat_completion;
  assert.ok(envelope, 'chat_completion envelope present');
  // The fix: envelope model is the model that produced the turn, suffix
  // stripped — NOT the haiku modelUsage winner.
  assert.equal(envelope.model, 'claude-sonnet-4-6');
  // The envelope's embedded usage.model is realigned to the same id so the
  // envelope stays internally consistent (id SHOULD match usage.model)...
  const envUsage = envelope.usage as { model?: string; prompt_tokens?: number; completion_tokens?: number };
  assert.equal(envUsage.model, 'claude-sonnet-4-6', 'envelope usage mirrors the response model');
  // ...while the token SUMS remain the across-sub-model totals (haiku tokens
  // still counted): Σ output = 13 + 8 = 21, Σ prompt = 348 + (6+18029+6904).
  assert.equal(envUsage.completion_tokens, 21);
  assert.equal(envUsage.prompt_tokens, 25287);
  // Under the envelope contract the bare top-level `usage` sibling is not
  // emitted — usage lives inside the envelope only.
  assert.equal(payload.usage, undefined);
});

test('envelope.model falls back to the requested model id when no assistant event names one (#348)', async () => {
  // result-only turn: claude emits a `result` event (with modelUsage) but no
  // `assistant` event carrying a model. The envelope must then report the
  // requested model id — already forwarded to claude as `--model` (#302) —
  // not the largest-output sub-model. The requested id carries the `[1m]`
  // tier suffix on the wire; the envelope normalises it off.
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'router-ok',
        modelUsage: {
          'claude-haiku-4-5-20251001': {
            inputTokens: 348,
            outputTokens: 13,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          'claude-opus-4-8[1m]': {
            inputTokens: 6,
            outputTokens: 8,
            cacheReadInputTokens: 18029,
            cacheCreationInputTokens: 6904,
          },
        },
      }),
    ],
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(
    assignWithOpenAICompat('reply router-ok', { model: 'claude-opus-4-8[1m]' }),
    emit,
    NEVER,
  );

  const metadata = completionMessageMetadata(frames);
  assert.ok(metadata, 'task.complete message should carry metadata');
  const payload = metadata[OPENAI_COMPAT_EXTENSION_URI] as {
    chat_completion?: Record<string, unknown>;
  };
  const envelope = payload?.chat_completion;
  assert.ok(envelope, 'chat_completion envelope present');
  // Requested model id, tier suffix stripped — NOT the haiku modelUsage winner.
  assert.equal(envelope.model, 'claude-opus-4-8');
  const envUsage = envelope.usage as { model?: string };
  assert.equal(envUsage.model, 'claude-opus-4-8');
});

test('zero cacheRead does not surface a cached_tokens breakdown', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'ok',
        modelUsage: {
          'claude-opus-4-7[1m]': {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      }),
    ],
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('hi'), emit, NEVER);

  const complete = frames.find((f) => f.type === 'task.complete');
  assert.ok(complete && complete.type === 'task.complete');
  const payload = complete.status.message?.metadata?.[OPENAI_COMPAT_EXTENSION_URI] as {
    usage?: Record<string, unknown>;
  };
  // Omit prompt_tokens_details entirely when there's nothing meaningful to
  // mirror — keeps the wire shape minimal.
  assert.equal(payload?.usage?.prompt_tokens_details, undefined);
});

// ---------------------------------------------------------------------------
// Native MCP dispatch (#213) — claude analog of codex's #212/dynamicTools.
// The native path is the only dispatch for openai-compat caller tools on the
// claude backend; the JSON-text envelope path (#208) was removed wholesale
// because it never actually worked reliably under load (#207). The helpers
// `buildOpenAICompatSystemPrompt` and `tryParseToolCallsEnvelope` are still
// exported from claude.ts for openclaw, which has no MCP-tools equivalent.
// ---------------------------------------------------------------------------

// Unit cover for the OpenAI → CallerToolDefinition mapping. The MCP server
// forwards `inputSchema` verbatim to claude, so getting this mapping right
// is the only place we filter malformed shapes before they reach the model.
test('openaiToolsToCallerToolDefs maps OpenAI tools and drops malformed entries (#213)', () => {
  const out = openaiToolsToCallerToolDefs([
    {
      type: 'function',
      function: {
        name: 'fetch',
        description: 'Fetch a URL',
        parameters: { type: 'object', properties: { url: { type: 'string' } } },
      },
    },
    // Below must be dropped — the gateway already validated the OpenAI
    // shape upstream, but the bridge is the last filter before claude
    // sees a tools/list response and silently misbehaves on a bad spec.
    { type: 'function' }, // no function body
    { type: 'function', function: { description: 'no name' } },
    { type: 'function', function: { name: '' } }, // empty name
    null,
    'oops',
    { function: { name: 'no-type-wrapper' } }, // missing type:"function"
  ] as unknown[]);
  assert.ok(Array.isArray(out));
  assert.equal(out?.length, 1);
  assert.deepEqual(out?.[0], {
    name: 'fetch',
    description: 'Fetch a URL',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
  });

  // Empty / all-invalid inputs return null (callers branch off "no tools
  // to register" without poking `.length`).
  assert.equal(openaiToolsToCallerToolDefs([]), null);
  assert.equal(openaiToolsToCallerToolDefs([null, undefined]), null);

  // A tool with no `parameters` becomes the canonical empty-object schema
  // (matches OpenAI's convention for parameterless functions and gives
  // claude's MCP runtime a syntactically valid JSON Schema to load).
  const noParams = openaiToolsToCallerToolDefs([
    { type: 'function', function: { name: 'ping' } },
  ]);
  assert.deepEqual(noParams?.[0]?.inputSchema, {
    type: 'object',
    properties: {},
  });
});

// Native system-prompt: slim. Must NOT carry the envelope contract (#213
// removed it wholesale), MUST carry the user's `system` text + the
// `<chat_history>` reading hint, and MUST NOT carry the
// stop-after-invoke directive — `--max-turns 1` on the spawned claude
// enforces single-turn semantics mechanically, so prompting the model to
// "stop" duplicates work and pollutes its context.
test('buildOpenAICompatNativeSystemPrompt: slim shape (#213)', () => {
  const out = buildOpenAICompatNativeSystemPrompt(
    'be terse',
    [{ type: 'function', function: { name: 'fetch' } }],
    'auto',
  );
  // The user's system text leads.
  assert.ok(out.startsWith('be terse'));
  // The envelope contract — the very thing this path replaces — must be
  // absent. The legacy helper emits a literal '{"tool_calls":' substring
  // in its contract block; we assert it's missing here.
  assert.equal(out.includes('{"tool_calls"'), false);
  assert.equal(out.includes('respond with ONLY a single JSON object'), false);
  // History-reading hint stays — the model still has to know how to read
  // the prepended `<chat_history>` JSON.
  assert.ok(out.includes('<chat_history>'));
  // Tools are exposed via MCP `tools/list`; the prompt only mentions the
  // native tool surface and does not re-dump the schema.
  assert.ok(out.includes('native tool list'));
  // Stop-after-invoke directive: dropped. `--max-turns 1` enforces it.
  assert.equal(
    out.toLowerCase().includes('after invoking'),
    false,
    'stop-after-invoke directive should be absent (--max-turns 1 enforces)',
  );

  // tool_choice="required" gets a steering line (same descriptor the
  // envelope path uses; `describeToolChoice` is shared).
  const required = buildOpenAICompatNativeSystemPrompt(
    undefined,
    [{ type: 'function', function: { name: 'x' } }],
    'required',
  );
  assert.ok(required.includes('tool_choice="required"'));

  // tool_choice="none" → no envelope, just a "don't invoke caller tools"
  // directive.
  const none = buildOpenAICompatNativeSystemPrompt(
    undefined,
    [{ type: 'function', function: { name: 'x' } }],
    'none',
  );
  assert.ok(none.includes('tool_choice="none"'));

  // Bare `system` with no tools — emits just the system text.
  assert.equal(
    buildOpenAICompatNativeSystemPrompt('just be terse', undefined, undefined),
    'just be terse',
  );

  // No system, no tools, tool_choice undefined → the builder still yields a
  // non-empty neutral base. This is the invariant that makes the output safe
  // to pass to `--system-prompt` (which would replace claude's default with ""
  // otherwise). The append path used to receive "" here harmlessly.
  const bare = buildOpenAICompatNativeSystemPrompt(undefined, undefined, undefined);
  assert.equal(bare, DEFAULT_OPENAI_COMPAT_SYSTEM_PROMPT);
  assert.ok(bare.trim().length > 0, 'bare invocation must never return an empty prompt');
});

// caller-tools MCP module: the onInvoke wiring. We drive the tool through
// `invokeForTest` (skipHttp:true so no listener bind), then verify the ack
// shape and that arguments are passed through verbatim. End-to-end via a
// real HTTP MCP client is deliberately out of scope here — we cover the
// claude.ts wiring through the test seam below.
test('caller-tools MCP: invokeForTest routes args + ack verbatim (#213)', async () => {
  const seen: Array<{ name: string; args: unknown; callId: string }> = [];
  const server = await startCallerToolsMcpServer({
    tools: [
      {
        name: 'fetch',
        description: 'Fetch a URL',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' } },
        },
      },
    ],
    onInvoke: (inv) => {
      seen.push({ name: inv.toolName, args: inv.arguments, callId: inv.callId });
      return { text: 'captured', isError: true };
    },
    skipHttp: true,
  });
  try {
    const ack = await server.invokeForTest({
      callId: 'call_42',
      toolName: 'fetch',
      arguments: { url: 'https://example.com' },
    });
    assert.deepEqual(ack, { text: 'captured', isError: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].name, 'fetch');
    assert.deepEqual(seen[0].args, { url: 'https://example.com' });
    assert.equal(seen[0].callId, 'call_42');
  } finally {
    await server.close();
  }
});

// onInvoke throwing must NOT crash the request — the server has to ack so
// claude doesn't block on the MCP call forever. The bridge wraps the
// thrown error into an isError ack.
test('caller-tools MCP: onInvoke throw is wrapped as isError ack (#213)', async () => {
  const server = await startCallerToolsMcpServer({
    tools: [
      { name: 't', description: '', inputSchema: { type: 'object' } },
    ],
    onInvoke: () => {
      throw new Error('boom');
    },
    skipHttp: true,
  });
  try {
    const ack = await server.invokeForTest({
      callId: 'c',
      toolName: 't',
      arguments: {},
    });
    assert.equal(ack.isError, true);
    assert.ok(ack.text.includes('boom'));
  } finally {
    await server.close();
  }
});

// Argv composition: when openai-compat caller tools are present the
// argv must (a) include a `--mcp-config` with a `caller-tools` server,
// (b) carry the native system prompt (no envelope contract substring),
// (c) still pass `--tools ""` to suppress claude's built-ins.
test('argv: openai-compat caller tools wire caller-tools MCP + native prompt + --tools "" (#213)', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });

  let capturedServer: unknown = null;
  const backend2 = createClaudeBackend({
    spawn: fake.spawn,
    // Test seam: bind no HTTP listener (would leak ports across tests),
    // but capture the running server handle for follow-up assertions.
    onCallerToolsMcpReady: (s) => {
      capturedServer = s;
    },
  });

  const { emit } = collect();
  await backend2.handle(
    assignWithOpenAICompat('do a fetch', {
      system: 'be terse',
      tools: [
        {
          type: 'function',
          function: {
            name: 'fetch',
            description: 'Fetch a URL',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    }),
    emit,
    NEVER,
  );

  assert.ok(capturedServer, 'caller-tools MCP server handle exposed to test seam');

  const child = fake.lastChild();
  assert.ok(child);
  const args = child!.args;

  // (a) --mcp-config carries a `_vb-caller-tools` server entry.
  const cfgIdx = args.indexOf('--mcp-config');
  assert.notEqual(cfgIdx, -1, 'expected --mcp-config in argv');
  const cfg = JSON.parse(args[cfgIdx + 1] as string) as {
    mcpServers?: Record<string, { type?: string; url?: string }>;
  };
  assert.ok(cfg.mcpServers?.['_vb-caller-tools'], '_vb-caller-tools MCP server registered');
  assert.equal(cfg.mcpServers?.['_vb-caller-tools']?.type, 'http');

  // (b) --system-prompt carries the native variant (replacing claude's
  // default) — the envelope contract block (the literal `{"tool_calls"`
  // substring the legacy prompt teaches) must be absent.
  const apsIdx = args.indexOf('--system-prompt');
  assert.notEqual(apsIdx, -1, '--system-prompt present');
  const prompt = args[apsIdx + 1] as string;
  assert.equal(prompt.includes('{"tool_calls"'), false);
  assert.ok(prompt.startsWith('be terse'));

  // (c) --tools "" still passed (caller tools should be the ONLY tool
  // surface available to the model — native MCP-mapped tools, no
  // claude built-ins; #178's original concern).
  const toolsIdx = args.indexOf('--tools');
  assert.notEqual(toolsIdx, -1);
  assert.equal(args[toolsIdx + 1], '');

  // (d) --allowedTools pre-approves the caller-tools MCP server so the
  // model's tool_use survives operator environments that leave claude's
  // permission system in `defaultMode: "default"`. In `-p` mode there's
  // no TTY to answer a permission prompt, so an un-allowlisted MCP
  // tool auto-denies and the run dies at --max-turns 1 with
  // `permission_denials` in the result event (issue #235).
  const allowedIdx = args.indexOf('--allowedTools');
  assert.notEqual(allowedIdx, -1, '--allowedTools required for caller-tools MCP (#235)');
  assert.equal(args[allowedIdx + 1], 'mcp___vb-caller-tools');
});

// Regression for #235: --allowedTools must cover every MCP server the
// bridge registers, not just caller-tools. When both `send_file`
// (_vb-send-file) and caller-tools (_vb-caller-tools) are active, both
// server-level rules must appear in a single space-separated
// `--allowedTools` value.
test('argv: --allowedTools covers all registered MCP servers (#235)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-235-allowed-'));
  const realRoot = await fs.realpath(root);
  try {
    const fake = scriptedSpawn({
      lines: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
        JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
      ],
      exitCode: 0,
    });
    const backend = createClaudeBackend({
      spawn: fake.spawn,
      sendFileMcp: { allowedRoots: [realRoot], skipHttp: true },
    });
    await backend.handle(
      assignWithOpenAICompat('do a fetch', {
        system: 'be terse',
        tools: [
          {
            type: 'function',
            function: {
              name: 'fetch',
              description: 'Fetch a URL',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      }),
      collect().emit,
      NEVER,
    );
    const child = fake.lastChild();
    assert.ok(child);
    const args = child!.args;
    const allowedIdx = args.indexOf('--allowedTools');
    assert.notEqual(allowedIdx, -1);
    const tokens = String(args[allowedIdx + 1]).split(/\s+/).filter(Boolean);
    // Order is insertion-order of `Object.keys(mcpServers)`:
    // _vb-send-file first (added when sendFileMcp is enabled), then
    // _vb-caller-tools (added when openai-compat tools are present).
    assert.deepEqual(tokens.sort(), ['mcp___vb-caller-tools', 'mcp___vb-send-file']);

    const closer = backend.getSendFileMcpServer();
    if (closer) await closer.close();
  } finally {
    await fs.rm(realRoot, { recursive: true, force: true });
  }
});

// End-to-end (with test seam): the model "invokes" the caller tool via
// the MCP server's `invokeForTest` while claude is mid-run; the bridge
// surfaces the call on the terminal `chat_completion` envelope metadata
// (oai2a2a#80) and suppresses any subsequent agent text from
// `status.message.parts` on completion. Same invariant codex backend
// enforces under #212.
test('native dispatch: tool invocation → chat_completion envelope on terminal status + suppresses final text (#213, oai2a2a#80)', async () => {
  // Drive claude's stream-json from outside so we can interleave the
  // MCP invocation. The fake child stays alive until `finish()` so the
  // bridge can route the artifact emit through the live `emit` capture.
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      child.emitStdout(
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }) + '\n',
      );
      // The model "decides" to call a tool — in real life this fires an
      // MCP `tools/call` against our server. In test we drive
      // `invokeForTest` directly from the seam below. Then the model
      // ends the turn with a result event.
      // (Order: seam fires invokeForTest BEFORE we emit the result line.)
    });
  });

  const { emit, frames } = collect();
  const backend = createClaudeBackend({
    spawn: fake.spawn,
    onCallerToolsMcpReady: async (server) => {
      // Drive the synthetic tool call. The bridge's onInvoke captures
      // this and emits the tool_calls artifact.
      const ack = await server.invokeForTest({
        callId: 'call_xyz',
        toolName: 'fetch',
        arguments: { url: 'https://example.com' },
      });
      assert.equal(ack.isError, true);
      // After the bridge has captured, simulate claude wrapping up the
      // turn with a brief text emission AND a final result. The text
      // must NOT land on status.message.parts (capturedToolCall flag).
      const child = fake.lastChild();
      if (!child) return;
      child.emitStdout(
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'OK, calling that for you.' }],
          },
        }) + '\n',
      );
      child.emitStdout(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'OK, calling that for you.',
        }) + '\n',
      );
      setImmediate(() => child.finish(0));
    },
  });

  await backend.handle(
    assignWithOpenAICompat('fetch example.com', {
      system: 'be terse',
      tools: [
        {
          type: 'function',
          function: {
            name: 'fetch',
            description: 'Fetch a URL',
            parameters: {
              type: 'object',
              properties: { url: { type: 'string' } },
              required: ['url'],
            },
          },
        },
      ],
    }),
    emit,
    NEVER,
  );

  // Envelope contract (oai2a2a#80): no data-part `tool_calls` artifact.
  // The model's function_call is delivered exclusively on the terminal
  // status message metadata as `chat_completion.choices[0].message.tool_calls`.
  const dataArtifacts = frames.filter(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> =>
      f.type === 'task.artifact' &&
      f.artifact.extensions?.includes(OPENAI_COMPAT_EXTENSION_URI) === true &&
      f.artifact.parts[0]?.kind === 'data',
  );
  assert.equal(
    dataArtifacts.length,
    0,
    'no data-part tool_calls artifact under the envelope contract',
  );

  // Terminal frame: state=completed, NO text in status.message.parts.
  // The chat_completion envelope is the complete output; any wrap-up text
  // the model emitted ("OK, calling that for you.") is reasoning preamble
  // and is dropped on completion to avoid the #200-style double-emit
  // downstream gateways would otherwise produce.
  const complete = frames.find(
    (f): f is Extract<UpFrame, { type: 'task.complete' }> => f.type === 'task.complete',
  );
  assert.ok(complete);
  assert.equal(complete?.status.state, 'completed');
  const parts = complete?.status.message?.parts ?? [];
  const hasText = parts.some((p) => p.kind === 'text');
  assert.equal(hasText, false, 'no text in status.message.parts when tool was captured');

  // Envelope verification: the terminal status message metadata carries the
  // complete OpenAI ChatCompletion envelope with tool_calls.
  if (complete && complete.type === 'task.complete') {
    const metadata = complete.status.message?.metadata as
      | Record<string, Record<string, unknown>>
      | undefined;
    const ext = metadata?.[OPENAI_COMPAT_EXTENSION_URI];
    assert.ok(ext, 'openai-compat metadata present on terminal message');
    const envelope = ext.chat_completion as Record<string, unknown> | undefined;
    assert.ok(envelope, 'chat_completion envelope present');
    assert.equal(typeof envelope.id, 'string');
    assert.ok((envelope.id as string).startsWith('chatcmpl-claude-'));
    assert.equal(envelope.object, 'chat.completion');
    assert.equal(typeof envelope.created, 'number');
    assert.equal(typeof envelope.model, 'string');
    const choices = envelope.choices as Array<Record<string, unknown>>;
    assert.equal(choices.length, 1);
    const choice = choices[0];
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.equal(choice.logprobs, null);
    const message = choice.message as {
      role: string;
      content: unknown;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: unknown };
      }>;
    };
    assert.equal(message.role, 'assistant');
    assert.equal(message.content, null);
    assert.equal(message.tool_calls?.length, 1);
    assert.equal(message.tool_calls?.[0]?.id, 'call_xyz');
    assert.equal(message.tool_calls?.[0]?.type, 'function');
    assert.equal(message.tool_calls?.[0]?.function?.name, 'fetch');
    // OpenAI spec requires `arguments` to be a JSON-encoded string.
    const argsRaw = message.tool_calls?.[0]?.function?.arguments;
    assert.equal(typeof argsRaw, 'string');
    assert.deepEqual(JSON.parse(argsRaw as string), {
      url: 'https://example.com',
    });
  }
});

// `--max-turns 1` + exit-code-1 mapping (#213): with native dispatch active,
// claude code hits the turn cap immediately after the model emits its
// tool_use(s) and exits with code 1. The bridge MUST map that exit to a
// successful task.complete when a tool call was captured (the
// `chat_completion` envelope on the terminal status message IS the complete
// output for this turn — same invariant codex backend enforces under PR
// #212). Without this mapping every native tool-using task would surface
// as task.fail to the caller, breaking the OpenAI Chat Completions
// `finish_reason: "tool_calls"` round-trip.
test('native dispatch: --max-turns 1 exits with code 1; bridge maps to completed when tool captured (#213)', async () => {
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      child.emitStdout(
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }) + '\n',
      );
    });
  });

  const { emit, frames } = collect();
  const backend = createClaudeBackend({
    spawn: fake.spawn,
    onCallerToolsMcpReady: async (server) => {
      // Drive the synthetic tool call.
      await server.invokeForTest({
        callId: 'call_xyz',
        toolName: 'fetch',
        arguments: { url: 'https://example.com' },
      });
      // claude code's `--max-turns 1` reaction: exits with code 1 the
      // moment a follow-up turn would be needed. The artifact is already
      // on the wire; the bridge must still surface a success terminal.
      const child = fake.lastChild();
      if (child) setImmediate(() => child.finish(1));
    },
  });

  await backend.handle(
    assignWithOpenAICompat('fetch example.com', {
      tools: [
        {
          type: 'function',
          function: { name: 'fetch', parameters: { type: 'object' } },
        },
      ],
    }),
    emit,
    NEVER,
  );

  // argv carries `--max-turns 1` when native dispatch fires.
  const child = fake.lastChild()!;
  const mtIdx = child.args.indexOf('--max-turns');
  assert.notEqual(mtIdx, -1, '--max-turns present');
  assert.equal(child.args[mtIdx + 1], '1');

  // Terminal must be task.complete with state=completed, NOT task.fail.
  // The exit-code-1 from claude is bookkeeping noise once a tool was
  // captured.
  const terminal = frames.at(-1);
  assert.ok(terminal);
  assert.equal(terminal?.type, 'task.complete');
  if (terminal?.type === 'task.complete') {
    assert.equal(terminal.status.state, 'completed');
  }

  // No task.fail anywhere in the stream.
  const failFrame = frames.find((f) => f.type === 'task.fail');
  assert.equal(failFrame, undefined, 'task.fail must not be emitted');

  // Envelope contract (oai2a2a#80): no data-part `tool_calls` artifact;
  // the tool_calls ride exclusively on the terminal status message's
  // chat_completion envelope. Verify the envelope is present with
  // finish_reason: 'tool_calls' and the captured call.
  const dataArt = frames.find(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> =>
      f.type === 'task.artifact' && f.artifact.parts[0]?.kind === 'data',
  );
  assert.equal(dataArt, undefined, 'no data-part tool_calls artifact under the envelope contract');

  if (terminal?.type === 'task.complete') {
    const metadata = terminal.status.message?.metadata as
      | Record<string, Record<string, unknown>>
      | undefined;
    const envelope = metadata?.[OPENAI_COMPAT_EXTENSION_URI]?.chat_completion as
      | Record<string, unknown>
      | undefined;
    assert.ok(envelope, 'chat_completion envelope present on terminal status');
    const choices = envelope.choices as Array<Record<string, unknown>>;
    assert.equal(choices[0]?.finish_reason, 'tool_calls');
    const msg = choices[0]?.message as { tool_calls?: Array<{ id?: string }> };
    assert.equal(msg.tool_calls?.length, 1);
    assert.equal(msg.tool_calls?.[0]?.id, 'call_xyz');
  }
});

// Inverse: claude exits non-zero WITHOUT any tool capture (e.g., a real
// startup failure). The bridge must still surface task.fail — we never
// want the exit-success mapping to silently swallow real errors. The gate
// is `capturedToolCall`, not just "native dispatch active."
test('native dispatch: exit-code-1 with NO tool capture still fails (#213)', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
    ],
    stderr: 'fatal: model API unreachable',
    exitCode: 1,
  });
  const { emit, frames } = collect();
  const backend = createClaudeBackend({
    spawn: fake.spawn,
  });

  await backend.handle(
    assignWithOpenAICompat('do a fetch', {
      tools: [
        {
          type: 'function',
          function: { name: 'fetch', parameters: { type: 'object' } },
        },
      ],
    }),
    emit,
    NEVER,
  );

  const terminal = frames.at(-1);
  assert.ok(terminal && terminal.type === 'task.fail');
  if (terminal.type === 'task.fail') {
    assert.equal(terminal.error.code, 'claude_exit_nonzero');
    assert.ok(terminal.error.message.includes('model API unreachable'));
  }
});

// Tool-name qualification (fix #1): under native dispatch the caller's tools
// are live as `mcp___vb-caller-tools__<name>`, but the wire chat_history
// records prior calls by their bare OpenAI name (`read`). The bridge must
// rewrite the replayed history names to the MCP ids so the model's historical
// view matches its live tool list — otherwise it re-emits the bare name,
// claude rejects it ("No such tool available"), and the run dies at the cap.
test('native dispatch: chat_history caller-tool names are qualified to MCP ids on stdin', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        terminal_reason: 'completed',
        result: 'ok',
      }),
    ],
    exitCode: 0,
  });
  const { emit } = collect();
  const backend = createClaudeBackend({
    spawn: fake.spawn,
    onCallerToolsMcpReady: () => {},
  });

  await backend.handle(
    assignWithOpenAICompat('continue', {
      tools: [
        { type: 'function', function: { name: 'read', parameters: { type: 'object' } } },
      ],
      chat_history: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: '{"filePath":"/a"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', name: 'read', content: 'file contents' },
      ],
    }),
    emit,
    NEVER,
  );

  const child = fake.lastChild()!;
  const env = JSON.parse(child.stdinPayload.trim()) as {
    message: { content: Array<{ type: string; text?: string }> };
  };
  const histBlock = env.message.content.find(
    (c) => c.type === 'text' && (c.text ?? '').includes('<chat_history>'),
  );
  assert.ok(histBlock, 'chat_history block present on stdin');
  const text = histBlock!.text!;
  // Both the assistant tool_calls name AND the tool result name are qualified.
  assert.match(text, /mcp___vb-caller-tools__read/);
  // The bare OpenAI name no longer appears as a tool name (would re-condition
  // the model to call the unqualified id). The arguments value `/a` and the
  // qualified `..._read` both still contain "read" as a substring, so we pin
  // the exact key/value form that the bare name would have produced.
  assert.doesNotMatch(text, /"name": "read"/);
});

// Diagnostic (fix #3): a tool-name mismatch that slips through (model invents
// an unregistered name) shows up as "No such tool available", the call is
// never captured, and the `--max-turns 1` cap kills the run. The terminal
// failure must spell out the proximate cause rather than a bare exit-1.
test('native dispatch: "No such tool available" exit surfaces a tool-mismatch hint', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'read', input: { filePath: '/a' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              is_error: true,
              content: '<tool_use_error>Error: No such tool available: read</tool_use_error>',
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        terminal_reason: 'max_turns',
        errors: ['Reached maximum number of turns (1)'],
      }),
    ],
    exitCode: 1,
  });
  const { emit, frames } = collect();
  const backend = createClaudeBackend({
    spawn: fake.spawn,
    onCallerToolsMcpReady: () => {},
  });

  await backend.handle(
    assignWithOpenAICompat('read the file', {
      tools: [
        { type: 'function', function: { name: 'read', parameters: { type: 'object' } } },
      ],
    }),
    emit,
    NEVER,
  );

  const terminal = frames.at(-1);
  assert.ok(terminal && terminal.type === 'task.fail');
  if (terminal.type === 'task.fail') {
    assert.equal(terminal.error.code, 'claude_exit_nonzero');
    // The hint names the proximate cause and the expected id shape.
    assert.match(terminal.error.message, /hint: model called a tool name claude does not expose/);
    assert.match(terminal.error.message, /mcp___vb-caller-tools__/);
  }
});

// Without an openai-compat `tools` field, no caller-tools MCP is stood
// up and none of the native-dispatch argv (`--mcp-config caller-tools`,
// `--max-turns 1`, native system prompt) attaches. Guards against the
// new path leaking into plain claude tasks.
test('no openai-compat tools → no native dispatch argv (#213)', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'hi' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('hi'), emit, NEVER);

  const child = fake.lastChild()!;
  const cfgIdx = child.args.indexOf('--mcp-config');
  if (cfgIdx !== -1) {
    const cfg = JSON.parse(child.args[cfgIdx + 1] as string) as {
      mcpServers?: Record<string, unknown>;
    };
    assert.equal(cfg.mcpServers?.['_vb-caller-tools'], undefined);
  }
  assert.equal(child.args.indexOf('--max-turns'), -1);
  // Built-in tools stay enabled (no `--tools ""`) so claude can operate
  // normally on a plain text prompt.
  assert.equal(child.args.indexOf('--tools'), -1);
  // Non-extension task should reach task.complete normally.
  const terminal = frames.at(-1);
  assert.ok(terminal && terminal.type === 'task.complete');
});

// openai-compat is stateless by design (every OpenAI Chat Completions
// request carries its own full message history), so the bridge MUST NOT
// `--resume` a prior claude session for these tasks even when the same
// contextId comes through again. Resuming would feed the model the
// sentinel "captured by bridge" result from the MCP `onInvoke` of the
// prior turn alongside the user message's real history block — two
// conflicting sources of truth on the same `tool_call_id`. Force fresh
// `--session-id` instead. Plain claude tasks (no openai-compat metadata)
// keep their existing session-reuse behaviour.
test('openai-compat: same contextId still spawns a fresh --session-id (no --resume) (#213)', async () => {
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
    ],
    exitCode: 0,
  });
  const backend = createClaudeBackend({
    spawn: fake.spawn,
    onCallerToolsMcpReady: () => {},
  });
  const { emit } = collect();
  const metaFor = (text: string): Record<string, unknown> => ({
    [OPENAI_COMPAT_EXTENSION_URI]: {
      chat_completions_request: {
        messages: [{ role: 'user', content: text }],
        tools: [
          { type: 'function', function: { name: 'fetch', parameters: { type: 'object' } } },
        ],
      },
    },
  });

  // Two turns sharing the same contextId — without the openai-compat gate
  // the second one would carry `--resume <sessionId-from-turn-1>`.
  await backend.handle(
    {
      type: 'task.assign',
      taskId: 'oai-t1',
      contextId: 'ctx-shared',
      message: { role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: 'a' }], metadata: metaFor('a') },
    },
    emit,
    NEVER,
  );
  await backend.handle(
    {
      type: 'task.assign',
      taskId: 'oai-t2',
      contextId: 'ctx-shared',
      message: { role: 'user', messageId: 'm2', parts: [{ kind: 'text', text: 'b' }], metadata: metaFor('b') },
    },
    emit,
    NEVER,
  );

  const child = fake.lastChild()!;
  // Every openai-compat spawn must use `--session-id`, never `--resume`.
  assert.notEqual(child.args.indexOf('--session-id'), -1, 'second turn uses --session-id');
  assert.equal(child.args.indexOf('--resume'), -1, 'second turn must NOT --resume');
});

test('AskUserQuestion: terminal frame uses state=input-required with DataPart payload (A2A spec §9.4)', async () => {
  // Sequence: claude streams an AskUserQuestion tool_use, then a short
  // assistant text + result event (what CC produces after we feed it the
  // placeholder tool_result). The backend should:
  //   1. Not emit a separate `ask-user-question` artifact
  //   2. Suppress the placeholder-induced assistant text
  //   3. Close the run with task.complete state=input-required carrying the
  //      tool_call payload on status.message.parts[0] as a DataPart
  //   4. Write the placeholder tool_result back to stdin and end it
  const askInput = { questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }] };
  const fake = scriptedSpawn({
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_aq_1',
              name: 'AskUserQuestion',
              input: askInput,
            },
          ],
        },
      }),
      // CC's response to our placeholder tool_result — should be suppressed.
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok, waiting' }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok, waiting' }),
    ],
    exitCode: 0,
  });

  const backend = createClaudeBackend({ spawn: fake.spawn });
  const { emit, frames } = collect();
  await backend.handle(assign('please choose'), emit, NEVER);

  // No `ask-user-question` artifact should be emitted (it migrated to
  // status.message).
  const artifacts = frames.filter(
    (f): f is Extract<UpFrame, { type: 'task.artifact' }> => f.type === 'task.artifact',
  );
  assert.equal(
    artifacts.find((a) => a.artifact.name === 'ask-user-question'),
    undefined,
  );
  // Placeholder-induced assistant text must also be suppressed.
  assert.equal(
    artifacts.find((a) => a.artifact.name === 'claude-message'),
    undefined,
  );

  const complete = frames.at(-1);
  assert.ok(complete && complete.type === 'task.complete');
  assert.equal(complete.status.state, 'input-required');
  const part = complete.status.message?.parts[0];
  assert.ok(part && part.kind === 'data');
  assert.deepEqual(part.data, {
    kind: 'tool_call',
    toolName: 'AskUserQuestion',
    toolUseId: 'tu_aq_1',
    input: askInput,
  });

  // Verify the placeholder tool_result was written to CC's stdin and stdin
  // was closed so CC's session terminates cleanly (next turn can --resume).
  const child = fake.lastChild();
  assert.ok(child);
  assert.equal(child.stdinClosed, true);
  assert.match(child.stdinPayload, /tool_result/);
  assert.match(child.stdinPayload, /tu_aq_1/);
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveCapabilities — startup probe that captures the underlying model from
// the `system/init` stream-json event for openai-compat/v1 `params.models`
// advertise (planetarium/oai2a2a#63). The probe SIGTERMs before any LLM call
// is issued.
// ─────────────────────────────────────────────────────────────────────────────

test('probeClaudeModel returns normalised model from system/init and SIGTERMs the child', async () => {
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      // Real claude emits a rate_limit_event before system/init in some
      // sessions; the probe must ignore non-init events and keep reading.
      child.emitStdout(
        JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }) + '\n',
      );
      child.emitStdout(
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: 'sid',
          // The 1M-tier suffix MUST be stripped so the advertise matches
          // the canonical Anthropic model id (and `usage.model`).
          model: 'claude-opus-4-7[1m]',
        }) + '\n',
      );
    });
  });

  const model = await probeClaudeModel({
    command: 'claude',
    spawn: fake.spawn,
    timeoutMs: 1000,
  });

  assert.equal(model, 'claude-opus-4-7');
  const child = fake.lastChild();
  assert.ok(child);
  assert.equal(child.killed, true);
  assert.equal(child.killSignal, 'SIGTERM');
  // The probe invokes the stream-json + verbose argv documented in
  // https://code.claude.com/docs/en/headless — pin it so a future spawn
  // refactor that drops a required flag (e.g. --verbose) is caught here
  // rather than only in production where system/init silently never lands.
  assert.deepEqual(Array.from(child.args), Array.from(CLAUDE_PROBE_ARGS));
});

test('probeClaudeModel returns null on timeout when no system/init arrives', async () => {
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      // Emit only a non-init event so the probe never settles on its own.
      child.emitStdout(
        JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }) + '\n',
      );
      // Never call child.finish().
    });
  });

  const model = await probeClaudeModel({
    command: 'claude',
    spawn: fake.spawn,
    timeoutMs: 50,
  });

  assert.equal(model, null);
  const child = fake.lastChild();
  assert.ok(child);
  assert.equal(child.killed, true, 'timeout path must SIGTERM the child');
});

test('probeClaudeModel ignores malformed JSON lines and still extracts model', async () => {
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      // Garbage line, then a half-line, then valid system/init. The probe
      // must skip the non-JSON noise rather than abort.
      child.emitStdout('not json at all\n');
      child.emitStdout('{ "type": "system", "subtype": "init"');
      child.emitStdout(', "model": "claude-sonnet-4-6" }\n');
    });
  });

  const model = await probeClaudeModel({
    command: 'claude',
    spawn: fake.spawn,
    timeoutMs: 1000,
  });

  assert.equal(model, 'claude-sonnet-4-6');
});

test('probeClaudeModel returns null when child exits before init', async () => {
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      // Exit immediately with no useful output (mimics `claude: command
      // not found` / auth-required exit path).
      child.finish(127, null);
    });
  });

  const model = await probeClaudeModel({
    command: 'claude',
    spawn: fake.spawn,
    timeoutMs: 1000,
  });

  assert.equal(model, null);
});

test('probeClaudeModel returns null when spawn itself throws', async () => {
  const spawn: import('./claude.js').ClaudeSpawnFn = () => {
    throw new Error('ENOENT');
  };
  const model = await probeClaudeModel({
    command: 'claude',
    spawn,
    timeoutMs: 1000,
  });
  assert.equal(model, null);
});

test('claude backend resolveCapabilities advertises normalised model from system/init probe', async () => {
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      child.emitStdout(
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          model: 'claude-opus-4-7[1m]',
        }) + '\n',
      );
    });
  });

  const backend = createClaudeBackend({ spawn: fake.spawn, probeTimeoutMs: 1000 });
  assert.ok(backend.resolveCapabilities, 'claude backend must expose resolveCapabilities');
  const caps = await backend.resolveCapabilities!();
  assert.deepEqual(caps, {
    openaiCompatModels: [{ id: 'claude-opus-4-7', default: true }],
  });
});

test('normalizeClaudeModelId strips trailing tier suffix and is a no-op otherwise', () => {
  assert.equal(normalizeClaudeModelId('claude-opus-4-7[1m]'), 'claude-opus-4-7');
  assert.equal(normalizeClaudeModelId('claude-opus-4-7[200k]'), 'claude-opus-4-7');
  assert.equal(normalizeClaudeModelId('claude-opus-4-7'), 'claude-opus-4-7');
  assert.equal(
    normalizeClaudeModelId('claude-opus-4-7-20251101'),
    'claude-opus-4-7-20251101',
    'dated form has no brackets — pass through verbatim',
  );
  assert.equal(normalizeClaudeModelId('claude-haiku-4-5[1m]'), 'claude-haiku-4-5');
});

test('probeClaudeModel returns null if the whole id was a bracket tier marker', async () => {
  // Pathological: model = "[1m]" only. Stripping leaves empty string, and
  // an empty `id` would trip the protocol's z.string().min(1). Treat as
  // no signal so the daemon ships its declared card unchanged.
  const fake = makeFakeSpawn((child) => {
    setImmediate(() => {
      child.emitStdout(
        JSON.stringify({ type: 'system', subtype: 'init', model: '[1m]' }) + '\n',
      );
    });
  });
  const model = await probeClaudeModel({
    command: 'claude',
    spawn: fake.spawn,
    timeoutMs: 1000,
  });
  assert.equal(model, null);
});

test('parseClaudeModelUsageForOpenAICompat sums token counts without picking a model', () => {
  // The model label is resolved by the caller (assistant turn / requested id),
  // NOT from a largest-output-share heuristic over modelUsage (#348). This
  // helper now only sums tokens across the per-model entries.
  const usage = parseClaudeModelUsageForOpenAICompat({
    'claude-haiku-4-5-20251001': { inputTokens: 100, outputTokens: 5 },
    'claude-opus-4-7[1m]': { inputTokens: 100, outputTokens: 50 },
  });
  assert.ok(usage);
  assert.equal(usage!.prompt_tokens, 200);
  assert.equal(usage!.completion_tokens, 55);
  assert.equal('model' in usage!, false);
});

// Envelope shape: text-only turn (no tool calls, with usage) produces a
// spec-compliant ChatCompletion envelope — id synthesized from taskId,
// object/created/model defaults, logprobs:null on the choice, content as
// the assistant text, and finish_reason:'stop'.
test('buildClaudeChatCompletionEnvelope: text-only turn shape with synthesized defaults (oai2a2a#80)', () => {
  const usage = buildOpenAICompatUsageFromInputs(120, 30, 'claude-opus-4-7');
  const envelope = buildClaudeChatCompletionEnvelope({
    taskId: 't-abc',
    model: 'claude-opus-4-7',
    content: 'hello there',
    toolCalls: undefined,
    finishReason: 'stop',
    usage,
  });
  assert.equal(envelope.id, 'chatcmpl-claude-t-abc');
  assert.equal(envelope.object, 'chat.completion');
  assert.equal(typeof envelope.created, 'number');
  assert.equal(envelope.model, 'claude-opus-4-7');
  const choices = envelope.choices as Array<Record<string, unknown>>;
  assert.equal(choices.length, 1);
  assert.equal(choices[0]?.index, 0);
  assert.equal(choices[0]?.finish_reason, 'stop');
  assert.equal(choices[0]?.logprobs, null);
  const message = choices[0]?.message as { role: string; content: unknown; tool_calls?: unknown };
  assert.equal(message.role, 'assistant');
  assert.equal(message.content, 'hello there');
  assert.equal('tool_calls' in message, false);
  // Usage rides inside the envelope.
  const envUsage = envelope.usage as { prompt_tokens?: number; total_tokens?: number; model?: string };
  assert.equal(envUsage.prompt_tokens, 120);
  assert.equal(envUsage.total_tokens, 150);
  assert.equal(envUsage.model, 'claude-opus-4-7');
});

// Defensive defaults: when claude never surfaced a model id (e.g. the run
// failed before any modelUsage frame landed), the envelope still satisfies
// the spec's "model is required" obligation via the placeholder fallback.
// Tool-call envelopes carry `content: null` and a populated tool_calls
// array; finish_reason flips to 'tool_calls'.
test('buildClaudeChatCompletionEnvelope: tool-call envelope with model fallback (oai2a2a#80)', () => {
  const envelope = buildClaudeChatCompletionEnvelope({
    taskId: 'task-xyz',
    model: undefined,
    content: null,
    toolCalls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'fetch', arguments: '{"url":"https://example.com"}' },
      },
    ],
    finishReason: 'tool_calls',
    usage: null,
  });
  assert.equal(envelope.id, 'chatcmpl-claude-task-xyz');
  assert.equal(envelope.model, 'claude');
  assert.equal('usage' in envelope, false, 'usage omitted when not reported');
  const choices = envelope.choices as Array<Record<string, unknown>>;
  assert.equal(choices[0]?.finish_reason, 'tool_calls');
  assert.equal(choices[0]?.logprobs, null);
  const message = choices[0]?.message as {
    role: string;
    content: unknown;
    tool_calls?: Array<{ id?: string; type?: string; function?: { arguments?: unknown } }>;
  };
  assert.equal(message.role, 'assistant');
  assert.equal(message.content, null);
  assert.equal(message.tool_calls?.length, 1);
  assert.equal(message.tool_calls?.[0]?.id, 'call_1');
  assert.equal(message.tool_calls?.[0]?.type, 'function');
  // `arguments` MUST be a JSON-encoded string per OpenAI Chat Completions.
  assert.equal(typeof message.tool_calls?.[0]?.function?.arguments, 'string');
});

// Local helper — keeps the envelope test self-contained without leaning on
// internal usage-builder import.
function buildOpenAICompatUsageFromInputs(
  prompt: number,
  completion: number,
  model: string,
): { prompt_tokens: number; completion_tokens: number; total_tokens: number; model: string } {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    model,
  };
}

test('claude backend resolveCapabilities returns {} on probe timeout', async () => {
  const fake = makeFakeSpawn(() => {
    // No output, no finish — the probe must time out and return {}.
  });

  const backend = createClaudeBackend({ spawn: fake.spawn, probeTimeoutMs: 25 });
  const caps = await backend.resolveCapabilities!();
  assert.deepEqual(caps, {});
});

test('claude backend resolveCapabilities short-circuits when probeTimeoutMs is 0', async () => {
  let spawned = 0;
  const fake = makeFakeSpawn(() => {
    spawned += 1;
  });
  const backend = createClaudeBackend({ spawn: fake.spawn, probeTimeoutMs: 0 });
  const caps = await backend.resolveCapabilities!();
  assert.deepEqual(caps, {});
  assert.equal(spawned, 0, 'probeTimeoutMs:0 must skip the spawn entirely');
});
