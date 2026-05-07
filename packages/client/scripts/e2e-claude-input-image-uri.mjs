// E2E for uri-only image FilePart input on the claude backend. Verifies
// that a PNG referenced by FilePart.file.uri is fetched by the client
// backend and reaches the model's vision path.
//
// Prereqs: `claude` on PATH and authenticated; dist built; network
// access to the configured image URI.

import { createClaudeBackend } from '../dist/backends/claude.js';

const IMAGE_URI =
  process.env.E2E_IMAGE_URI ?? 'https://placehold.co/1x1/ff0000/ff0000.png';

const PROMPT =
  process.env.E2E_PROMPT ??
  'What single color is the attached image? Reply with one word only.';

const backend = createClaudeBackend({
  extraArgs: ['--max-turns', '1'],
});

const t0 = Date.now();
const task = {
  type: 'task.assign',
  taskId: `e2e-claude-uri-img-${t0}`,
  contextId: `e2e-claude-uri-img-ctx-${t0}`,
  message: {
    role: 'user',
    messageId: `m-${t0}`,
    parts: [
      { kind: 'text', text: PROMPT },
      {
        kind: 'file',
        file: { name: 'red.png', mimeType: 'image/png', uri: IMAGE_URI },
      },
    ],
  },
};

const frames = [];
console.log(`[e2e] task=${task.taskId}`);
console.log(`[e2e] uri=${IMAGE_URI}`);
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
const text = artifacts
  .flatMap((a) => a.artifact.parts.filter((p) => p.kind === 'text').map((p) => p.text))
  .join('')
  .toLowerCase();

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
assert(text.includes('red'), `model response mentions "red" (got "${text.trim()}")`);

console.log(`[e2e] assistant text: ${text.trim()}`);

process.exit(failed ? 1 : 0);
