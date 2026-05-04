// E2E harness for the MCP send_file tool path. Verifies the full chain:
//   prompt -> agent invokes send_file MCP tool -> bridge-client's MCP server
//   reads the file -> emits a task.artifact with FilePart -> handle() returns
//
// Setup that the runner must arrange:
//   1. OpenClaw container has `mcp.servers.send-file` configured to point
//      at http://127.0.0.1:<MCP_PORT>/mcp (the sidecar binds the same
//      network namespace via --network container:<gw>)
//   2. The agent must be able to call models (real provider auth)
//
// This harness picks a fixed MCP_PORT so the OpenClaw image can be built
// once with the matching mcp.servers entry. Set SEND_FILE_MCP_PORT to
// override (must match the gateway config).

import fs from 'node:fs';
import path from 'node:path';
import { createOpenclawBackend } from '../dist/backends/openclaw.js';

const MCP_PORT = Number(process.env.SEND_FILE_MCP_PORT ?? 19090);
const FIXTURE_DIR = '/tmp/send-file-test';
const FIXTURE_PATH = path.join(FIXTURE_DIR, 'tool-output.txt');
const FIXTURE_CONTENT = 'sent via send_file tool';

fs.mkdirSync(FIXTURE_DIR, { recursive: true });
fs.writeFileSync(FIXTURE_PATH, FIXTURE_CONTENT);

// OpenClaw prefixes external MCP tool names with the server name (see the
// note in docs/openclaw-e2e.md), so the model sees `send-file__send_file`
// in its tool catalog. Naming the exact tool reduces flakiness vs. relying
// on the model to disambiguate `send_file`.
const PROMPT =
  process.env.E2E_PROMPT ??
  `Please call the send-file__send_file tool to deliver the file at "${FIXTURE_PATH}" to the caller. After the tool returns, briefly confirm you sent the file (one short sentence). Do not include the path in your reply.`;

const backend = createOpenclawBackend({
  url: 'ws://127.0.0.1:18789',
  token: process.env.OPENCLAW_GATEWAY_TOKEN,
  debug: process.env.DEBUG === '1',
  taskTimeoutMs: 120_000,
  sendFileMcp: {
    allowedRoots: [FIXTURE_DIR],
    maxBytes: 1024 * 1024,
    port: MCP_PORT,
    host: '127.0.0.1',
  },
});

const frames = [];
const t0 = Date.now();
const task = {
  type: 'task.assign',
  taskId: `e2e-send-file-${t0}`,
  contextId: `e2e-send-file-ctx-${t0}`,
  message: {
    role: 'user',
    messageId: `e2e-send-file-msg-${t0}`,
    parts: [{ kind: 'text', text: PROMPT }],
  },
};

console.log(`[e2e] fixture: ${FIXTURE_PATH} (${FIXTURE_CONTENT.length} bytes)`);
console.log(`[e2e] MCP port: ${MCP_PORT}`);
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
  `at least one FilePart artifact emitted via send_file tool (got ${fileParts.length}; check that the model invoked the tool and the bridge-client MCP server received the call)`,
);

const sendFileArtifacts = artifacts.filter((a) => a.artifact.name === 'send-file');
assert(
  sendFileArtifacts.length >= 1,
  `at least one artifact with name="send-file" (the MCP tool path tag) was emitted (got ${sendFileArtifacts.length})`,
);

if (fileParts.length >= 1) {
  const fp = fileParts[0];
  const decoded = Buffer.from(fp.file.bytes ?? '', 'base64').toString('utf8');
  assert(
    decoded === FIXTURE_CONTENT,
    `FilePart bytes match fixture (expected="${FIXTURE_CONTENT}", got="${decoded}")`,
  );
}

// Cleanup
const server = backend.getSendFileMcpServer();
if (server) await server.close();
try {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
} catch {
  /* ignore */
}

process.exit(failed ? 1 : 0);
