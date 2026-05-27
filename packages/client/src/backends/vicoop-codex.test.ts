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
} from './vicoop-codex.js';
import {
  type VicoopCodexChildHandle,
  type VicoopCodexSpawnFn,
  type VicoopCodexSpawnOptions,
} from './vicoop-codex-supervisor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fake `vicoop-codex serve` child — emits the JSON listening banner on stderr
// as the first thing it does (mirroring the real CLI) and otherwise stays
// alive until `finish()` is called. The backend's supervisor scans stderr for
// the listening event to learn the bound port, so the banner must arrive
// after the supervisor attaches its `on('data')` listener — queueMicrotask
// the emit so it fires post-`start()`.
// ─────────────────────────────────────────────────────────────────────────────

interface FakeChild extends VicoopCodexChildHandle {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  killed: boolean;
  killSignal: NodeJS.Signals | null;
  emitStderr(text: string): void;
  emitStdout(text: string): void;
  finish(code: number | null, sig?: NodeJS.Signals | null): void;
}

interface FakeSpawn {
  spawn: VicoopCodexSpawnFn;
  children: FakeChild[];
  lastChild: () => FakeChild;
}

interface FakeSpawnOptions {
  // Test seam: skip the auto-emitted listening banner so a test can drive a
  // startup-failure scenario.
  suppressListeningBanner?: boolean;
  // Test seam: override the port reported in the listening banner. Defaults
  // to a high ephemeral-style value the fake fetch will match on.
  listeningPort?: number;
}

function makeFakeSpawn(spawnOpts: FakeSpawnOptions = {}): FakeSpawn {
  const children: FakeChild[] = [];
  const port = spawnOpts.listeningPort ?? 54321;
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

    const child: FakeChild = {
      command,
      args,
      cwd: options.cwd,
      stdin: null,
      stdout: mkReadable(stdoutEmitter),
      stderr: mkReadable(stderrEmitter),
      killed: false,
      killSignal: null,
      emitStdout(text) {
        stdoutEmitter.emit('data', Buffer.from(text, 'utf8'));
      },
      emitStderr(text) {
        stderrEmitter.emit('data', Buffer.from(text, 'utf8'));
      },
      kill(sig?: NodeJS.Signals) {
        if (closed) return true;
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
        queueMicrotask(() => {
          for (const l of closeListeners) l(code, sig);
        });
      },
    };

    if (!spawnOpts.suppressListeningBanner) {
      queueMicrotask(() => {
        stderrEmitter.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              event: 'listening',
              host: '127.0.0.1',
              port,
              url: `http://127.0.0.1:${port}`,
            }) + '\n',
            'utf8',
          ),
        );
      });
    }

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

// ─────────────────────────────────────────────────────────────────────────────
// Fake fetch + SSE response helpers
// ─────────────────────────────────────────────────────────────────────────────

interface FakeFetchCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

interface FakeFetch {
  fetch: typeof fetch;
  calls: FakeFetchCall[];
}

function makeFakeFetch(
  handler: (
    call: FakeFetchCall,
  ) => Response | Promise<Response>,
): FakeFetch {
  const calls: FakeFetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const i = init ?? {};
    const body = i.body ? (JSON.parse(i.body as string) as Record<string, unknown>) : {};
    const call: FakeFetchCall = { url, init: i, body };
    calls.push(call);
    return await handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function sseResponse(chunks: Array<Record<string, unknown> | '[DONE]'>, status = 200): Response {
  const lines = chunks
    .map((c) => (c === '[DONE]' ? `data: [DONE]\n\n` : `data: ${JSON.stringify(c)}\n\n`))
    .join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function errorResponse(status: number, bodyJson?: Record<string, unknown>): Response {
  return new Response(JSON.stringify(bodyJson ?? { error: { message: `HTTP ${status}` } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

// Drive backend.handle() to completion against the given fake supervisor +
// fake fetch, collecting every emitted frame.
async function runBackend(
  task: TaskAssignFrame,
  fakeSpawn: FakeSpawn,
  fakeFetch: FakeFetch,
  opts: {
    abort?: AbortController;
  } = {},
): Promise<{ frames: UpFrame[]; bundle: ReturnType<typeof createVicoopCodexBackend> }> {
  const bundle = createVicoopCodexBackend({
    spawn: fakeSpawn.spawn,
    fetchImpl: fakeFetch.fetch,
    // Short timeout so misconfigured tests fail fast.
    startupTimeoutMs: 1_000,
  });
  const frames: UpFrame[] = [];
  const ctrl = opts.abort ?? new AbortController();
  await bundle.backend.handle(task, (f) => frames.push(f), ctrl.signal);
  return { frames, bundle };
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
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Seoul"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"temp":13}', name: 'get_weather' },
  ]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'assistant');
  assert.equal(msgs[0].content, null);
  assert.equal((msgs[0].tool_calls as unknown[])?.length, 1);
  assert.equal(msgs[1].role, 'tool');
  assert.equal(msgs[1].tool_call_id, 'call_1');
  assert.equal(msgs[1].name, 'get_weather');
});

test('buildMessages: ordering — system → history → user', () => {
  const out = buildMessages(
    {
      system: 'reply in korean',
      chat_history: [
        { role: 'user', content: 'prior' },
        { role: 'assistant', content: 'prior reply' },
      ],
    },
    'now',
  );
  assert.deepEqual(
    out.map((m) => m.role),
    ['system', 'user', 'assistant', 'user'],
  );
  assert.equal(out[out.length - 1].content, 'now');
});

test('buildMessages: tool-continuation (null userContent) skips trailing user', () => {
  const out = buildMessages(
    {
      chat_history: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'f', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'r' },
      ],
    },
    null,
  );
  assert.deepEqual(
    out.map((m) => m.role),
    ['user', 'assistant', 'tool'],
  );
});

test('buildMessages: no metadata still emits a user message', () => {
  const out = buildMessages(null, 'hi');
  assert.deepEqual(out, [{ role: 'user', content: 'hi' }]);
});

test('buildCallBody: forwards only tools / tool_choice from the existing 4-field schema', () => {
  const out = buildCallBody(
    {
      tools: [{ type: 'function', function: { name: 'f' } }],
      tool_choice: { type: 'function', function: { name: 'f' } },
    },
    [{ role: 'user', content: 'hi' }],
  );
  assert.equal(out.stream, true);
  assert.deepEqual(out.stream_options, { include_usage: true });
  assert.deepEqual(out.tools, [{ type: 'function', function: { name: 'f' } }]);
  assert.deepEqual(out.tool_choice, { type: 'function', function: { name: 'f' } });
});

test('buildCallBody: no metadata yields messages + stream + stream_options', () => {
  const out = buildCallBody(null, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(out.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(out.stream, true);
  assert.deepEqual(out.stream_options, { include_usage: true });
  assert.equal(out.tools, undefined);
  assert.equal(out.tool_choice, undefined);
});

test('parseChatCompletionUsage: enforces total = prompt + completion', () => {
  const u = parseChatCompletionUsage(
    { prompt_tokens: 7, completion_tokens: 3, total_tokens: 9999 },
    'gpt-5.4',
  );
  assert.ok(u);
  assert.equal(u!.prompt_tokens, 7);
  assert.equal(u!.completion_tokens, 3);
  assert.equal(u!.total_tokens, 10);
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
// Backend.handle() integration tests (mock supervisor + mock fetch)
// ─────────────────────────────────────────────────────────────────────────────

test('handle: streams text deltas as appended artifacts and emits complete with metadata', async () => {
  const fakeSpawn = makeFakeSpawn();
  const fakeFetch = makeFakeFetch((_call) =>
    sseResponse([
      { id: 'chatcmpl-1', model: 'gpt-5.4', created: 1700000000, choices: [{ index: 0, delta: { role: 'assistant' } }] },
      { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'Hello' } }] },
      { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: ' world' } }] },
      { id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'chatcmpl-1', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, choices: [] },
      '[DONE]',
    ]),
  );

  const { frames, bundle } = await runBackend(makeTask(), fakeSpawn, fakeFetch);
  await bundle.shutdown();

  const artifacts = frames.filter((f) => f.type === 'task.artifact');
  assert.ok(artifacts.length >= 3, `expected at least 3 artifact frames, got ${artifacts.length}`);
  // First delta: append unset, lastChunk false.
  const first = artifacts[0];
  if (first.type !== 'task.artifact') throw new Error('unreachable');
  assert.equal(first.append, undefined);
  assert.equal(first.lastChunk, false);
  if (first.artifact.parts[0].kind !== 'text') throw new Error('unreachable');
  assert.equal(first.artifact.parts[0].text, 'Hello');
  // Subsequent deltas share the artifactId and set append:true.
  const second = artifacts[1];
  if (second.type !== 'task.artifact') throw new Error('unreachable');
  assert.equal(second.append, true);
  assert.equal(second.lastChunk, false);
  assert.equal(second.artifact.artifactId, first.artifact.artifactId);
  // Final artifact carries lastChunk:true.
  const last = artifacts[artifacts.length - 1];
  if (last.type !== 'task.artifact') throw new Error('unreachable');
  assert.equal(last.lastChunk, true);
  assert.equal(last.artifact.artifactId, first.artifact.artifactId);

  const completes = frames.filter((f) => f.type === 'task.complete');
  assert.equal(completes.length, 1);
  const c = completes[0];
  if (c.type !== 'task.complete') throw new Error('unreachable');
  assert.equal(c.status.state, 'completed');
  const msg = c.status.message!;
  if (msg.parts[0].kind !== 'text') throw new Error('unreachable');
  assert.equal(msg.parts[0].text, 'Hello world');
  const ext = (msg.metadata as Record<string, Record<string, unknown>>)[
    OPENAI_COMPAT_EXTENSION_URI
  ];
  assert.ok(ext.usage);
  const echo = ext.chat_completion as Record<string, unknown>;
  assert.equal(echo.id, 'chatcmpl-1');
  assert.equal(echo.model, 'gpt-5.4');
});

test('handle: tool_calls streamed across deltas → assembled, data artifact, no text in complete', async () => {
  const fakeSpawn = makeFakeSpawn();
  const fakeFetch = makeFakeFetch((_call) =>
    sseResponse([
      {
        id: 'chatcmpl-2',
        model: 'gpt-5.3-codex',
        created: 1700000001,
        choices: [{ index: 0, delta: { role: 'assistant' } }],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_xyz',
                  type: 'function',
                  function: { name: 'list_files', arguments: '{"path"' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: ':"."}' } }] },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }, choices: [] },
      '[DONE]',
    ]),
  );

  const { frames, bundle } = await runBackend(
    makeTask({
      metadata: {
        [OPENAI_COMPAT_EXTENSION_URI]: {
          tools: [{ type: 'function', function: { name: 'list_files' } }],
        },
      },
    }),
    fakeSpawn,
    fakeFetch,
  );
  await bundle.shutdown();

  const artifacts = frames.filter((f) => f.type === 'task.artifact');
  assert.equal(artifacts.length, 1);
  const a = artifacts[0];
  if (a.type !== 'task.artifact') throw new Error('unreachable');
  if (a.artifact.parts[0].kind !== 'data') throw new Error('unreachable');
  const data = a.artifact.parts[0].data as {
    tool_calls: Array<{ id: string; function: { name: string; arguments: string } }>;
  };
  assert.equal(data.tool_calls.length, 1);
  assert.equal(data.tool_calls[0].id, 'call_xyz');
  assert.equal(data.tool_calls[0].function.name, 'list_files');
  // Arguments concatenated across deltas.
  assert.equal(data.tool_calls[0].function.arguments, '{"path":"."}');
  assert.ok(a.artifact.extensions?.includes(OPENAI_COMPAT_EXTENSION_URI));

  const c = frames.find((f) => f.type === 'task.complete');
  if (!c || c.type !== 'task.complete') throw new Error('unreachable');
  // No text duplicated into the completion message.
  assert.deepEqual(c.status.message!.parts, []);
  const ext = (c.status.message!.metadata as Record<
    string,
    Record<string, unknown>
  >)[OPENAI_COMPAT_EXTENSION_URI];
  const echo = ext.chat_completion as Record<string, unknown>;
  const choice = (echo.choices as Array<{ finish_reason?: string }>)[0];
  assert.equal(choice.finish_reason, 'tool_calls');
});

test('handle: POST body carries stream:true + only system/tools/tool_choice/history-derived messages', async () => {
  const fakeSpawn = makeFakeSpawn();
  const fakeFetch = makeFakeFetch((_call) =>
    sseResponse([
      { id: 'chatcmpl-3', model: 'gpt-5.5', created: 1, choices: [{ index: 0, delta: { content: 'ok' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, choices: [] },
      '[DONE]',
    ]),
  );

  const task = makeTask({
    message: {
      role: 'user',
      messageId: 'msg',
      parts: [{ kind: 'text', text: 'current question' }],
      metadata: {
        [OPENAI_COMPAT_EXTENSION_URI]: {
          system: 'reply in korean',
          tools: [{ type: 'function', function: { name: 'get_weather' } }],
          tool_choice: { type: 'function', function: { name: 'get_weather' } },
          chat_history: [
            {
              role: 'assistant',
              content: null,
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
          // Unknown extension keys must NOT reach the call body.
          model: 'gpt-5.5',
          reasoning_effort: 'high',
          temperature: 0.7,
          max_tokens: 200,
        },
      },
    },
  });

  const { bundle } = await runBackend(task, fakeSpawn, fakeFetch);
  await bundle.shutdown();

  assert.equal(fakeFetch.calls.length, 1);
  const sent = fakeFetch.calls[0];
  assert.equal(sent.url.endsWith('/v1/chat/completions'), true);
  assert.equal(sent.body.stream, true);
  assert.deepEqual(sent.body.stream_options, { include_usage: true });
  const messages = sent.body.messages as Array<{ role: string }>;
  assert.deepEqual(
    messages.map((m) => m.role),
    ['system', 'assistant', 'tool', 'user'],
  );
  assert.deepEqual(sent.body.tools, [
    { type: 'function', function: { name: 'get_weather' } },
  ]);
  assert.deepEqual(sent.body.tool_choice, {
    type: 'function',
    function: { name: 'get_weather' },
  });
  assert.equal(sent.body.model, undefined);
  assert.equal(sent.body.reasoning_effort, undefined);
  assert.equal(sent.body.temperature, undefined);
  assert.equal(sent.body.max_tokens, undefined);
});

test('handle: empty prompt → task.fail with empty_prompt code, no fetch made', async () => {
  const fakeSpawn = makeFakeSpawn();
  const fakeFetch = makeFakeFetch(() => {
    throw new Error('fetch should not be called');
  });
  const { frames, bundle } = await runBackend(
    makeTask({
      message: {
        role: 'user',
        messageId: 'msg',
        parts: [{ kind: 'file', file: { mimeType: 'image/png', bytes: 'xx' } }],
      },
    }),
    fakeSpawn,
    fakeFetch,
  );
  await bundle.shutdown();
  const fails = frames.filter((f) => f.type === 'task.fail');
  assert.equal(fails.length, 1);
  const failFrame = fails[0];
  if (failFrame.type !== 'task.fail') throw new Error('unreachable');
  assert.equal(failFrame.error.code, 'empty_prompt');
  // Supervisor never spawned because we bailed before ensureSupervisor.
  assert.equal(fakeSpawn.children.length, 0);
});

test('handle: upstream HTTP 401 → login_required', async () => {
  const fakeSpawn = makeFakeSpawn();
  const fakeFetch = makeFakeFetch(() =>
    errorResponse(401, { error: { message: 'not signed in' } }),
  );
  const { frames, bundle } = await runBackend(makeTask(), fakeSpawn, fakeFetch);
  await bundle.shutdown();
  const fails = frames.filter((f) => f.type === 'task.fail');
  assert.equal(fails.length, 1);
  const failFrame = fails[0];
  if (failFrame.type !== 'task.fail') throw new Error('unreachable');
  assert.equal(failFrame.error.code, 'login_required');
  assert.ok(failFrame.error.message.includes('not signed in'));
});

test('handle: upstream HTTP 429 → rate_limited', async () => {
  const fakeSpawn = makeFakeSpawn();
  const fakeFetch = makeFakeFetch(() =>
    errorResponse(429, { error: { message: 'slow down' } }),
  );
  const { frames, bundle } = await runBackend(makeTask(), fakeSpawn, fakeFetch);
  await bundle.shutdown();
  const failFrame = frames.find((f) => f.type === 'task.fail');
  if (!failFrame || failFrame.type !== 'task.fail') throw new Error('unreachable');
  assert.equal(failFrame.error.code, 'rate_limited');
});

test('handle: upstream HTTP 502 → upstream_http_502', async () => {
  const fakeSpawn = makeFakeSpawn();
  const fakeFetch = makeFakeFetch(() => errorResponse(502, { error: { message: 'bad gateway' } }));
  const { frames, bundle } = await runBackend(makeTask(), fakeSpawn, fakeFetch);
  await bundle.shutdown();
  const failFrame = frames.find((f) => f.type === 'task.fail');
  if (!failFrame || failFrame.type !== 'task.fail') throw new Error('unreachable');
  assert.equal(failFrame.error.code, 'upstream_http_502');
});

test('handle: mid-stream error event → stream_error', async () => {
  const fakeSpawn = makeFakeSpawn();
  const fakeFetch = makeFakeFetch(() =>
    sseResponse([
      { id: 'chatcmpl-x', choices: [{ index: 0, delta: { content: 'partial' } }] },
      { error: { message: 'upstream went away' } },
    ]),
  );
  const { frames, bundle } = await runBackend(makeTask(), fakeSpawn, fakeFetch);
  await bundle.shutdown();
  const failFrame = frames.find((f) => f.type === 'task.fail');
  if (!failFrame || failFrame.type !== 'task.fail') throw new Error('unreachable');
  assert.equal(failFrame.error.code, 'stream_error');
  assert.ok(failFrame.error.message.includes('upstream went away'));
});

test('handle: cancel before spawn → task.complete with canceled, no child', async () => {
  const fakeSpawn = makeFakeSpawn();
  const fakeFetch = makeFakeFetch(() => {
    throw new Error('fetch should not be called');
  });
  const ctrl = new AbortController();
  ctrl.abort();
  const { frames, bundle } = await runBackend(makeTask(), fakeSpawn, fakeFetch, { abort: ctrl });
  await bundle.shutdown();
  assert.equal(fakeSpawn.children.length, 0);
  assert.equal(frames.length, 1);
  const frame = frames[0];
  if (frame.type !== 'task.complete') throw new Error('unreachable');
  assert.equal(frame.status.state, 'canceled');
});

test('handle: supervisor that never emits listening banner → cli_unavailable on startup timeout', async () => {
  const fakeSpawn = makeFakeSpawn({ suppressListeningBanner: true });
  const fakeFetch = makeFakeFetch(() => {
    throw new Error('fetch should not be called');
  });
  const bundle = createVicoopCodexBackend({
    spawn: fakeSpawn.spawn,
    fetchImpl: fakeFetch.fetch,
    startupTimeoutMs: 50,
  });
  const frames: UpFrame[] = [];
  await bundle.backend.handle(makeTask(), (f) => frames.push(f), new AbortController().signal);
  await bundle.shutdown();
  const failFrame = frames.find((f) => f.type === 'task.fail');
  if (!failFrame || failFrame.type !== 'task.fail') throw new Error('unreachable');
  assert.equal(failFrame.error.code, 'cli_unavailable');
});

test('handle: second task reuses the same supervisor child', async () => {
  const fakeSpawn = makeFakeSpawn();
  let callIdx = 0;
  const fakeFetch = makeFakeFetch(() => {
    callIdx++;
    return sseResponse([
      { id: `chatcmpl-${callIdx}`, choices: [{ index: 0, delta: { content: 'ok' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, choices: [] },
      '[DONE]',
    ]);
  });

  const bundle = createVicoopCodexBackend({
    spawn: fakeSpawn.spawn,
    fetchImpl: fakeFetch.fetch,
    startupTimeoutMs: 1_000,
  });
  await bundle.backend.handle(makeTask(), () => {}, new AbortController().signal);
  await bundle.backend.handle(
    makeTask({ taskId: 'task-2' }),
    () => {},
    new AbortController().signal,
  );
  await bundle.shutdown();

  assert.equal(fakeSpawn.children.length, 1);
  assert.equal(fakeFetch.calls.length, 2);
});

test('handle: supervisor that died between tasks is respawned on next task', async () => {
  const fakeSpawn = makeFakeSpawn();
  const fakeFetch = makeFakeFetch(() =>
    sseResponse([
      { id: 'x', choices: [{ index: 0, delta: { content: 'ok' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, choices: [] },
      '[DONE]',
    ]),
  );

  const bundle = createVicoopCodexBackend({
    spawn: fakeSpawn.spawn,
    fetchImpl: fakeFetch.fetch,
    startupTimeoutMs: 1_000,
  });
  await bundle.backend.handle(makeTask(), () => {}, new AbortController().signal);
  // Kill the supervisor child.
  fakeSpawn.lastChild().finish(0);
  // Wait for the close handler to nullify the singleton.
  await new Promise((r) => setImmediate(r));
  await bundle.backend.handle(
    makeTask({ taskId: 'task-2' }),
    () => {},
    new AbortController().signal,
  );
  await bundle.shutdown();

  assert.equal(fakeSpawn.children.length, 2);
});
