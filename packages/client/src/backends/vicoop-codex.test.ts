import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  type TaskAssignFrame,
  type UpFrame,
} from '@vicoop-bridge/protocol';
import {
  buildCallBody,
  buildMessages,
  buildResponseMetadata,
  createVicoopCodexBackend,
  flattenA2AUserContent,
  historyToChatCompletionMessages,
  parseChatCompletionUsage,
  type ChatCompletionResponse,
  type VicoopCodexChildHandle,
  type VicoopCodexSpawnFn,
  type VicoopCodexSpawnOptions,
} from './vicoop-codex.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fake `vicoop-codex` child — collects stdin, scripts stdout/stderr/exit-code
// to drive integration tests through the backend's `handle()` path without a
// real subprocess. Mirrors the codex.test.ts FakeChild shape.
// ─────────────────────────────────────────────────────────────────────────────

interface FakeChild extends VicoopCodexChildHandle {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  killed: boolean;
  killSignal: NodeJS.Signals | null;
  stdinPayload: () => string;
  emitStdout(text: string): void;
  emitStderr(text: string): void;
  finish(code: number | null, sig?: NodeJS.Signals | null): void;
}

interface FakeSpawn {
  spawn: VicoopCodexSpawnFn;
  children: FakeChild[];
  lastChild: () => FakeChild;
}

function makeFakeSpawn(): FakeSpawn {
  const children: FakeChild[] = [];
  const spawn: VicoopCodexSpawnFn = (
    command,
    args,
    options: VicoopCodexSpawnOptions,
  ) => {
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const closeListeners: Array<
      (code: number | null, sig: NodeJS.Signals | null) => void
    > = [];
    let closed = false;

    const mkReadable = (em: EventEmitter): NodeJS.ReadableStream =>
      ({
        on(event: string, cb: (...a: unknown[]) => void) {
          em.on(event, cb);
        },
      }) as unknown as NodeJS.ReadableStream;

    const stdinChunks: string[] = [];
    const stdin: NodeJS.WritableStream = {
      write(chunk: unknown): boolean {
        const s =
          typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk as Buffer).toString('utf8');
        stdinChunks.push(s);
        return true;
      },
      end(chunk?: unknown) {
        if (chunk !== undefined) {
          const s =
            typeof chunk === 'string'
              ? chunk
              : Buffer.from(chunk as Buffer).toString('utf8');
          stdinChunks.push(s);
        }
        return stdin;
      },
      on() {
        return stdin;
      },
      once() {
        return stdin;
      },
      emit() {
        return false;
      },
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
      stdinPayload: () => stdinChunks.join(''),
      emitStdout(text) {
        stdoutEmitter.emit('data', Buffer.from(text, 'utf8'));
      },
      emitStderr(text) {
        stderrEmitter.emit('data', Buffer.from(text, 'utf8'));
      },
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
          closeListeners.push(
            listener as (
              code: number | null,
              signal: NodeJS.Signals | null,
            ) => void,
          );
        }
      },
      finish(code, sig = null) {
        if (closed) return;
        closed = true;
        // Schedule async so the backend has a chance to register its
        // listeners before we synthesise the exit — mirrors real
        // child_process semantics.
        queueMicrotask(() => {
          for (const l of closeListeners) l(code, sig);
        });
      },
    };
    children.push(child);
    return child;
  };
  return {
    spawn,
    children,
    lastChild: () => {
      if (children.length === 0) throw new Error('no fake child spawned yet');
      return children[children.length - 1];
    },
  };
}

function makeTask(
  overrides: Partial<TaskAssignFrame> & { metadata?: Record<string, unknown> } = {},
): TaskAssignFrame {
  const { metadata, ...rest } = overrides;
  return {
    type: 'task.assign',
    taskId: 'task-1',
    contextId: 'ctx-1',
    message: {
      role: 'user',
      messageId: 'msg-1',
      parts: [{ kind: 'text', text: 'hello' }],
      ...(metadata ? { metadata } : {}),
    },
    ...rest,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure-function unit tests
// ─────────────────────────────────────────────────────────────────────────────

test('flattenA2AUserContent: text + data parts, drops files', () => {
  const out = flattenA2AUserContent([
    { kind: 'text', text: 'hello' },
    { kind: 'data', data: { city: 'Seoul' } },
    { kind: 'file', file: { mimeType: 'image/png', bytes: 'xx' } },
    { kind: 'text', text: 'world' },
  ]);
  assert.ok(out);
  assert.ok(out!.includes('hello'));
  assert.ok(out!.includes('world'));
  assert.ok(out!.includes('Seoul'));
});

test('flattenA2AUserContent: empty / file-only yields null', () => {
  assert.equal(flattenA2AUserContent([]), null);
  assert.equal(
    flattenA2AUserContent([
      { kind: 'file', file: { mimeType: 'image/png', bytes: 'xx' } },
    ]),
    null,
  );
});

test('historyToChatCompletionMessages: assistant tool_calls + tool result round-trip', () => {
  const msgs = historyToChatCompletionMessages([
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Seoul"}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: '{"temp":13}',
      name: 'get_weather',
    },
  ]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'assistant');
  assert.equal(msgs[0].content, null);
  assert.equal((msgs[0].tool_calls as unknown[]).length, 1);
  assert.equal(msgs[1].role, 'tool');
  assert.equal(msgs[1].tool_call_id, 'call_1');
  assert.equal(msgs[1].name, 'get_weather');
  assert.equal(msgs[1].content, '{"temp":13}');
});

test('buildMessages: ordering — system → history → user', () => {
  const msgs = buildMessages(
    {
      system: 'be concise',
      tool_call_history: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'result' },
      ],
    },
    'current ask',
  );
  assert.deepEqual(
    msgs.map((m) => m.role),
    ['system', 'assistant', 'tool', 'user'],
  );
  assert.equal(msgs[0].content, 'be concise');
  assert.equal(msgs[msgs.length - 1].content, 'current ask');
});

test('buildMessages: no metadata still emits a user message', () => {
  const msgs = buildMessages(null, 'hi');
  assert.deepEqual(msgs, [{ role: 'user', content: 'hi' }]);
});

test('buildCallBody: forwards only tools / tool_choice from the existing 4-field schema', () => {
  const body = buildCallBody(
    {
      system: 'sys',
      tools: [{ type: 'function', function: { name: 'x' } }],
      tool_choice: 'auto',
      tool_call_history: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'r' },
      ],
    },
    [{ role: 'user', content: 'q' }],
  );
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'x' } }]);
  assert.equal(body.tool_choice, 'auto');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'q' }]);
  // Nothing else lands on the body — no model, no reasoning_effort, no
  // Group B / Group C fields.
  assert.equal(Object.keys(body).sort().join(','), 'messages,tool_choice,tools');
});

test('buildCallBody: no metadata yields messages-only body', () => {
  const body = buildCallBody(null, [{ role: 'user', content: 'q' }]);
  assert.deepEqual(body, { messages: [{ role: 'user', content: 'q' }] });
});

test('parseChatCompletionUsage: enforces total = prompt + completion', () => {
  const u = parseChatCompletionUsage(
    {
      prompt_tokens: 17,
      completion_tokens: 5,
      total_tokens: 999,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
    'gpt-5.4',
  );
  assert.ok(u);
  assert.equal(u!.prompt_tokens, 17);
  assert.equal(u!.completion_tokens, 5);
  assert.equal(u!.total_tokens, 22);
  assert.equal(u!.model, 'gpt-5.4');
  assert.equal(u!.prompt_tokens_details?.cached_tokens, 3);
  assert.equal(u!.completion_tokens_details?.reasoning_tokens, 2);
});

test('parseChatCompletionUsage: missing primary counts yields null', () => {
  assert.equal(parseChatCompletionUsage(undefined, undefined), null);
  assert.equal(parseChatCompletionUsage({ prompt_tokens: 1 }, undefined), null);
});

test('buildResponseMetadata: includes both usage and chat_completion echo', () => {
  const response: ChatCompletionResponse = {
    id: 'chatcmpl-abc',
    object: 'chat.completion',
    created: 1779177411,
    model: 'gpt-5.4',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  const usage = parseChatCompletionUsage(response.usage, response.model);
  const meta = buildResponseMetadata(response, usage) as Record<
    string,
    Record<string, unknown>
  >;
  const ext = meta[OPENAI_COMPAT_EXTENSION_URI] as Record<string, unknown>;
  assert.ok(ext.usage);
  const echo = ext.chat_completion as Record<string, unknown>;
  assert.equal(echo.id, 'chatcmpl-abc');
  assert.equal(echo.model, 'gpt-5.4');
  assert.equal(echo.created, 1779177411);
  assert.deepEqual(echo.usage, response.usage);
  assert.ok(Array.isArray(echo.choices));
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end Backend.handle() tests via the fake spawn surface
// ─────────────────────────────────────────────────────────────────────────────

function runBackend(
  task: TaskAssignFrame,
  driveChild: (child: FakeChild) => void,
): Promise<UpFrame[]> {
  const fake = makeFakeSpawn();
  const backend = createVicoopCodexBackend({ spawn: fake.spawn });
  const frames: UpFrame[] = [];
  const ctrl = new AbortController();
  const done = backend.handle(task, (f) => frames.push(f), ctrl.signal);
  // Wait one microtask so the backend has spawned its child before we drive
  // it. The fake spawn is synchronous, so a single queueMicrotask suffices.
  return new Promise((resolve, reject) => {
    queueMicrotask(() => {
      try {
        driveChild(fake.lastChild());
      } catch (err) {
        reject(err);
        return;
      }
      done.then(() => resolve(frames), reject);
    });
  });
}

test('handle: success path — text response → artifact + complete with metadata', async () => {
  const task = makeTask({
    metadata: {
      [OPENAI_COMPAT_EXTENSION_URI]: {
        system: 'be concise',
      },
    },
  });
  const frames = await runBackend(task, (child) => {
    const response: ChatCompletionResponse = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1700000000,
      model: 'gpt-5.4',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    };
    child.emitStdout(JSON.stringify(response));
    child.finish(0);
  });

  const statuses = frames.filter((f) => f.type === 'task.status');
  const artifacts = frames.filter((f) => f.type === 'task.artifact');
  const completes = frames.filter((f) => f.type === 'task.complete');
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].status.state, 'working');
  assert.equal(artifacts.length, 1);
  const artifact = artifacts[0];
  if (artifact.type !== 'task.artifact') throw new Error('unreachable');
  assert.equal(artifact.artifact.parts[0].kind, 'text');
  if (artifact.artifact.parts[0].kind !== 'text') throw new Error('unreachable');
  assert.equal(artifact.artifact.parts[0].text, 'ok');
  assert.equal(completes.length, 1);
  const completeFrame = completes[0];
  if (completeFrame.type !== 'task.complete') throw new Error('unreachable');
  assert.equal(completeFrame.status.state, 'completed');
  const msg = completeFrame.status.message!;
  assert.ok(msg.extensions?.includes(OPENAI_COMPAT_EXTENSION_URI));
  const ext = (msg.metadata as Record<string, Record<string, unknown>>)[
    OPENAI_COMPAT_EXTENSION_URI
  ];
  assert.ok(ext.usage);
  const echo = ext.chat_completion as Record<string, unknown>;
  assert.equal(echo.id, 'chatcmpl-1');
  assert.equal(echo.model, 'gpt-5.4');
});

test('handle: tool_calls response → data artifact + no text in status message', async () => {
  const task = makeTask({
    metadata: {
      [OPENAI_COMPAT_EXTENSION_URI]: {
        tools: [{ type: 'function', function: { name: 'list_files' } }],
      },
    },
  });
  const frames = await runBackend(task, (child) => {
    const response: ChatCompletionResponse = {
      id: 'chatcmpl-2',
      object: 'chat.completion',
      created: 1700000001,
      model: 'gpt-5.3-codex',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_xyz',
                type: 'function',
                function: { name: 'list_files', arguments: '{"path":"."}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
    };
    child.emitStdout(JSON.stringify(response));
    child.finish(0);
  });
  const artifacts = frames.filter((f) => f.type === 'task.artifact');
  assert.equal(artifacts.length, 1);
  const artifact = artifacts[0];
  if (artifact.type !== 'task.artifact') throw new Error('unreachable');
  assert.equal(artifact.artifact.parts[0].kind, 'data');
  if (artifact.artifact.parts[0].kind !== 'data') throw new Error('unreachable');
  const data = artifact.artifact.parts[0].data as { tool_calls: unknown[] };
  assert.equal(data.tool_calls.length, 1);
  assert.ok(artifact.artifact.extensions?.includes(OPENAI_COMPAT_EXTENSION_URI));
  const completes = frames.filter((f) => f.type === 'task.complete');
  assert.equal(completes.length, 1);
  const completeFrame = completes[0];
  if (completeFrame.type !== 'task.complete') throw new Error('unreachable');
  // status.message exists but parts must be empty so we don't re-stamp the
  // tool_calls envelope onto the message.
  assert.deepEqual(completeFrame.status.message!.parts, []);
});

test('handle: stdin body carries only system/tools/tool_choice/history-derived messages', async () => {
  const task = makeTask({
    message: {
      role: 'user',
      messageId: 'msg',
      parts: [{ kind: 'text', text: 'current question' }],
      metadata: {
        [OPENAI_COMPAT_EXTENSION_URI]: {
          // The 4-field schema only.
          system: 'reply in korean',
          tools: [{ type: 'function', function: { name: 'get_weather' } }],
          tool_choice: { type: 'function', function: { name: 'get_weather' } },
          tool_call_history: [
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city":"Seoul"}' },
                },
              ],
            },
            { role: 'tool', tool_call_id: 'call_1', content: '{"temp":13}' },
          ],
          // Unknown extension keys must NOT reach the call body — they
          // aren't part of the openai-compat 4-field schema.
          model: 'gpt-5.5',
          reasoning_effort: 'high',
          temperature: 0.7,
          max_tokens: 200,
        },
      },
    },
  });

  await runBackend(task, (child) => {
    const response: ChatCompletionResponse = {
      id: 'chatcmpl-3',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5.5',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const payload = child.stdinPayload();
    const body = JSON.parse(payload) as Record<string, unknown>;
    // Messages: system → assistant(tool_calls) → tool → user
    const messages = body.messages as Array<{ role: string }>;
    assert.deepEqual(
      messages.map((m) => m.role),
      ['system', 'assistant', 'tool', 'user'],
    );
    // Only the existing 4-field schema's `tools` / `tool_choice` are
    // forwarded; the spurious model/reasoning_effort/temperature/max_tokens
    // entries are dropped at the metadata reader.
    assert.deepEqual(body.tools, [
      { type: 'function', function: { name: 'get_weather' } },
    ]);
    assert.deepEqual(body.tool_choice, {
      type: 'function',
      function: { name: 'get_weather' },
    });
    assert.equal(body.model, undefined);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.temperature, undefined);
    assert.equal(body.max_tokens, undefined);
    child.emitStdout(JSON.stringify(response));
    child.finish(0);
  });
});

test('handle: empty prompt → task.fail with empty_prompt code', async () => {
  const task = makeTask({
    message: {
      role: 'user',
      messageId: 'msg',
      parts: [{ kind: 'file', file: { mimeType: 'image/png', bytes: 'xx' } }],
    },
  });
  const fake = makeFakeSpawn();
  const backend = createVicoopCodexBackend({ spawn: fake.spawn });
  const frames: UpFrame[] = [];
  await backend.handle(task, (f) => frames.push(f), new AbortController().signal);
  assert.equal(fake.children.length, 0);
  const fails = frames.filter((f) => f.type === 'task.fail');
  assert.equal(fails.length, 1);
  const failFrame = fails[0];
  if (failFrame.type !== 'task.fail') throw new Error('unreachable');
  assert.equal(failFrame.error.code, 'empty_prompt');
});

test('handle: non-zero exit maps to documented exit-code error codes', async () => {
  const exitCases: Array<{ code: number; expected: string }> = [
    { code: 2, expected: 'invalid_input' },
    { code: 3, expected: 'login_required' },
    { code: 4, expected: 'upstream_error' },
    { code: 5, expected: 'network_error' },
    { code: 99, expected: 'vicoop_codex_failed' },
  ];
  for (const { code, expected } of exitCases) {
    const frames = await runBackend(makeTask(), (child) => {
      child.emitStderr('Error: simulated');
      child.finish(code);
    });
    const fails = frames.filter((f) => f.type === 'task.fail');
    assert.equal(fails.length, 1, `exit code ${code}`);
    const failFrame = fails[0];
    if (failFrame.type !== 'task.fail') throw new Error('unreachable');
    assert.equal(failFrame.error.code, expected, `exit code ${code} → ${expected}`);
    assert.ok(failFrame.error.message.includes('simulated'));
  }
});

test('handle: malformed JSON stdout → parse_failed', async () => {
  const frames = await runBackend(makeTask(), (child) => {
    child.emitStdout('not json at all');
    child.finish(0);
  });
  const fails = frames.filter((f) => f.type === 'task.fail');
  assert.equal(fails.length, 1);
  const failFrame = fails[0];
  if (failFrame.type !== 'task.fail') throw new Error('unreachable');
  assert.equal(failFrame.error.code, 'parse_failed');
});

test('handle: cancel before spawn → task.complete with canceled', async () => {
  const fake = makeFakeSpawn();
  const backend = createVicoopCodexBackend({ spawn: fake.spawn });
  const frames: UpFrame[] = [];
  const ctrl = new AbortController();
  ctrl.abort();
  await backend.handle(makeTask(), (f) => frames.push(f), ctrl.signal);
  assert.equal(fake.children.length, 0);
  assert.equal(frames.length, 1);
  const frame = frames[0];
  if (frame.type !== 'task.complete') throw new Error('unreachable');
  assert.equal(frame.status.state, 'canceled');
});
