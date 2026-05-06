// E2E for PDF FilePart input on the claude backend. Generates a minimal
// 1-page PDF containing a known word, sends it as a `document` content
// block via stream-json stdin, and asserts the model's reply mentions
// that word.
//
// Prereqs: `claude` on PATH and authenticated; dist built.

import { createClaudeBackend } from '../dist/backends/claude.js';

const SECRET_WORD = process.env.E2E_PDF_WORD ?? 'KUMQUAT';

// Build a minimal valid PDF (text drawn with Helvetica) on the fly so the
// fixture stays self-contained. xref offsets are computed from the actual
// byte positions to keep the PDF parseable.
function makeMinimalPdf(text) {
  const enc = (s) => Buffer.from(s, 'latin1');
  const offsets = new Array(6).fill(0);
  let buf = enc('%PDF-1.4\n%\xC2\xA5\xC2\xB1\xC3\xAB\n');

  const obj = (n, body) => {
    offsets[n] = buf.length;
    buf = Buffer.concat([buf, enc(`${n} 0 obj\n${body}\nendobj\n`)]);
  };

  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(
    3,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  );
  const stream = `BT /F1 36 Tf 40 100 Td (${text}) Tj ET`;
  obj(4, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const xrefStart = buf.length;
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) {
    xref += `${offsets[i].toString().padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.concat([buf, enc(xref)]);
}

const pdfBytes = makeMinimalPdf(SECRET_WORD);
const PROMPT =
  process.env.E2E_PROMPT ??
  'The attached PDF contains a single word. Reply with that word in uppercase, and nothing else.';

const backend = createClaudeBackend({
  extraArgs: ['--max-turns', '1'],
});

const t0 = Date.now();
const task = {
  type: 'task.assign',
  taskId: `e2e-claude-pdf-${t0}`,
  contextId: `e2e-claude-pdf-ctx-${t0}`,
  message: {
    role: 'user',
    messageId: `m-${t0}`,
    parts: [
      { kind: 'text', text: PROMPT },
      {
        kind: 'file',
        file: {
          name: 'word.pdf',
          mimeType: 'application/pdf',
          bytes: pdfBytes.toString('base64'),
        },
      },
    ],
  },
};

const frames = [];
console.log(`[e2e] task=${task.taskId}`);
console.log(`[e2e] secret word: ${SECRET_WORD}`);
console.log(`[e2e] pdf size: ${pdfBytes.length} bytes`);

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
  .join('');

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
  text.toUpperCase().includes(SECRET_WORD),
  `model response contains the secret word "${SECRET_WORD}" (got "${text.trim()}")`,
);

console.log(`[e2e] assistant text: ${text.trim()}`);

process.exit(failed ? 1 : 0);
