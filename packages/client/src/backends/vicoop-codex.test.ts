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
  probeVicoopCodexModels,
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
  // Legacy top-level `usage` sibling for back-compat with v1-era codecs
  // that only read it; new codecs prefer `chat_completion.usage`.
  assert.ok(ext.usage);
  const envelope = ext.chat_completion as Record<string, unknown>;
  assert.equal(envelope.id, 'chatcmpl-abc');
  assert.equal(envelope.object, 'chat.completion');
  assert.equal(envelope.model, 'gpt-5.4');
  assert.equal(envelope.created, 1779177411);
  // chat_completion.usage carries the normalized OpenAICompatUsage
  // (with the spec-mandated total === prompt + completion invariant)
  // — same value as the top-level sibling. Codec prefers this path.
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
  // Legacy top-level `usage` for v1-era back-compat.
  assert.ok(ext.usage);
  const envelope = ext.chat_completion as Record<string, unknown>;
  assert.equal(envelope.id, 'chatcmpl-1');
  assert.equal(envelope.model, 'gpt-5.4');
  // The envelope carries `usage` natively (preferred by the codec); same
  // numeric totals as the legacy sibling above.
  const envelopeUsage = envelope.usage as Record<string, number>;
  assert.equal(envelopeUsage.prompt_tokens, 3);
  assert.equal(envelopeUsage.completion_tokens, 1);
  assert.equal(envelopeUsage.total_tokens, 4);
  // Spec requires logprobs on each choice (null when not surfaced).
  const choices = envelope.choices as Array<Record<string, unknown>>;
  assert.equal(choices.length, 1);
  assert.equal(choices[0].logprobs, null);
  assert.equal(choices[0].finish_reason, 'stop');
});

test('handle: tool_calls response → no data artifact; tool_calls only on terminal chat_completion envelope (envelope contract, oai2a2a#80)', async () => {
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

test('handle: stdin body carries envelope-derived model/messages/tools/tool_choice', async () => {
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
              // Trailing user — split into A2A parts; chatHistoryFromMessages
              // drops this from the replay so the test's A2A `parts` text
              // becomes the trailing user instead.
              { role: 'user', content: 'current question' },
            ],
            tools: [{ type: 'function', function: { name: 'get_weather' } }],
            tool_choice: { type: 'function', function: { name: 'get_weather' } },
          },
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
    // Messages: system → chat_history (assistant(tool_calls) → tool) →
    // trailing user. Per the new openai-compat chat_history wire, the
    // trailing user (the current A2A `parts` turn) sits AFTER the
    // history slice, mirroring how OpenAI Chat Completions arranges
    // `[..., assistant.tool_calls, tool, user]` for a follow-up.
    const messages = body.messages as Array<{ role: string }>;
    assert.deepEqual(
      messages.map((m) => m.role),
      ['system', 'assistant', 'tool', 'user'],
    );
    // Envelope contract: model + tools + tool_choice forward verbatim.
    // Group B / Group C fields (reasoning_effort, temperature, max_tokens
    // etc.) are intentionally not on the call body shape — the binary
    // applies its own defaults.
    assert.equal(body.model, 'gpt-5.5');
    assert.deepEqual(body.tools, [
      { type: 'function', function: { name: 'get_weather' } },
    ]);
    assert.deepEqual(body.tool_choice, {
      type: 'function',
      function: { name: 'get_weather' },
    });
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

test('envelope.model is forwarded when the probed list advertises it (#302)', async () => {
  const fake = makeFakeSpawn();
  const backend = createVicoopCodexBackend({ spawn: fake.spawn });
  const capPromise = backend.resolveCapabilities?.();
  queueMicrotask(() => {
    fake.lastChild().emitStdout(
      JSON.stringify({ models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.4' }] }),
    );
    fake.lastChild().finish(0);
  });
  await capPromise;

  const frames: UpFrame[] = [];
  const ctrl = new AbortController();
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
              model: 'gpt-5.5',
              messages: [{ role: 'user', content: 'hi' }],
            },
          },
        },
      },
    },
    (f) => frames.push(f),
    ctrl.signal,
  );
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  // index 0 was the probe child; the call child is the second one.
  const callChild = fake.children[1];
  const body = JSON.parse(callChild.stdinPayload()) as Record<string, unknown>;
  assert.equal(body.model, 'gpt-5.5');
  // Drive the call child to a clean exit so done resolves.
  callChild.emitStdout(
    JSON.stringify({
      id: 'x',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5.5',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
  callChild.finish(0);
  await done;
});

test('envelope.model is dropped when the probed list does NOT advertise it (#302)', async () => {
  // Regression guard for the gateway sending an unresolved routing key
  // (e.g. `a2a/<card-url>`) as `envelope.model`. Without the gate the
  // bridge would forward garbage to vicoop-codex, which would then fail
  // upstream with `model not found`. With the gate the override is
  // dropped and the CLI falls back to its DEFAULT_MODEL.
  const fake = makeFakeSpawn();
  const backend = createVicoopCodexBackend({ spawn: fake.spawn });
  const capPromise = backend.resolveCapabilities?.();
  queueMicrotask(() => {
    fake.lastChild().emitStdout(
      JSON.stringify({ models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.4' }] }),
    );
    fake.lastChild().finish(0);
  });
  await capPromise;

  const frames: UpFrame[] = [];
  const ctrl = new AbortController();
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
              model: 'a2a/https://example.com/agents/x/.well-known/agent-card.json',
              messages: [{ role: 'user', content: 'hi' }],
            },
          },
        },
      },
    },
    (f) => frames.push(f),
    ctrl.signal,
  );
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const callChild = fake.children[1];
  const body = JSON.parse(callChild.stdinPayload()) as Record<string, unknown>;
  // model field absent — CLI falls back to DEFAULT_MODEL.
  assert.equal(body.model, undefined);
  callChild.emitStdout(
    JSON.stringify({
      id: 'x',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5.5',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
  callChild.finish(0);
  await done;
});
