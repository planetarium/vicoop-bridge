// Probe whether OpenClaw (Anthropic claude-sonnet-4-6) honors a
// text-injected openai-compat envelope contract on the user-content channel.
//
// Approach mirrors the candidate-A design from the codex/claude analysis: the
// bridge has no `system` field on `chat.send`, so the entire contract
// (system instructions, available tools, optional tool_call_history) is
// folded into the user message wrapped in tagged XML blocks. If the host
// model treats the wrapper as instructions, it emits the
// `{"tool_calls":[...]}` envelope; if its prompt-injection training rejects
// the user-role-as-system framing, it answers in natural language and the
// gateway-style contract is moot.
//
// Run inside a sidecar that shares the gateway container's net namespace:
//   docker run --rm --network container:openclaw-e2e \
//     -v "$PWD":/w -w /w/packages/client \
//     -e DEBUG=1 \
//     node:20 \
//     node ./scripts/probe-openclaw-openai-compat.mjs

import { createOpenclawBackend } from '../dist/backends/openclaw.js';

// Whatever shape claude.ts ships verbatim for the openai-compat contract.
// Inlined here so the probe is self-contained (no internal-only imports).
const SYSTEM_INSTRUCTIONS = `You are routed through an OpenAI-compatible gateway and have access to the following callable functions.

When you decide a function should be called, respond with ONLY a single JSON object (no prose, no code fences, no markdown) of the exact shape:

{"tool_calls":[{"id":"call_<unique>","function":{"name":"<fn name>","arguments":{<args as JSON object>}}}]}

- "id" must be a unique string starting with "call_".
- "arguments" must be a JSON object matching the function's parameters schema.
- Emit nothing outside the JSON object.
- Do not execute the function yourself; just emit the call.
- If no function should be called, answer normally in natural language.

On follow-up turns the user message may begin with a <tool_call_history>...</tool_call_history> block containing a JSON array of prior round-trips. Each entry is one of:
  - {"role":"assistant","tool_calls":[...]} — calls you previously emitted on an earlier turn.
  - {"role":"tool","tool_call_id":"call_…","name":"…","content":"…"} — the authoritative return value for one of those calls.
Treat the history as the source of truth for what has happened so far. Do NOT repeat a call whose tool_call_id already appears in the history. Either emit a NEW tool_calls envelope (to chain another call) or compose a natural-language answer using the prior results.

Available functions:
[
  {
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get current weather for a city.",
      "parameters": {
        "type": "object",
        "properties": {
          "location": { "type": "string" },
          "unit":     { "type": "string", "enum": ["c", "f"] }
        },
        "required": ["location"]
      }
    }
  }
]

tool_choice="auto": call a function only if appropriate; otherwise answer in natural language.`;

function buildTurn1Message(userText) {
  return [
    '<system_instructions>',
    SYSTEM_INSTRUCTIONS,
    '</system_instructions>',
    '',
    '<user_message>',
    userText,
    '</user_message>',
  ].join('\n');
}

function buildTurn2Message(userText, history) {
  return [
    '<system_instructions>',
    SYSTEM_INSTRUCTIONS,
    '</system_instructions>',
    '',
    '<tool_call_history>',
    JSON.stringify(history, null, 2),
    '</tool_call_history>',
    '',
    '<user_message>',
    userText,
    '</user_message>',
  ].join('\n');
}

async function runOne(label, message, contextId) {
  const backend = createOpenclawBackend({
    url: 'ws://127.0.0.1:18789',
    token: '',                  // auth.mode=none in the test gateway
    debug: process.env.DEBUG === '1',
    taskTimeoutMs: 120_000,
  });

  const frames = [];
  const taskId = `probe-${label}-${Date.now()}`;
  const task = {
    type: 'task.assign',
    taskId,
    contextId,
    message: {
      role: 'user',
      messageId: `msg-${taskId}`,
      parts: [{ kind: 'text', text: message }],
    },
  };

  const t0 = Date.now();
  await backend.handle(task, (f) => {
    frames.push(f);
    if (f.type === 'task.artifact') {
      const ps = f.artifact?.parts ?? [];
      for (const p of ps) {
        if (p.kind === 'text') console.log(`[${label}] artifact.text:`, JSON.stringify(p.text));
        else if (p.kind === 'data') console.log(`[${label}] artifact.data:`, JSON.stringify(p.data));
        else console.log(`[${label}] artifact.${p.kind}`);
      }
    } else if (f.type === 'task.fail') {
      console.log(`[${label}] task.fail:`, f.error);
    } else if (f.type === 'task.complete') {
      console.log(`[${label}] task.complete state=${f.status?.state}`);
    }
  }, new AbortController().signal);
  const dt = Date.now() - t0;

  // Pull terminal frame for summary.
  const terminal = frames.find((f) => f.type === 'task.complete' || f.type === 'task.fail');
  const artifacts = frames.filter((f) => f.type === 'task.artifact');
  console.log(`[${label}] elapsed=${dt}ms terminal=${terminal?.type} state=${terminal?.status?.state ?? terminal?.error?.code} artifacts=${artifacts.length}`);

  return { terminal, artifacts, frames };
}

const CONTEXT_ID = `probe-ctx-${Date.now()}`;

console.log('=== TURN 1 ===');
const turn1 = await runOne(
  'turn1',
  buildTurn1Message("What's the weather in Seoul right now?"),
  CONTEXT_ID,
);

console.log('');
console.log('=== TURN 2 (multi-turn) ===');
const history = [
  {
    role: 'assistant',
    tool_calls: [
      { id: 'call_get_weather_seoul', function: { name: 'get_weather', arguments: { location: 'Seoul', unit: 'c' } } },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'call_get_weather_seoul',
    name: 'get_weather',
    content: JSON.stringify({ tempC: 7, condition: 'clear' }),
  },
];
const turn2 = await runOne(
  'turn2',
  buildTurn2Message('Now please answer in natural language.', history),
  CONTEXT_ID,
);

// Lightweight conclusion: try to detect the envelope shape on the final
// assistant text part of each turn.
function tryEnvelope(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && Array.isArray(obj.tool_calls)) return obj;
  } catch {}
  return null;
}

function lastAssistantText(frames) {
  const arts = frames.filter((f) => f.type === 'task.artifact');
  for (let i = arts.length - 1; i >= 0; i--) {
    const ps = arts[i].artifact?.parts ?? [];
    for (const p of ps) if (p.kind === 'text' && p.text) return p.text;
  }
  return '';
}

console.log('');
console.log('=== VERDICT ===');
const t1text = lastAssistantText(turn1.frames);
const t2text = lastAssistantText(turn2.frames);
const t1env = tryEnvelope(t1text);
const t2env = tryEnvelope(t2text);
console.log('turn1 envelope detected:', !!t1env, t1env ? JSON.stringify(t1env) : `(text: ${JSON.stringify(t1text.slice(0, 300))})`);
console.log('turn2 envelope detected:', !!t2env, t2env ? JSON.stringify(t2env) : `(text: ${JSON.stringify(t2text.slice(0, 300))})`);

process.exit(0);
