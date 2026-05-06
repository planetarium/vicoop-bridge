// E2E harness for caller->agent non-image attachment passthrough against a
// real OpenClaw v2026.4.27+ gateway. Meant to be run from a Node sidecar
// that shares the gateway container's network namespace; see
// docs/openclaw-e2e.md.
//
// What this verifies:
//   - bridge-client maps `kind: 'file'` non-image FileParts into chat.send
//     attachments with `type: 'file'`
//   - OpenClaw v2026.4.27 accepts the attachment shape (no chat.send error
//     about "only image/* supported" or "non-image attachments not
//     supported on this entrypoint")
//   - Any failure that follows is downstream of attachment parsing
//     (typically agent auth / model invocation), not protocol shape
//
// Without CLAUDE_AI_SESSION_KEY the agent itself fails before producing a
// real response, but the gateway's chat.send still acks the attachment —
// which is precisely the bridge-client <-> gateway contract under test.
// The success criterion is "no protocol-shape rejection at chat.send",
// not "agent succeeded".
//
// Exits non-zero if the gateway rejected the attachment shape.

import { createOpenclawBackend } from '../dist/backends/openclaw.js';

// Token is optional: when the gateway runs with `auth.mode = "none"` no
// token is required. The bridge-client's GatewayClient passes the token
// through unchanged when set; the gateway side ignores it under mode=none.
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;

// Minimal valid PDF (not a real document, but valid header so OpenClaw's
// mime sniff sees `%PDF-` and routes correctly).
const TINY_PDF_BASE64 =
  'JVBERi0xLjQKJcKlwrHDqwoxIDAgb2JqCjw8L0xlbmd0aCAxNT4+CnN0cmVhbQpCVCAvRjEgMTIgVGYgKGhlbGxvKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnRyYWlsZXIKPDwvUm9vdCAxIDAgUj4+CiUlRU9G';

const PROMPT =
  process.env.E2E_PROMPT ??
  'I am attaching a small PDF file. Please confirm receipt and describe what you see in two sentences.';

const backend = createOpenclawBackend({
  url: 'ws://127.0.0.1:18789',
  token: TOKEN,
  debug: process.env.DEBUG === '1',
  taskTimeoutMs: 60_000,
});

const frames = [];
const t0 = Date.now();
const task = {
  type: 'task.assign',
  taskId: `e2e-file-${t0}`,
  contextId: `e2e-file-ctx-${t0}`,
  message: {
    role: 'user',
    messageId: `e2e-file-msg-${t0}`,
    parts: [
      { kind: 'text', text: PROMPT },
      {
        kind: 'file',
        file: {
          name: 'sample.pdf',
          mimeType: 'application/pdf',
          bytes: TINY_PDF_BASE64,
        },
      },
    ],
  },
};

console.log(`[e2e] prompt: ${PROMPT}`);
console.log(`[e2e] task=${task.taskId} context=${task.contextId}`);
console.log(`[e2e] attachment: name=sample.pdf mime=application/pdf base64Len=${TINY_PDF_BASE64.length}`);

await backend.handle(
  task,
  (f) => {
    const delta = Date.now() - t0;
    frames.push({ t: delta, ...f });
    const summary =
      f.type === 'task.artifact'
        ? `artifact id=${f.artifact.artifactId.slice(0, 8)} name=${f.artifact.name} bytes=${JSON.stringify(f.artifact.parts).length}`
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

const terminal = frames.find((f) => f.type === 'task.complete' || f.type === 'task.fail');

console.log('');
console.log(`[e2e] terminal: ${terminal?.type}`);
if (terminal?.type === 'task.fail') {
  console.log(`[e2e] error code: ${terminal.error.code}`);
  console.log(`[e2e] error msg: ${terminal.error.message}`);
}

let failed = false;
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`[e2e] FAIL: ${msg}`);
    failed = true;
  } else {
    console.log(`[e2e] PASS: ${msg}`);
  }
};

// Primary contract: the gateway must NOT reject the chat.send call with a
// protocol-shape error about non-image attachments. If our mapping is
// wrong, the failure surfaces with `gateway_send_failed` carrying a
// message like "only image/* supported" or "non-image attachments are not
// supported on this entrypoint".
const protocolShapeRejection =
  terminal?.type === 'task.fail' &&
  terminal.error.code === 'gateway_send_failed' &&
  /only image\/\*|non-image attachments? .* not supported on this entrypoint|requireImageMime/i.test(
    terminal.error.message ?? '',
  );

assert(!protocolShapeRejection, 'gateway accepted non-image attachment shape (no protocol-shape rejection)');

// Secondary: any error must be downstream of attachment parsing — i.e.
// either the agent ran and replied, or the agent failed for an
// auth/model reason (acceptable without CLAUDE_AI_SESSION_KEY).
if (terminal?.type === 'task.fail') {
  const isAcceptableDownstreamFailure =
    /CLAUDE_AI_SESSION_KEY|agent failed before reply|chat_error|task_timeout|gateway_chat_error|model invocation|not authenticated|auth/i.test(
      `${terminal.error.code} ${terminal.error.message}`,
    );
  assert(
    isAcceptableDownstreamFailure,
    `failure is downstream of attachment parsing (got code=${terminal.error.code}, msg="${terminal.error.message}")`,
  );
} else if (terminal?.type === 'task.complete') {
  assert(
    terminal.status.state === 'completed',
    `task.complete carries state=completed (got ${terminal.status.state})`,
  );
}

process.exit(failed ? 1 : 0);
