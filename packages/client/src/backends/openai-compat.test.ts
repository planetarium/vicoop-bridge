import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPENAI_COMPAT_EXTENSION_URI } from '@vicoop-bridge/protocol';
import {
  buildOpenAICompatSystemPrompt,
  callerToolDispatchActive,
  chatHistoryFromMessages,
  collectSystemFromMessages,
  dumpOpenAICompatTaskWire,
  formatChatHistory,
  parseOpenAICompatEnvelope,
  tryParseToolCallsEnvelope,
} from './openai-compat.js';

// Shared fixtures. Defined locally so this test file is self-contained;
// claude.test.ts and openclaw.test.ts keep parallel definitions for the
// claude / openclaw-specific tests they still own.
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

// ───────────────────────────────────────────────────────────────────────────
// parseOpenAICompatEnvelope — extracts the inbound ChatCompletions request
// body from the openai-compat A2A metadata key.
// ───────────────────────────────────────────────────────────────────────────

test('parseOpenAICompatEnvelope: absent / wrong-shape payload returns null', () => {
  assert.equal(parseOpenAICompatEnvelope(undefined), null);
  assert.equal(parseOpenAICompatEnvelope({}), null);
  assert.equal(
    parseOpenAICompatEnvelope({ [OPENAI_COMPAT_EXTENSION_URI]: [] as unknown as Record<string, unknown> }),
    null,
  );
  assert.equal(
    parseOpenAICompatEnvelope({ [OPENAI_COMPAT_EXTENSION_URI]: 'nope' as unknown as Record<string, unknown> }),
    null,
  );
  // Object present under URI but no `chat_completions_request` → null.
  assert.equal(parseOpenAICompatEnvelope({ [OPENAI_COMPAT_EXTENSION_URI]: {} }), null);
});

test('parseOpenAICompatEnvelope: returns the inbound envelope verbatim', () => {
  const inbound = {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    tools: SAMPLE_TOOLS,
    tool_choice: 'auto',
  };
  const env = parseOpenAICompatEnvelope({
    [OPENAI_COMPAT_EXTENSION_URI]: { chat_completions_request: inbound },
  });
  assert.ok(env);
  assert.equal(env.model, 'gpt-4o');
  assert.deepEqual(env.tools, SAMPLE_TOOLS);
  assert.equal(env.tool_choice, 'auto');
});

// ───────────────────────────────────────────────────────────────────────────
// collectSystemFromMessages — projects system/developer messages into the
// single system-channel string every backend consumes.
// ───────────────────────────────────────────────────────────────────────────

test('collectSystemFromMessages: joins system + developer entries', () => {
  const sys = collectSystemFromMessages([
    { role: 'system', content: 'You are concise.' },
    { role: 'developer', content: 'Reply in english.' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(sys, 'You are concise.\nReply in english.');
});

test('collectSystemFromMessages: drops blank system entries', () => {
  // Empty / whitespace-only content is treated as absent so the
  // assembler doesn't emit a blank section before the tool envelope.
  assert.equal(
    collectSystemFromMessages([
      { role: 'system', content: '' },
      { role: 'user', content: 'hi' },
    ]),
    undefined,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// chatHistoryFromMessages — projects the multi-turn replay block out of the
// envelope's messages[] (excluding the trailing user, system / developer
// entries) and normalises the OpenAI-spec content shapes.
// ───────────────────────────────────────────────────────────────────────────

test('chatHistoryFromMessages: drops trailing user, system, and developer entries', () => {
  const history = chatHistoryFromMessages([
    { role: 'system', content: 'You are concise.' },
    { role: 'developer', content: 'Reply in english.' },
    { role: 'user', content: 'Will it rain in Seoul?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
    { role: 'user', content: 'Thanks.' },
  ]);
  assert.ok(history);
  assert.equal(history.length, 3);
  assert.equal(history[0].role, 'user');
  assert.equal(history[1].role, 'assistant');
  assert.equal(history[2].role, 'tool');
});

test('chatHistoryFromMessages: tool-continuation keeps the full transcript', () => {
  // When messages[] does not end with a user turn the gateway emits A2A
  // parts as the empty placeholder; the projection then keeps every entry
  // so the backend has the whole sequence.
  const history = chatHistoryFromMessages([
    { role: 'user', content: 'Will it rain in Seoul?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
  ]);
  assert.ok(history);
  assert.equal(history.length, 3);
  assert.equal(history[2].role, 'tool');
});

test('chatHistoryFromMessages: single-turn (trailing user only) yields null', () => {
  assert.equal(chatHistoryFromMessages([{ role: 'user', content: 'hi' }]), null);
});

test('chatHistoryFromMessages: assistant tool-call entry preserves tool_calls with content:null', () => {
  const history = chatHistoryFromMessages([
    ...SAMPLE_HISTORY,
    { role: 'user', content: 'follow up' },
  ]);
  assert.ok(history);
  assert.equal(history.length, 2);
  const a = history[0];
  if (a.role !== 'assistant') throw new Error('expected assistant entry');
  if (!('tool_calls' in a)) throw new Error('expected tool-call assistant');
  if (a.content !== null) throw new Error('expected content:null on tool-call assistant');
  assert.equal(a.tool_calls.length, 1);
  // tool entry preserves content as string + optional name.
  const t = history[1];
  if (t.role !== 'tool') throw new Error('expected tool entry');
  assert.equal(t.tool_call_id, 'call_abc');
  assert.equal(t.name, 'get_weather');
  assert.equal(t.content, '{"temp":15,"cond":"sunny"}');
});

test('chatHistoryFromMessages: hybrid assistant (text + tool_calls) preserves the text', () => {
  // OpenAI Chat Completions permits an assistant turn to emit both a
  // brief explanation AND `tool_calls`. Locking the projection down keeps
  // the text from being dropped (the earlier strict-or-nothing parser
  // rejected the entry entirely).
  const history = chatHistoryFromMessages([
    {
      role: 'assistant',
      content: 'Let me check that for you.',
      tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }],
    },
    { role: 'user', content: 'go ahead' },
  ]);
  assert.ok(history);
  const a = history[0];
  if (a.role !== 'assistant' || !('tool_calls' in a)) {
    throw new Error('expected hybrid assistant entry');
  }
  assert.equal(a.content, 'Let me check that for you.');
  assert.equal((a.tool_calls as unknown[]).length, 1);
});

test('chatHistoryFromMessages: tool-call assistant accepts content as null, missing, or empty string', () => {
  // OpenAI Chat Completions wire is loose: producers emit any of `null`,
  // omit the field, or send `""`. Receivers MUST accept all three and
  // normalise to `null` so downstream backends handle one shape.
  for (const variant of [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c', function: { name: 'f' } }] },
    { role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'f' } }] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c', function: { name: 'f' } }] },
  ]) {
    const history = chatHistoryFromMessages([variant, { role: 'user', content: 'go' }]);
    assert.ok(history, `variant ${JSON.stringify(variant)} should parse`);
    const a = history[0];
    if (a.role !== 'assistant' || a.content !== null) {
      throw new Error(`variant ${JSON.stringify(variant)} did not normalise to content:null`);
    }
  }
});

test('chatHistoryFromMessages: tool entry without optional name is accepted', () => {
  const history = chatHistoryFromMessages([
    { role: 'tool', tool_call_id: 'call_x', content: 'ok' },
  ]);
  assert.ok(history);
  const t = history[0];
  if (t.role !== 'tool') throw new Error('expected tool entry');
  assert.equal(t.name, undefined);
});

test('chatHistoryFromMessages: accepts prior user/assistant text turns', () => {
  const history = chatHistoryFromMessages([
    { role: 'user', content: 'what was the weather yesterday?' },
    { role: 'assistant', content: 'It was sunny, 18°C.' },
    { role: 'user', content: 'thanks' },
  ]);
  assert.ok(history);
  assert.equal(history.length, 2);
  const u = history[0];
  if (u.role !== 'user') throw new Error('expected user entry');
  assert.equal(u.content, 'what was the weather yesterday?');
  const a = history[1];
  if (a.role !== 'assistant') throw new Error('expected assistant entry');
  assert.equal(a.content, 'It was sunny, 18°C.');
});

test('chatHistoryFromMessages: accepts multimodal content-part array on user/assistant turns', () => {
  const history = chatHistoryFromMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: 'https://example/i.png' } },
      ],
    },
    { role: 'user', content: 'and?' },
  ]);
  assert.ok(history);
  const u = history[0];
  if (u.role !== 'user') throw new Error('expected user entry');
  assert.ok(Array.isArray(u.content));
  assert.equal((u.content as unknown[]).length, 2);
});

test('chatHistoryFromMessages: malformed history entry drops the whole array', () => {
  // assistant.tool_calls must be a non-empty array — strict-or-nothing means
  // an empty array poisons the whole history, since order matters for
  // call/result pairings.
  const history = chatHistoryFromMessages([
    { role: 'assistant', content: null, tool_calls: [] },
    { role: 'tool', tool_call_id: 'call_a', content: 'ok' },
    { role: 'user', content: 'continue' },
  ]);
  assert.equal(history, null);
});

test('chatHistoryFromMessages: tool entry with missing content is normalised to empty string', () => {
  // Unlike the deleted strict-or-nothing legacy parser, the envelope path
  // normalises tool-result content (missing → '', content-parts → joined
  // text, etc.) so backends see one shape. Pin that contract.
  const history = chatHistoryFromMessages([
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', function: { name: 'f' } }] },
    { role: 'tool', tool_call_id: 'call_a' },
    { role: 'user', content: 'continue' },
  ]);
  assert.ok(history);
  assert.equal(history.length, 2);
  const t = history[1];
  if (t.role !== 'tool') throw new Error('expected tool entry');
  assert.equal(t.content, '');
});

test('chatHistoryFromMessages: empty messages array returns null', () => {
  assert.equal(chatHistoryFromMessages([]), null);
});

// ───────────────────────────────────────────────────────────────────────────
// buildOpenAICompatSystemPrompt — assembles the JSON-envelope-contract
// system prompt used by openclaw (the non-native-MCP path).
// ───────────────────────────────────────────────────────────────────────────

test('buildOpenAICompatSystemPrompt: includes tools JSON and tool_choice line when tools present', () => {
  const prompt = buildOpenAICompatSystemPrompt('You are concise.', SAMPLE_TOOLS, 'auto');
  // User system precedes the envelope contract.
  assert.match(prompt, /^You are concise\./);
  // Envelope contract is present verbatim — the exact phrasing is the
  // contract the LLM is being trained against at runtime; changing it
  // without intent breaks parsing on the model side.
  assert.match(prompt, /"tool_calls":\[\{"id":"call_<unique>"/);
  // tools JSON inlined.
  assert.match(prompt, /"name": "get_weather"/);
  // tool_choice descriptor appended.
  assert.match(prompt, /tool_choice="auto"/);
});

test('buildOpenAICompatSystemPrompt: forced-function tool_choice surfaces the name', () => {
  const prompt = buildOpenAICompatSystemPrompt(undefined, SAMPLE_TOOLS, {
    type: 'function',
    function: { name: 'get_weather' },
  });
  assert.match(prompt, /calls the function named "get_weather"/);
});

test('buildOpenAICompatSystemPrompt: tool_choice="none" suppresses the envelope contract', () => {
  const prompt = buildOpenAICompatSystemPrompt('Stay polite.', SAMPLE_TOOLS, 'none');
  assert.match(prompt, /^Stay polite\./);
  // No envelope contract emitted — instead the explicit "do not emit"
  // directive runs so the gateway's intent is preserved.
  assert.doesNotMatch(prompt, /"tool_calls":\[\{"id":"call_<unique>"/);
  assert.match(prompt, /tool_choice="none"/);
});

test('buildOpenAICompatSystemPrompt: system only (no tools) returns just the user system', () => {
  const prompt = buildOpenAICompatSystemPrompt('Be terse.', undefined, undefined);
  assert.equal(prompt, 'Be terse.');
});

test('buildOpenAICompatSystemPrompt: includes the chat_history paragraph when tools are present', () => {
  const prompt = buildOpenAICompatSystemPrompt(undefined, SAMPLE_TOOLS, undefined);
  assert.match(prompt, /<chat_history>\.\.\.<\/chat_history>/);
  // Anti-loop directive must survive any future wording revisions to this
  // paragraph — the model needs to be told not to repeat calls already in
  // the history, otherwise tool turns chain forever.
  assert.match(prompt, /Do NOT repeat a call whose tool_call_id already appears in the history/);
});

test('buildOpenAICompatSystemPrompt: omits the history paragraph when tools are absent', () => {
  // No tools → no envelope contract → no history paragraph either; the
  // paragraph references a tool_calls envelope that wouldn't be valid.
  const prompt = buildOpenAICompatSystemPrompt('Be terse.', undefined, undefined);
  assert.doesNotMatch(prompt, /<chat_history>/);
});

// ───────────────────────────────────────────────────────────────────────────
// callerToolDispatchActive — the gate every backend uses to decide whether
// to suppress agent-side built-in tools that would bypass the envelope-emit
// contract.
// ───────────────────────────────────────────────────────────────────────────

test('callerToolDispatchActive: gates on `tools` present and `tool_choice !== "none"`', () => {
  // The same gate `buildOpenAICompatSystemPrompt` uses for the envelope
  // contract block. Backends consult this to decide whether to suppress
  // agent-side built-in tools (#175).
  assert.equal(callerToolDispatchActive(undefined, undefined), false);
  assert.equal(callerToolDispatchActive(null, undefined), false);
  // Empty array carries no definitions — not "tools present".
  assert.equal(callerToolDispatchActive([], undefined), false);
  assert.equal(callerToolDispatchActive([{ type: 'function' }], undefined), true);
  // Caller catalogued tools but explicitly opted out for this turn — don't
  // handicap the agent's built-ins; the contract isn't being enforced now.
  assert.equal(callerToolDispatchActive([{ type: 'function' }], 'none'), false);
  assert.equal(callerToolDispatchActive([{ type: 'function' }], 'auto'), true);
});

// ───────────────────────────────────────────────────────────────────────────
// tryParseToolCallsEnvelope — peels a tool_calls envelope out of an
// assistant text artifact when the model emits the JSON-envelope-contract
// reply.
// ───────────────────────────────────────────────────────────────────────────

test('tryParseToolCallsEnvelope: recognises a well-formed envelope and preserves unknown keys', () => {
  const out = tryParseToolCallsEnvelope(
    JSON.stringify({
      tool_calls: [
        { id: 'call_abc', function: { name: 'get_weather', arguments: { city: 'Seoul' } } },
      ],
      // Unknown keys (e.g. model name, usage) ride along verbatim — the
      // bridge re-emits the whole object, so dropping unknown fields here
      // would silently strip data the gateway might rely on.
      _model: 'claude',
    }),
  );
  assert.ok(out);
  assert.equal(out.tool_calls.length, 1);
  assert.equal((out as { _model?: string })._model, 'claude');
});

test('tryParseToolCallsEnvelope: rejects prose, non-objects, and missing tool_calls', () => {
  assert.equal(tryParseToolCallsEnvelope(''), null);
  assert.equal(tryParseToolCallsEnvelope('I will not call any tool.'), null);
  // Prose before the brace short-circuits the parse — keeps the cost off
  // the JSON.parse on conversational turns.
  assert.equal(
    tryParseToolCallsEnvelope('Sure! {"tool_calls":[{"id":"call_x"}]}'),
    null,
  );
  // Trimmed whitespace is fine; the model occasionally pads with newlines.
  assert.ok(tryParseToolCallsEnvelope('  \n{"tool_calls":[]}\n  '));
  // Top-level array is not the envelope shape.
  assert.equal(tryParseToolCallsEnvelope('[]'), null);
  // Object without tool_calls or with non-array tool_calls is not envelope.
  assert.equal(tryParseToolCallsEnvelope('{"foo":1}'), null);
  assert.equal(tryParseToolCallsEnvelope('{"tool_calls":"nope"}'), null);
  // Malformed JSON falls through to null rather than throwing.
  assert.equal(tryParseToolCallsEnvelope('{"tool_calls":'), null);
});

// ───────────────────────────────────────────────────────────────────────────
// formatChatHistory — renders the multi-turn replay block as the
// `<chat_history>` JSON envelope every backend either prepends to the user
// content (claude / openclaw) or injects natively (codex).
// ───────────────────────────────────────────────────────────────────────────

test('formatChatHistory: wraps the full history as a JSON array verbatim', () => {
  const rendered = formatChatHistory([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_x', function: { name: 'f' } }] },
    { role: 'tool', tool_call_id: 'call_x', content: 'ok' },
  ]);
  assert.match(rendered, /^<chat_history>\n/);
  assert.match(rendered, /\n<\/chat_history>$/);
  // Pretty-printed JSON makes the structure scannable for the model and for
  // operators reading bridge logs; the test pins shape so future
  // refactors don't accidentally switch to single-line JSON (which trades
  // a tiny token saving for far worse readability under
  // `--openai-compat-trace`).
  assert.match(rendered, /\n  \{\n    "role": "user"/);
});

test('formatChatHistory: returns empty when the history is empty', () => {
  assert.equal(formatChatHistory([]), '');
});

// ───────────────────────────────────────────────────────────────────────────
// dumpOpenAICompatTaskWire — operator-side `--openai-compat-trace` dump.
// Stable shape across backend migration; lives in openai-compat.ts so every
// backend shares one canonical line.
// ───────────────────────────────────────────────────────────────────────────

test('dumpOpenAICompatTaskWire: emits header + tools + parts + envelope.messages sections', () => {
  const captured: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    const metadata = {
      [OPENAI_COMPAT_EXTENSION_URI]: {
        chat_completions_request: {
          messages: [
            { role: 'system', content: 'be terse' },
            ...SAMPLE_HISTORY,
            { role: 'user', content: 'hello' },
          ],
          tools: SAMPLE_TOOLS,
        },
      },
    };
    dumpOpenAICompatTaskWire(
      'claude',
      'task-1',
      [{ kind: 'text', text: 'hello' }],
      metadata,
    );
  } finally {
    console.error = origErr;
  }
  // Header (1) + tools header (1) + tools entries (SAMPLE_TOOLS.length=1)
  // + parts header (1) + parts entries (1) + envelope.messages header (1)
  // + envelope.messages entries (4: system + SAMPLE_HISTORY.length 2 + trailing user)
  // = 10.
  assert.equal(captured.length, 10);
  // Header sanity: tools count surfaced, hist count surfaced.
  assert.match(captured[0], /^\[openai-compat trace\] backend=claude taskId=task-1/);
  assert.match(captured[0], /"tools":1/);
  // hist count is SAMPLE_HISTORY entries excluding the trailing user / system.
  assert.match(captured[0], /"hist":2/);
  // Tools section.
  assert.match(captured[1], /^\[openai-compat trace\] tools \(1 entries\):/);
  assert.match(captured[2], /^  \[0\] get_weather: /);
  // Parts section (trailing user text).
  assert.match(captured[3], /^\[openai-compat trace\] parts \(1 entries\):/);
  assert.match(captured[4], /^  \[0\] text: "hello"/);
  // envelope.messages section.
  assert.match(captured[5], /^\[openai-compat trace\] envelope\.messages \(4 entries\):/);
});

test('dumpOpenAICompatTaskWire: parts file entry shows shape without bytes', () => {
  const captured: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    dumpOpenAICompatTaskWire(
      'codex',
      't',
      [{ kind: 'file', file: { name: 'i.png', mimeType: 'image/png', bytes: 'AAAA' } }],
      undefined,
    );
  } finally {
    console.error = origErr;
  }
  const fileLine = captured.find((l) => l.startsWith('  [0] file:'));
  assert.ok(fileLine, 'expected a file part line');
  // bytes value must not leak into the trace.
  assert.equal(fileLine!.includes('AAAA'), false);
  assert.match(fileLine!, /"hasBytes":true/);
  assert.match(fileLine!, /"mimeType":"image\/png"/);
});

test('dumpOpenAICompatTaskWire: minimal case (no tools, no history, just parts header)', () => {
  const captured: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    dumpOpenAICompatTaskWire('codex', 't', [{ kind: 'text', text: 'hi' }], undefined);
  } finally {
    console.error = origErr;
  }
  // Header + parts header + 1 part entry = 3 lines. No tools / history.
  assert.equal(captured.length, 3);
  assert.match(captured[0], /parsed=null/);
  assert.match(captured[1], /^\[openai-compat trace\] parts \(1 entries\):/);
  assert.match(captured[2], /^  \[0\] text: "hi"/);
});
