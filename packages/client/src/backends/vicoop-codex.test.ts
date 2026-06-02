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
  parseServeListeningUrl,
  probeVicoopCodexModels,
  type ChatCompletionResponse,
  type VicoopCodexChildHandle,
  type VicoopCodexFetchFn,
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
      content: null,
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

test('historyToChatCompletionMessages: prior user/assistant text turns round-trip', () => {
  // New chat_history shape carries every prior turn — plain text turns
  // map 1:1 to Chat Completions messages.
  const msgs = historyToChatCompletionMessages([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].content, 'hi');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].content, 'hello');
});

test('buildMessages: ordering — system → history → user', () => {
  const msgs = buildMessages(
    'be concise',
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
    ],
    'current ask',
  );
  assert.deepEqual(
    msgs.map((m) => m.role),
    ['system', 'assistant', 'tool', 'user'],
  );
  assert.equal(msgs[0].content, 'be concise');
  assert.equal(msgs[msgs.length - 1].content, 'current ask');
});

test('buildMessages: multi-turn tool-loop scenario from PR #289 keeps opening user at the head', () => {
  // Regression guard for the gpt-5.3-codex re-call loop fixed by
  // PR #289 (fix/vicoop-codex-user-turn-order). On the old
  // `tool_call_history` wire that PR worked against, the prior tool
  // round-trips were the only entries in metadata and the originating
  // user request was nowhere in the assembled `messages` — so the
  // model saw `[system, asst.tc, tool, asst.tc, tool, …, user]` and
  // re-interpreted the trailing user as a fresh imperative, restarting
  // from `list_workflows` on every turn.
  //
  // The new `chat_history` wire fixes this at the source: the gateway
  // includes EVERY prior turn except the trailing user (so the
  // originating user request is the first history entry). With
  // `buildMessages` emitting `system → chat_history → trailing_user`,
  // the assembled messages preserve the linear OpenAI conversation
  // order automatically — no manual re-ordering needed.
  //
  // This test pins that invariant: the originating user request MUST
  // be at index 1 (right after system), and the trailing user MUST be
  // last, regardless of how many tool round-trips sit between them.
  const msgs = buildMessages(
    'be concise',
    [
      { role: 'user', content: 'list workflows then run X' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', function: { name: 'list_workflows', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '[…]' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c2', function: { name: 'execute', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c2', content: 'started' },
    ],
    'how is it going?',
  );
  assert.deepEqual(
    msgs.map((m) => m.role),
    ['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'user'],
  );
  // Opening user at index 1 — the original request the tool rounds were
  // driven by. The model needs to see this BEFORE any tool activity or
  // it loses the thread and re-emits the first call.
  assert.equal(msgs[1].content, 'list workflows then run X');
  // Trailing user at the tail — the new question on this turn.
  assert.equal(msgs[msgs.length - 1].content, 'how is it going?');
});

test('buildMessages: tool-continuation (null userContent) skips trailing user', () => {
  // openai-compat spec edge case: when A2A parts is the empty
  // placeholder, the caller passes null userContent and chat_history
  // carries the full conversation including the trailing tool result.
  const msgs = buildMessages(
    undefined,
    [
      { role: 'user', content: 'kick off' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
    ],
    null,
  );
  assert.deepEqual(
    msgs.map((m) => m.role),
    ['user', 'assistant', 'tool'],
  );
});

test('buildMessages: no metadata still emits a user message', () => {
  const msgs = buildMessages(undefined, null, 'hi');
  assert.deepEqual(msgs, [{ role: 'user', content: 'hi' }]);
});

test('buildCallBody: forwards model / tools / tool_choice from the envelope', () => {
  const body = buildCallBody(
    {
      model: 'gpt-5.4',
      tools: [{ type: 'function', function: { name: 'x' } }],
      tool_choice: 'auto',
      messages: [],
    },
    [{ role: 'user', content: 'q' }],
  );
  assert.equal(body.model, 'gpt-5.4');
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'x' } }]);
  assert.equal(body.tool_choice, 'auto');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'q' }]);
  // Nothing else lands on the body — no reasoning_effort, no Group B /
  // Group C fields.
  assert.equal(
    Object.keys(body).sort().join(','),
    'messages,model,tool_choice,tools',
  );
});

test('buildCallBody: envelope without model omits the model field', () => {
  const body = buildCallBody(
    { tools: [{ type: 'function', function: { name: 'x' } }], messages: [] },
    [{ role: 'user', content: 'q' }],
  );
  assert.equal(body.model, undefined);
  assert.ok(body.tools);
});

test('buildCallBody: no envelope yields messages-only body', () => {
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

test('buildResponseMetadata: chat_completion envelope carries spec-required fields + normalized usage', () => {
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
  const meta = buildResponseMetadata(response, usage, 'task-xyz') as Record<
    string,
    Record<string, unknown>
  >;
  const ext = meta[OPENAI_COMPAT_EXTENSION_URI] as Record<string, unknown>;
  // Envelope contract: usage lives inside chat_completion.usage. The
  // transitional top-level `usage` sibling for v1-era codecs has been
  // retired — only `chat_completion` is stamped on openai-compat tasks.
  assert.equal(ext.usage, undefined);
  const envelope = ext.chat_completion as Record<string, unknown>;
  assert.equal(envelope.id, 'chatcmpl-abc');
  assert.equal(envelope.object, 'chat.completion');
  assert.equal(envelope.model, 'gpt-5.4');
  assert.equal(envelope.created, 1779177411);
  // chat_completion.usage carries the normalized OpenAICompatUsage
  // (with the spec-mandated total === prompt + completion invariant).
  assert.deepEqual(envelope.usage, usage);
  // logprobs must be present on each choice per the spec (defaults to null
  // when the underlying runtime doesn't surface them — which vicoop-codex
  // never does today).
  const choices = envelope.choices as Array<Record<string, unknown>>;
  assert.equal(choices.length, 1);
  assert.equal(choices[0].logprobs, null);
  assert.equal(choices[0].finish_reason, 'stop');
});

test('buildResponseMetadata: synthesizes defensive defaults when upstream omits id/object/created/model', () => {
  // Advertising agents SHOULD always emit a complete envelope, but a wrapper
  // bug shouldn't break OpenAI clients downstream — the codec relies on
  // these fields being present.
  const response: ChatCompletionResponse = {
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      },
    ],
  };
  const meta = buildResponseMetadata(response, null, 'task-fallback') as Record<
    string,
    Record<string, unknown>
  >;
  const envelope = (meta[OPENAI_COMPAT_EXTENSION_URI] as Record<string, unknown>)
    .chat_completion as Record<string, unknown>;
  assert.equal(envelope.id, 'chatcmpl-vicoop-codex-task-fallback');
  assert.equal(envelope.object, 'chat.completion');
  assert.equal(typeof envelope.created, 'number');
  assert.equal(envelope.model, 'vicoop-codex');
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end Backend.handle() tests via the fake spawn surface
// ─────────────────────────────────────────────────────────────────────────────

// ── Streaming HTTP fake ──────────────────────────────────────────────────
// The backend now drives each task through `vicoop-codex serve`'s
// `/v1/chat/completions` over `fetch`, parsing a `chat.completion.chunk` SSE
// stream. These fakes script the serve child's `listening` line (via the
// spawn fake) and the SSE body (via an injected `fetch`).

interface RecordingFetch {
  fetch: VicoopCodexFetchFn;
  calls: Array<{ url: string; body: string }>;
}

// A fetch that records each request and returns a fixed SSE body. `status`
// < 200 || >= 300 marks the response not-ok (drives the upstream_error path);
// `bodyText` is what `.text()` returns on that error path.
function makeSseFetch(
  sse: string,
  opts: { status?: number; bodyText?: string } = {},
): RecordingFetch {
  const calls: Array<{ url: string; body: string }> = [];
  const status = opts.status ?? 200;
  const fetch: VicoopCodexFetchFn = async (url, init) => {
    calls.push({ url, body: init.body });
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return opts.bodyText ?? '';
      },
      async *chunks() {
        yield sse;
      },
    };
  };
  return { fetch, calls };
}

// Serialise a list of chunk objects into an SSE body terminated by `[DONE]`.
function sseStream(chunks: Array<Record<string, unknown>>): string {
  return (
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  );
}

// Emit the `listening` line a freshly-spawned serve child prints. The real
// `vicoop-codex serve` writes this (and all startup text) to STDERR, so the
// fake drives it there to match production wiring.
function driveServeListening(child: FakeChild, port = 8787): void {
  child.emitStderr(
    JSON.stringify({
      event: 'listening',
      host: '127.0.0.1',
      port,
      url: `http://127.0.0.1:${port}`,
    }) + '\n',
  );
}

// Run handle() end-to-end with a serve + fetch fake. `handle()` spawns the
// serve child synchronously inside `ensureServe`, so we drive its listening
// line on the next microtask, then await completion.
async function runStreaming(
  task: TaskAssignFrame,
  fetchRec: RecordingFetch,
): Promise<UpFrame[]> {
  const fake = makeFakeSpawn();
  const backend = createVicoopCodexBackend({
    spawn: fake.spawn,
    fetch: fetchRec.fetch,
  });
  const frames: UpFrame[] = [];
  const ctrl = new AbortController();
  const done = backend.handle(task, (f) => frames.push(f), ctrl.signal);
  await new Promise<void>((resolve, reject) => {
    queueMicrotask(() => {
      try {
        driveServeListening(fake.lastChild());
      } catch (err) {
        reject(err as Error);
        return;
      }
      done.then(() => resolve(), reject);
    });
  });
  return frames;
}

test('parseServeListeningUrl: reads the listening line, ignores other lines', () => {
  assert.equal(
    parseServeListeningUrl(
      '{"event":"listening","host":"127.0.0.1","port":8787,"url":"http://127.0.0.1:8787"}',
    ),
    'http://127.0.0.1:8787',
  );
  // Falls back to host+port when `url` is absent; strips a trailing slash.
  assert.equal(
    parseServeListeningUrl('{"event":"listening","host":"127.0.0.1","port":9000}'),
    'http://127.0.0.1:9000',
  );
  assert.equal(parseServeListeningUrl('vicoop-codex serve listening on:'), null);
  assert.equal(parseServeListeningUrl('{"event":"other"}'), null);
  assert.equal(parseServeListeningUrl('not json'), null);
});

test('handle: streamed text → one append artifact per delta + complete with metadata', async () => {
  const task = makeTask({
    metadata: {
      [OPENAI_COMPAT_EXTENSION_URI]: {
        system: 'be concise',
      },
    },
  });
  // `chat.completion.chunk` SSE: role preamble → two content deltas → final
  // chunk carrying finish_reason + usage.
  const sse = sseStream([
    {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'gpt-5.4',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    },
    {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      model: 'gpt-5.4',
      choices: [{ index: 0, delta: { content: 'o' }, finish_reason: null }],
    },
    {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      model: 'gpt-5.4',
      choices: [{ index: 0, delta: { content: 'k' }, finish_reason: null }],
    },
    {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      model: 'gpt-5.4',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    },
  ]);
  const frames = await runStreaming(task, makeSseFetch(sse));

  const statuses = frames.filter((f) => f.type === 'task.status');
  const artifacts = frames.filter((f) => f.type === 'task.artifact');
  const completes = frames.filter((f) => f.type === 'task.complete');
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].status.state, 'working');
  // One incremental append artifact per content delta.
  assert.equal(artifacts.length, 2);
  const texts: string[] = [];
  const ids = new Set<string>();
  for (const a of artifacts) {
    if (a.type !== 'task.artifact') throw new Error('unreachable');
    assert.equal(a.append, true, 'streamed deltas are append:true');
    const part = a.artifact.parts[0];
    if (part.kind !== 'text') throw new Error('unreachable');
    texts.push(part.text);
    ids.add(a.artifact.artifactId);
  }
  assert.deepEqual(texts, ['o', 'k']);
  // All deltas share one artifactId so the server merges them into one
  // artifact (and the gateway into one OpenAI message).
  assert.equal(ids.size, 1);

  assert.equal(completes.length, 1);
  const completeFrame = completes[0];
  if (completeFrame.type !== 'task.complete') throw new Error('unreachable');
  assert.equal(completeFrame.status.state, 'completed');
  const msg = completeFrame.status.message!;
  // Terminal message carries the full assembled text for A2A history /
  // non-streaming consumers.
  assert.deepEqual(msg.parts, [{ kind: 'text', text: 'ok' }]);
  assert.ok(msg.extensions?.includes(OPENAI_COMPAT_EXTENSION_URI));
  const ext = (msg.metadata as Record<string, Record<string, unknown>>)[
    OPENAI_COMPAT_EXTENSION_URI
  ];
  assert.equal(ext.usage, undefined);
  const envelope = ext.chat_completion as Record<string, unknown>;
  assert.equal(envelope.id, 'chatcmpl-1');
  assert.equal(envelope.model, 'gpt-5.4');
  const envelopeUsage = envelope.usage as Record<string, number>;
  assert.equal(envelopeUsage.prompt_tokens, 3);
  assert.equal(envelopeUsage.completion_tokens, 1);
  assert.equal(envelopeUsage.total_tokens, 4);
  const choices = envelope.choices as Array<Record<string, unknown>>;
  assert.equal(choices.length, 1);
  assert.equal(choices[0].logprobs, null);
  assert.equal(choices[0].finish_reason, 'stop');
  const choiceMsg = choices[0].message as Record<string, unknown>;
  assert.equal(choiceMsg.content, 'ok');
});

test('handle: request body carries stream:true + envelope-derived model/messages/tools', async () => {
  const task = makeTask({
    message: {
      role: 'user',
      messageId: 'msg',
      parts: [{ kind: 'text', text: 'current question' }],
      metadata: {
        [OPENAI_COMPAT_EXTENSION_URI]: {
          chat_completions_request: {
            model: 'gpt-5.5',
            messages: [
              { role: 'system', content: 'reply in korean' },
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
              { role: 'user', content: 'current question' },
            ],
            tools: [{ type: 'function', function: { name: 'get_weather' } }],
            tool_choice: { type: 'function', function: { name: 'get_weather' } },
          },
        },
      },
    },
  });
  const sse = sseStream([
    {
      id: 'chatcmpl-3',
      object: 'chat.completion.chunk',
      model: 'gpt-5.5',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ]);
  const fetchRec = makeSseFetch(sse);
  await runStreaming(task, fetchRec);

  assert.equal(fetchRec.calls.length, 1);
  assert.ok(fetchRec.calls[0].url.endsWith('/v1/chat/completions'));
  const body = JSON.parse(fetchRec.calls[0].body) as Record<string, unknown>;
  // Streaming flag is set on the wire.
  assert.equal(body.stream, true);
  // `stream_options.include_usage` is forced on so `vicoop-codex serve` is
  // contractually obliged to emit the terminal usage chunk — without it the
  // runtime may drop usage on some turns, silently $0-billing downstream
  // (#317).
  assert.deepEqual(body.stream_options, { include_usage: true });
  // Messages: system → chat_history (assistant(tool_calls) → tool) →
  // trailing user.
  const messages = body.messages as Array<{ role: string }>;
  assert.deepEqual(
    messages.map((m) => m.role),
    ['system', 'assistant', 'tool', 'user'],
  );
  assert.equal(body.model, 'gpt-5.5');
  assert.deepEqual(body.tools, [
    { type: 'function', function: { name: 'get_weather' } },
  ]);
  assert.deepEqual(body.tool_choice, {
    type: 'function',
    function: { name: 'get_weather' },
  });
  // Group B / Group C fields stay off the wire — the binary applies defaults.
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.temperature, undefined);
  assert.equal(body.max_tokens, undefined);
});

test('handle: streamed tool_calls → no artifact; tool_calls only on terminal chat_completion envelope (envelope contract, oai2a2a#80)', async () => {
  const task = makeTask({
    metadata: {
      [OPENAI_COMPAT_EXTENSION_URI]: {
        tools: [{ type: 'function', function: { name: 'list_files' } }],
      },
    },
  });
  // Tool-call stream: role preamble (content null) → tool_calls delta (with
  // arguments split across two fragments to exercise the accumulator) →
  // terminal finish_reason + usage.
  const sse = sseStream([
    {
      id: 'chatcmpl-2',
      object: 'chat.completion.chunk',
      created: 1700000001,
      model: 'gpt-5.3-codex',
      choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }],
    },
    {
      id: 'chatcmpl-2',
      object: 'chat.completion.chunk',
      model: 'gpt-5.3-codex',
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
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl-2',
      object: 'chat.completion.chunk',
      model: 'gpt-5.3-codex',
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: ':"."}' } }] },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl-2',
      object: 'chat.completion.chunk',
      model: 'gpt-5.3-codex',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
    },
  ]);
  const frames = await runStreaming(task, makeSseFetch(sse));
  // Envelope contract: no data-part `tool_calls` artifact. The legacy
  // `data` part shaped `{ "tool_calls": [...] }` is removed from this
  // extension — consumers ignore it, so emitting it would only confuse
  // non-OpenAI A2A inspectors.
  const dataArtifacts = frames.filter(
    (f) =>
      f.type === 'task.artifact' &&
      (f.artifact.parts[0] as { kind?: string })?.kind === 'data',
  );
  assert.equal(
    dataArtifacts.length,
    0,
    'no data-part tool_calls artifact under the envelope contract',
  );
  // No text artifact either when there's no text content to surface
  // (content: null on a tool_calls turn).
  const textArtifacts = frames.filter(
    (f) =>
      f.type === 'task.artifact' &&
      (f.artifact.parts[0] as { kind?: string })?.kind === 'text',
  );
  assert.equal(textArtifacts.length, 0);

  const completes = frames.filter((f) => f.type === 'task.complete');
  assert.equal(completes.length, 1);
  const completeFrame = completes[0];
  if (completeFrame.type !== 'task.complete') throw new Error('unreachable');
  // status.message exists but parts must be empty so we don't re-stamp the
  // tool_calls envelope onto the message (A2A: "Messages SHOULD NOT be
  // used to deliver task outputs").
  assert.deepEqual(completeFrame.status.message!.parts, []);
  // The chat_completion envelope is the sole recovery wire for tool_calls.
  const ext = (completeFrame.status.message!.metadata as Record<
    string,
    Record<string, unknown>
  >)[OPENAI_COMPAT_EXTENSION_URI];
  const envelope = ext.chat_completion as Record<string, unknown>;
  const choices = envelope.choices as Array<{
    message: { role: string; content: unknown; tool_calls?: Array<Record<string, unknown>> };
    finish_reason: string;
    logprobs: unknown;
  }>;
  assert.equal(choices.length, 1);
  assert.equal(choices[0].finish_reason, 'tool_calls');
  assert.equal(choices[0].logprobs, null);
  assert.equal(choices[0].message.role, 'assistant');
  assert.equal(choices[0].message.content, null);
  const calls = choices[0].message.tool_calls!;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'call_xyz');
  assert.equal(calls[0].type, 'function');
  const fn = calls[0].function as { name: string; arguments: string };
  assert.equal(fn.name, 'list_files');
  // OpenAI spec: arguments is a JSON-encoded string (vicoop-codex CLI
  // already emits it that way).
  assert.equal(fn.arguments, '{"path":"."}');
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

test('handle: serve exits before listening → task.fail serve_unavailable', async () => {
  // Simulates an old binary that has no `serve` subcommand (exits non-zero
  // with usage on stderr) — startup never reports listening.
  const fake = makeFakeSpawn();
  const backend = createVicoopCodexBackend({
    spawn: fake.spawn,
    fetch: makeSseFetch('').fetch,
  });
  const frames: UpFrame[] = [];
  const ctrl = new AbortController();
  const done = backend.handle(makeTask(), (f) => frames.push(f), ctrl.signal);
  await new Promise<void>((resolve, reject) => {
    queueMicrotask(() => {
      const child = fake.lastChild();
      child.emitStderr("error: unknown command 'serve'");
      child.finish(1);
      done.then(() => resolve(), reject);
    });
  });
  const fails = frames.filter((f) => f.type === 'task.fail');
  assert.equal(fails.length, 1);
  const failFrame = fails[0];
  if (failFrame.type !== 'task.fail') throw new Error('unreachable');
  assert.equal(failFrame.error.code, 'serve_unavailable');
  assert.ok(failFrame.error.message.includes('serve'));
});

test('handle: non-2xx from serve → task.fail upstream_error', async () => {
  const frames = await runStreaming(
    makeTask(),
    makeSseFetch('', { status: 500, bodyText: 'model overloaded' }),
  );
  const fails = frames.filter((f) => f.type === 'task.fail');
  assert.equal(fails.length, 1);
  const failFrame = fails[0];
  if (failFrame.type !== 'task.fail') throw new Error('unreachable');
  assert.equal(failFrame.error.code, 'upstream_error');
  assert.ok(failFrame.error.message.includes('500'));
  assert.ok(failFrame.error.message.includes('overloaded'));
});

test('handle: serve is a shared singleton — two tasks reuse one server', async () => {
  const fake = makeFakeSpawn();
  const sse = sseStream([
    {
      id: 'c',
      object: 'chat.completion.chunk',
      model: 'gpt-5.4',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ]);
  const fetchRec = makeSseFetch(sse);
  const backend = createVicoopCodexBackend({ spawn: fake.spawn, fetch: fetchRec.fetch });

  const runOne = async (): Promise<UpFrame[]> => {
    const frames: UpFrame[] = [];
    const done = backend.handle(makeTask(), (f) => frames.push(f), new AbortController().signal);
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(() => {
        // Drive the listening line only on the first spawn; a second task
        // reuses the already-listening singleton (lastChild stays the same
        // serve child, and re-driving is an inert no-op).
        driveServeListening(fake.lastChild());
        done.then(() => resolve(), reject);
      });
    });
    return frames;
  };

  const first = await runOne();
  const second = await runOne();

  // Exactly one serve child spawned across both tasks.
  assert.equal(fake.children.length, 1);
  // Both tasks completed and both issued a fetch to the shared server.
  assert.equal(first.filter((f) => f.type === 'task.complete').length, 1);
  assert.equal(second.filter((f) => f.type === 'task.complete').length, 1);
  assert.equal(fetchRec.calls.length, 2);
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

// ───────────────────────────────────────────────────────────────────────────
// `probeVicoopCodexModels` + envelope.model gate (#302). The probe spawns
// `vicoop-codex models --json`, reads the model id list, and feeds the
// backend's cache so `resolveCapabilities` can advertise on the agent card
// and `handle` can drop unresolved routing keys before forwarding to the
// CLI.
// ───────────────────────────────────────────────────────────────────────────

test('probeVicoopCodexModels: parses `models --json` shape into a string[] id list', async () => {
  const fake = makeFakeSpawn();
  const probe = probeVicoopCodexModels({
    command: 'vicoop-codex',
    spawn: fake.spawn,
    timeoutMs: 1000,
  });
  // The fake's child is spawned synchronously when probeVicoopCodexModels
  // calls spawn; drive it on the next microtask so the .on('data') listener
  // is registered first.
  queueMicrotask(() => {
    const child = fake.lastChild();
    child.emitStdout(
      JSON.stringify({
        client_version: '0.133.0',
        models: [
          { id: 'gpt-5.5', service_tiers: [] },
          { id: 'gpt-5.4', service_tiers: [] },
        ],
      }),
    );
    child.finish(0);
  });
  const ids = await probe;
  assert.deepEqual(ids, ['gpt-5.5', 'gpt-5.4']);
});

test('probeVicoopCodexModels: non-zero exit returns null', async () => {
  const fake = makeFakeSpawn();
  const probe = probeVicoopCodexModels({
    command: 'vicoop-codex',
    spawn: fake.spawn,
    timeoutMs: 1000,
  });
  queueMicrotask(() => fake.lastChild().finish(1));
  assert.equal(await probe, null);
});

test('probeVicoopCodexModels: timeoutMs:0 short-circuits without spawning', async () => {
  const fake = makeFakeSpawn();
  const ids = await probeVicoopCodexModels({
    command: 'vicoop-codex',
    spawn: fake.spawn,
    timeoutMs: 0,
  });
  assert.equal(ids, null);
  assert.equal(fake.children.length, 0);
});

test('resolveCapabilities advertises openaiCompatModels with the first id tagged default (#302)', async () => {
  const fake = makeFakeSpawn();
  const backend = createVicoopCodexBackend({ spawn: fake.spawn });
  const capPromise = backend.resolveCapabilities?.();
  queueMicrotask(() => {
    fake.lastChild().emitStdout(
      JSON.stringify({
        models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.4' }],
      }),
    );
    fake.lastChild().finish(0);
  });
  const cap = await capPromise;
  assert.deepEqual(cap, {
    openaiCompatModels: [
      { id: 'gpt-5.5', default: true },
      { id: 'gpt-5.4' },
    ],
  });
});

// Shared SSE body + driver for the #302 envelope.model gate tests: probe
// child (children[0]) feeds the cache, then handle() spawns the serve child
// (children[1]) and the request rides over `fetch` — so we assert on the
// recorded fetch body, not subprocess stdin.
const OK_STREAM = sseStream([
  {
    id: 'x',
    object: 'chat.completion.chunk',
    model: 'gpt-5.5',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
]);

async function runModelGate(envelopeModel: string): Promise<Record<string, unknown>> {
  const fake = makeFakeSpawn();
  const fetchRec = makeSseFetch(OK_STREAM);
  const backend = createVicoopCodexBackend({ spawn: fake.spawn, fetch: fetchRec.fetch });
  const capPromise = backend.resolveCapabilities?.();
  queueMicrotask(() => {
    fake.lastChild().emitStdout(
      JSON.stringify({ models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.4' }] }),
    );
    fake.lastChild().finish(0);
  });
  await capPromise;

  const frames: UpFrame[] = [];
  const done = backend.handle(
    {
      type: 'task.assign',
      taskId: 't',
      contextId: 'c',
      message: {
        role: 'user',
        messageId: 'm',
        parts: [{ kind: 'text', text: 'hi' }],
        metadata: {
          [OPENAI_COMPAT_EXTENSION_URI]: {
            chat_completions_request: {
              model: envelopeModel,
              messages: [{ role: 'user', content: 'hi' }],
            },
          },
        },
      },
    },
    (f) => frames.push(f),
    new AbortController().signal,
  );
  // handle() spawns the serve child synchronously inside ensureServe; drive
  // its listening line, then await completion.
  await new Promise<void>((resolve, reject) => {
    queueMicrotask(() => {
      driveServeListening(fake.lastChild());
      done.then(() => resolve(), reject);
    });
  });
  assert.equal(fetchRec.calls.length, 1);
  return JSON.parse(fetchRec.calls[0].body) as Record<string, unknown>;
}

test('envelope.model is forwarded when the probed list advertises it (#302)', async () => {
  const body = await runModelGate('gpt-5.5');
  assert.equal(body.model, 'gpt-5.5');
});

test('envelope.model is dropped when the probed list does NOT advertise it (#302)', async () => {
  // Regression guard for the gateway sending an unresolved routing key
  // (e.g. `a2a/<card-url>`) as `envelope.model`. Without the gate the bridge
  // would forward garbage to vicoop-codex, which would then fail upstream
  // with `model not found`. With the gate the override is dropped and the
  // CLI falls back to its DEFAULT_MODEL.
  const body = await runModelGate(
    'a2a/https://example.com/agents/x/.well-known/agent-card.json',
  );
  assert.equal(body.model, undefined);
});
