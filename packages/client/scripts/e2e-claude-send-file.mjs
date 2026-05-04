// E2E for the send_file MCP tool path on the claude backend. Verifies:
//   - bridge-client lazy-starts the MCP server, registers it via
//     `--mcp-config`, and the spawned claude sees the `send_file` tool.
//   - The model invokes `send_file(path)` during the run.
//   - bridge-client's MCP server reads the file, emits a task.artifact
//     containing a FilePart whose bytes match the fixture.
//
// Prereqs: `claude` on PATH and authenticated; dist built.

import fs from 'node:fs';
import path from 'node:path';
import { createClaudeBackend } from '../dist/backends/claude.js';

const FIXTURE_DIR = '/tmp/claude-send-file-e2e';
const FIXTURE_PATH = path.join(FIXTURE_DIR, 'tool-output.txt');
const FIXTURE_CONTENT = 'sent via send_file tool from claude e2e';

fs.mkdirSync(FIXTURE_DIR, { recursive: true });
fs.writeFileSync(FIXTURE_PATH, FIXTURE_CONTENT);

const PROMPT =
  process.env.E2E_PROMPT ??
  `Use the send_file tool from the vicoop-bridge MCP server to deliver the file at "${FIXTURE_PATH}" to the caller. After the tool returns, briefly confirm you sent the file (one short sentence).`;

const backend = createClaudeBackend({
  extraArgs: ['--max-turns', '4', '--permission-mode', 'bypassPermissions'],
  sendFileMcp: {
    allowedRoots: [FIXTURE_DIR],
    maxBytes: 1024 * 1024,
    host: '127.0.0.1',
  },
});

const t0 = Date.now();
const task = {
  type: 'task.assign',
  taskId: `e2e-claude-sendfile-${t0}`,
  contextId: `e2e-claude-sendfile-ctx-${t0}`,
  message: {
    role: 'user',
    messageId: `m-${t0}`,
    parts: [{ kind: 'text', text: PROMPT }],
  },
};

const frames = [];
console.log(`[e2e] fixture: ${FIXTURE_PATH} (${FIXTURE_CONTENT.length} bytes)`);
console.log(`[e2e] task=${task.taskId} context=${task.contextId}`);

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
const fileParts = artifacts.flatMap((a) =>
  a.artifact.parts.filter((p) => p.kind === 'file'),
);
const sendFileArtifacts = artifacts.filter((a) => a.artifact.name === 'send-file');

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
assert(
  sendFileArtifacts.length >= 1,
  `at least one artifact with name="send-file" (got ${sendFileArtifacts.length}; check the model invoked the tool)`,
);
assert(fileParts.length >= 1, `at least one FilePart artifact (got ${fileParts.length})`);

if (fileParts.length >= 1) {
  const fp = fileParts[0];
  const decoded = Buffer.from(fp.file.bytes ?? '', 'base64').toString('utf8');
  assert(
    decoded === FIXTURE_CONTENT,
    `FilePart bytes match fixture (expected="${FIXTURE_CONTENT}", got="${decoded}")`,
  );
}

const server = backend.getSendFileMcpServer();
if (server) await server.close();
try {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
} catch {
  /* ignore */
}

process.exit(failed ? 1 : 0);
