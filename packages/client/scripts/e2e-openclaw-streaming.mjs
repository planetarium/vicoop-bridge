// E2E harness for message-boundary streaming against a real OpenClaw
// gateway. Meant to be run from a Node sidecar that shares the gateway
// container's network namespace; see docs/openclaw-e2e.md.
//
// Success criteria:
//   - at least one task.artifact frame arrives before task.complete
//   - artifactIds are all distinct
//   - terminal frame state === 'completed'
//
// Exits non-zero if any assertion fails so the outer `docker run` run
// propagates a clear pass/fail status.

import { createOpenclawBackend } from '../dist/backends/openclaw.js';

const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
if (!TOKEN) {
  console.error('set OPENCLAW_GATEWAY_TOKEN');
  process.exit(2);
}

// Pick a prompt that ordinarily induces multi-step agent output
// (tool use + final response => multiple assistant transcript writes).
// Fallback to a simple text response if the agent doesn't take the tool
// path — the test still passes with a single artifact (matches the
// no-streaming fallback behavior).
const PROMPT = process.env.E2E_PROMPT ?? 'List the files in /tmp using bash, then summarize what you found in two sentences.';

const backend = createOpenclawBackend({
  url: 'ws://127.0.0.1:18789',
  token: TOKEN,
  debug: process.env.DEBUG === '1',
  taskTimeoutMs: 180_000,
});

const frames = [];
const t0 = Date.now();
const task = {
  type: 'task.assign',
  taskId: `e2e-stream-${t0}`,
  contextId: `e2e-stream-ctx-${t0}`,
  message: {
    role: 'user',
    messageId: `e2e-stream-msg-${t0}`,
    parts: [{ kind: 'text', text: PROMPT }],
  },
};

console.log(`[e2e] prompt: ${PROMPT}`);
console.log(`[e2e] task=${task.taskId} context=${task.contextId}`);

await backend.handle(
  task,
  (f) => {
    const delta = Date.now() - t0;
    frames.push({ t: delta, ...f });
    const summary = f.type === 'task.artifact'
      ? `artifact id=${f.artifact.artifactId.slice(0, 8)} name=${f.artifact.name} bytes=${JSON.stringify(f.artifact.parts).length} lastChunk=${f.lastChunk}`
      : f.type === 'task.complete'
        ? `complete state=${f.status.state}`
        : f.type === 'task.fail'
          ? `fail code=${f.error.code} msg=${f.error.message}`
          : f.type === 'task.status'
            ? `status state=${f.status.state}`
            : f.type;
    console.log(`[frame +${delta}ms] ${f.type} ${summary}`);
  },
  new AbortController().signal,
);

const artifacts = frames.filter((f) => f.type === 'task.artifact');
const terminal = frames.find((f) => f.type === 'task.complete' || f.type === 'task.fail');
const artifactIds = new Set(artifacts.map((a) => a.artifact.artifactId));

console.log('');
console.log(`[e2e] artifacts: ${artifacts.length}`);
console.log(`[e2e] distinct artifactIds: ${artifactIds.size}`);
console.log(`[e2e] total elapsed: ${Date.now() - t0}ms`);
console.log(`[e2e] terminal: ${terminal?.type} ${terminal?.type === 'task.complete' ? terminal.status.state : ''}`);

let failed = false;
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`[e2e] FAIL: ${msg}`);
    failed = true;
  } else {
    console.log(`[e2e] PASS: ${msg}`);
  }
};

assert(artifacts.length >= 1, 'at least one task.artifact emitted');
assert(artifactIds.size === artifacts.length, 'all artifactIds are distinct');
assert(
  terminal?.type === 'task.complete' && terminal.status.state === 'completed',
  'terminal frame is task.complete with state=completed',
);

// Streaming-specific claim: if the run went through more than one
// assistant message (tool use path), the first artifact must arrive
// strictly before the terminal frame. When only one artifact was
// emitted it is the final-result fallback and this timing check is
// vacuous — which still matches option (b) design (multi-artifact is
// best-effort, single-artifact is a documented graceful-degradation case).
if (artifacts.length >= 2) {
  const firstArtifactT = artifacts[0].t;
  const terminalT = terminal?.t ?? Infinity;
  assert(firstArtifactT < terminalT, 'first streaming artifact arrives before terminal frame');
}

process.exit(failed ? 1 : 0);
