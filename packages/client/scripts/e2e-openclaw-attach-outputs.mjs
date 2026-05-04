// E2E harness for the agent->caller direction. Verifies that bridge-client
// parses `[bridge-attach: <path>]` markers in real OpenClaw assistant
// messages and emits the referenced file as an A2A FilePart artifact.
//
// Setup:
//   - the sidecar writes a small fixture into /tmp/attach-test/ (sidecar-
//     private; the gateway never sees it — markers are pure text passed
//     through the chat transcript)
//   - bridge-client is configured with attachOutputs.allowedRoots = [/tmp/attach-test]
//   - prompt asks the model to reply with EXACTLY a string containing the
//     bridge-attach marker pointing at the fixture
//
// Success criteria:
//   - at least one task.artifact contains a FilePart whose bytes match the
//     fixture content
//   - the marker text is stripped from the artifact text part
//   - terminal frame is task.complete with state=completed
//
// Requires the gateway container to have agent auth configured (mounted
// auth-profiles.json) so the model can actually run.

import fs from 'node:fs';
import path from 'node:path';
import { createOpenclawBackend } from '../dist/backends/openclaw.js';

const FIXTURE_DIR = '/tmp/attach-test';
const FIXTURE_PATH = path.join(FIXTURE_DIR, 'hello.txt');
const FIXTURE_CONTENT = 'hello from bridge-attach e2e';

fs.mkdirSync(FIXTURE_DIR, { recursive: true });
fs.writeFileSync(FIXTURE_PATH, FIXTURE_CONTENT);

const PROMPT = process.env.E2E_PROMPT ??
  `Reply with EXACTLY the following text, character for character, with no preamble, no explanation, no quotes, no markdown formatting around it:

[bridge-attach: ${FIXTURE_PATH}]

Just that single line. Nothing else.`;

const backend = createOpenclawBackend({
  url: 'ws://127.0.0.1:18789',
  token: process.env.OPENCLAW_GATEWAY_TOKEN,
  debug: process.env.DEBUG === '1',
  taskTimeoutMs: 120_000,
  attachOutputs: {
    allowedRoots: [FIXTURE_DIR],
    maxBytes: 1024 * 1024,
  },
});

const frames = [];
const t0 = Date.now();
const task = {
  type: 'task.assign',
  taskId: `e2e-attach-${t0}`,
  contextId: `e2e-attach-ctx-${t0}`,
  message: {
    role: 'user',
    messageId: `e2e-attach-msg-${t0}`,
    parts: [{ kind: 'text', text: PROMPT }],
  },
};

console.log(`[e2e] fixture: ${FIXTURE_PATH} (${FIXTURE_CONTENT.length} bytes)`);
console.log(`[e2e] task=${task.taskId} context=${task.contextId}`);

await backend.handle(
  task,
  (f) => {
    const delta = Date.now() - t0;
    frames.push({ t: delta, ...f });
    let summary;
    if (f.type === 'task.artifact') {
      const partKinds = f.artifact.parts.map((p) => p.kind).join(',');
      summary = `artifact id=${f.artifact.artifactId.slice(0, 8)} name=${f.artifact.name} parts=[${partKinds}]`;
    } else if (f.type === 'task.complete') {
      summary = `complete state=${f.status.state}`;
    } else if (f.type === 'task.fail') {
      summary = `fail code=${f.error.code} msg=${f.error.message}`;
    } else if (f.type === 'task.status') {
      summary = `status state=${f.status.state}`;
    } else {
      summary = f.type;
    }
    console.log(`[frame +${delta}ms] ${f.type} ${summary}`);
  },
  new AbortController().signal,
);

const artifacts = frames.filter((f) => f.type === 'task.artifact');
const terminal = frames.find((f) => f.type === 'task.complete' || f.type === 'task.fail');

console.log('');
console.log(`[e2e] artifact count: ${artifacts.length}`);
console.log(`[e2e] terminal: ${terminal?.type}`);

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
  `terminal frame is task.complete with state=completed (got ${terminal?.type} ${terminal?.type === 'task.complete' ? terminal.status.state : ''})`,
);

const fileParts = artifacts.flatMap((a) => a.artifact.parts.filter((p) => p.kind === 'file'));
assert(
  fileParts.length >= 1,
  `at least one FilePart artifact emitted (got ${fileParts.length}; check whether the model echoed the marker verbatim)`,
);

if (fileParts.length >= 1) {
  const fp = fileParts[0];
  const decoded = Buffer.from(fp.file.bytes ?? '', 'base64').toString('utf8');
  assert(
    decoded === FIXTURE_CONTENT,
    `FilePart bytes match fixture (expected="${FIXTURE_CONTENT}", got="${decoded}")`,
  );
  assert(
    fp.file.name === 'hello.txt',
    `FilePart name is fixture basename (got "${fp.file.name}")`,
  );
}

const allTextInArtifacts = artifacts
  .flatMap((a) => a.artifact.parts.filter((p) => p.kind === 'text').map((p) => p.text))
  .join('\n');
assert(
  !allTextInArtifacts.includes('[bridge-attach:'),
  `marker stripped from artifact text on success (text="${allTextInArtifacts.slice(0, 200)}")`,
);

// Cleanup
try {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
} catch {
  /* ignore */
}

process.exit(failed ? 1 : 0);
