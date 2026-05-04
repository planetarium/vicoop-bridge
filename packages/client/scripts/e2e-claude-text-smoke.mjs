// E2E smoke for the claude backend's stream-json stdin input path.
// Verifies a plain text TaskAssign roundtrips through the real `claude` CLI
// and produces a task.complete with non-empty text.
//
// Prereqs:
//   - `claude` on PATH and authenticated
//   - dist built: `pnpm --filter @vicoop-bridge/client build`

import { createClaudeBackend } from '../dist/backends/claude.js';

const PROMPT = process.env.E2E_PROMPT ?? 'Reply with the single word: PONG';

const backend = createClaudeBackend({
  // Keep the prompt deterministic / fast.
  extraArgs: ['--max-turns', '1'],
});

const t0 = Date.now();
const task = {
  type: 'task.assign',
  taskId: `e2e-claude-text-${t0}`,
  contextId: `e2e-claude-text-ctx-${t0}`,
  message: {
    role: 'user',
    messageId: `m-${t0}`,
    parts: [{ kind: 'text', text: PROMPT }],
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

const terminal = frames.find((f) => f.type === 'task.complete' || f.type === 'task.fail');
const artifacts = frames.filter((f) => f.type === 'task.artifact');

let failed = false;
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`[e2e] FAIL: ${msg}`);
    failed = true;
  } else {
    console.log(`[e2e] PASS: ${msg}`);
  }
};

assert(
  terminal?.type === 'task.complete' && terminal.status.state === 'completed',
  `terminal is task.complete with state=completed (got ${terminal?.type})`,
);
assert(artifacts.length >= 1, `at least one task.artifact emitted (got ${artifacts.length})`);

const text = artifacts
  .flatMap((a) => a.artifact.parts.filter((p) => p.kind === 'text').map((p) => p.text))
  .join('');
assert(text.length > 0, `text artifact has content (got "${text}")`);
console.log(`[e2e] assistant text: ${text.trim()}`);

process.exit(failed ? 1 : 0);
