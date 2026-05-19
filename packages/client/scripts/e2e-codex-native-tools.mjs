// E2E smoke for the codex backend's native function-call dispatch path (#209).
// Sends an A2A TaskAssign with openai-compat `tools` metadata and asserts:
//   - a `tool_calls` data artifact is emitted (with the caller's tool name)
//   - the task surfaces as `completed` (NOT `canceled`) — matching OpenAI
//     Chat Completions' `finish_reason: "tool_calls"` semantics
//   - no envelope-shaped agent text leaks into `status.message.parts`
//
// Prereqs:
//   - `codex` (0.130.0) on PATH, authenticated (`~/.codex/auth.json`)
//   - dist built: `pnpm --filter @vicoop-bridge/client build`

import { createCodexBackend } from '../dist/backends/codex.js';
import { OPENAI_COMPAT_EXTENSION_URI } from '@vicoop-bridge/protocol';

const PROMPT =
  process.env.E2E_PROMPT ??
  'Use the get_weather tool to look up the current weather in Seoul.';

const backend = createCodexBackend({
  sandboxMode: 'read-only',
});

const t0 = Date.now();
const task = {
  type: 'task.assign',
  taskId: `e2e-codex-native-tools-${t0}`,
  contextId: `e2e-codex-native-tools-ctx-${t0}`,
  message: {
    role: 'user',
    messageId: `m-${t0}`,
    parts: [{ kind: 'text', text: PROMPT }],
    metadata: {
      [OPENAI_COMPAT_EXTENSION_URI]: {
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Look up the current weather for a given city.',
              parameters: {
                type: 'object',
                properties: {
                  city: { type: 'string', description: 'City name' },
                },
                required: ['city'],
                additionalProperties: false,
              },
            },
          },
        ],
      },
    },
  },
};

const frames = [];
console.log(`[e2e] task=${task.taskId}`);
console.log(`[e2e] prompt: ${PROMPT}`);

await backend.handle(
  task,
  (f) => {
    const delta = Date.now() - t0;
    frames.push({ t: delta, ...f });
    let summary = '';
    if (f.type === 'task.artifact') {
      const k = f.artifact.parts.map((p) => p.kind).join(',');
      summary = `name=${f.artifact.name} parts=[${k}]`;
    } else if (f.type === 'task.complete') {
      summary = `state=${f.status.state}`;
    } else if (f.type === 'task.fail') {
      summary = `code=${f.error.code} msg=${f.error.message}`;
    } else if (f.type === 'task.status') {
      summary = `state=${f.status.state}`;
    }
    console.log(`[frame +${delta}ms] ${f.type} ${summary}`);
  },
  new AbortController().signal,
);

backend.stop?.();

let failed = false;
const ok = (cond, msg) => {
  if (cond) {
    console.log(`[e2e] PASS: ${msg}`);
  } else {
    console.error(`[e2e] FAIL: ${msg}`);
    failed = true;
  }
};

const terminal = frames.find((f) => f.type === 'task.complete' || f.type === 'task.fail');
ok(
  terminal?.type === 'task.complete' && terminal.status.state === 'completed',
  `terminal is task.complete with state=completed (got ${terminal?.type}/${terminal?.type === 'task.complete' ? terminal.status.state : terminal?.error?.code})`,
);

const artifacts = frames.filter((f) => f.type === 'task.artifact');
ok(artifacts.length >= 1, `at least one artifact emitted (got ${artifacts.length})`);

const toolCallArtifact = artifacts.find((f) =>
  f.artifact.extensions?.includes(OPENAI_COMPAT_EXTENSION_URI) &&
  f.artifact.parts.some((p) => p.kind === 'data' && p.data && typeof p.data === 'object' && 'tool_calls' in p.data),
);
ok(toolCallArtifact, 'a tool_calls artifact was emitted');
if (toolCallArtifact) {
  const dataPart = toolCallArtifact.artifact.parts.find((p) => p.kind === 'data');
  const calls = dataPart?.data?.tool_calls ?? [];
  ok(Array.isArray(calls) && calls.length === 1, `exactly one tool_calls entry (got ${calls.length})`);
  if (calls[0]) {
    ok(calls[0].function?.name === 'get_weather', `tool name is get_weather (got ${calls[0].function?.name})`);
    ok(calls[0].id && String(calls[0].id).length > 0, `call id non-empty (got ${JSON.stringify(calls[0].id)})`);
    const args = calls[0].function?.arguments;
    const argsObj = typeof args === 'string' ? safeJson(args) : args;
    ok(argsObj && typeof argsObj === 'object' && 'city' in argsObj, `arguments include city (got ${JSON.stringify(args)})`);
    if (argsObj?.city) {
      console.log(`[e2e] model picked city: ${argsObj.city}`);
    }
  }
}

// No envelope JSON in status.message.parts (#200).
if (terminal?.type === 'task.complete') {
  const msgParts = terminal.status.message?.parts ?? [];
  for (const p of msgParts) {
    if (p.kind !== 'text') continue;
    ok(!p.text.includes('"tool_calls"'), 'status.message.parts must not echo tool_calls JSON');
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

process.exit(failed ? 1 : 0);
