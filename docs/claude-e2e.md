# Claude backend E2E

Workflow for exercising the `claude` backend directly against the real
`claude` CLI (Claude Code), without standing up the bridge server / caller
token / A2A HTTP stack. Useful when changing
`packages/client/src/backends/claude.ts` or debugging multi-modal input
or the `send_file` MCP tool path.

The unit tests in `claude.test.ts` use a fake child process and cover the
A2A frame shapes, argv layout, and stdin envelope mapping. They can't
catch divergence from the real CLI (stream-json schema drift, MCP
discovery, model behavior on tool use). This guide fills that gap.

## Prerequisites

- `claude` on `PATH` and authenticated. Verify with `claude --version`.
- Repo built: `pnpm install && pnpm --filter @vicoop-bridge/client build`.
- Network egress to the Anthropic API. Each harness consumes real
  inference credits; total cost across the five scripts is small (single
  digits of cents at current rates) but non-zero.

The harnesses live under `packages/client/scripts/` and each one is a
self-contained Node script that imports the compiled backend, drives a
single A2A `task.assign` through it, and asserts on the emitted frames.

## Available harnesses

### 1. Text smoke — `e2e-claude-text-smoke.mjs`

Plain text in, text out. Fastest sanity check for the stream-json stdin
plumbing — if this fails, none of the multi-modal cases will work.

```bash
node packages/client/scripts/e2e-claude-text-smoke.mjs
```

Expected (≈ 8 s):

```
[frame +1ms] task.status state=working
[frame +Xms]  task.artifact name=claude-message parts=[text]
[frame +Yms]  task.complete state=completed
[e2e] PASS: terminal is task.complete with state=completed
[e2e] PASS: at least one task.artifact emitted
[e2e] PASS: text artifact has content
[e2e] assistant text: PONG
```

### 2. Image input — `e2e-claude-input-image.mjs`

A 1×1 solid-red PNG (verified to decode as `RGB(255,0,0)`) is sent as a
`FilePart` and the harness asserts the model's reply mentions `red`.
Confirms image content blocks reach the vision path via stream-json
stdin.

```bash
node packages/client/scripts/e2e-claude-input-image.mjs
```

Expected (≈ 11 s): final assistant text `red`.

### 3. URI image input — `e2e-claude-input-image-uri.mjs`

A public 1×1 solid-red PNG URL is sent as a uri-only `FilePart` with no
inline `bytes`, and the harness asserts the model's reply mentions
`red`. Confirms bridge clients fetch inbound file URIs before building
the Claude vision content block.

```bash
node packages/client/scripts/e2e-claude-input-image-uri.mjs
# Override the fixture URI:
E2E_IMAGE_URI=https://example.com/red.png node packages/client/scripts/e2e-claude-input-image-uri.mjs
```

Expected (≈ 6 s): final assistant text `red`.

### 4. PDF input — `e2e-claude-input-pdf.mjs`

Generates a 1-page PDF on the fly with a known word (default `KUMQUAT`)
drawn in Helvetica, sends it as a `FilePart` with `mimeType:
"application/pdf"`, and asserts the model's reply contains the word.
Confirms `document` content blocks reach the model.

```bash
node packages/client/scripts/e2e-claude-input-pdf.mjs
# Override the secret word:
E2E_PDF_WORD=PINEAPPLE node packages/client/scripts/e2e-claude-input-pdf.mjs
```

Expected (≈ 7 s): final assistant text equals the secret word.

### 5. send_file MCP — `e2e-claude-send-file.mjs`

Most complex path. The harness:

1. Writes a known fixture file under `/tmp/claude-send-file-e2e/`.
2. Creates a backend with `sendFileMcp.allowedRoots` pointing at that
   directory. The backend lazy-starts a Streamable HTTP MCP server on
   `127.0.0.1:<random>` and registers it into the spawned `claude` via
   `--mcp-config`.
3. Sends a prompt instructing the model to call `send_file(path)` from
   the `vicoop-bridge` MCP server.
4. Asserts the run produced an artifact named `send-file` containing a
   `FilePart` whose decoded bytes equal the fixture content.

```bash
node packages/client/scripts/e2e-claude-send-file.mjs
```

Expected (≈ 16 s):

```
[claude] send_file MCP server listening at http://127.0.0.1:<port>/mcp
[frame +Xms]  task.artifact name=send-file parts=[file]
[frame +Yms]  task.artifact name=claude-message parts=[text]
[frame +Zms]  task.complete state=completed
[e2e] PASS: terminal is task.complete with state=completed
[e2e] PASS: at least one artifact with name="send-file"
[e2e] PASS: at least one FilePart artifact
[e2e] PASS: FilePart bytes match fixture
```

The harness uses `--permission-mode bypassPermissions` so the model
isn't blocked on a permission prompt for the new MCP tool.

## Troubleshooting

### `claude` exits with `auth required`

The CLI is not signed in for this user. Run `claude` once interactively
or set up `ANTHROPIC_API_KEY`.

### Image / PDF harness asserts the wrong color or word

The harness's fixture data is wrong, not the backend. Decode the
fixture independently:

```js
node -e "
const fs = require('node:fs');
const zlib = require('node:zlib');
const b = fs.readFileSync('/path/to/file.png');
let i = 8;
while (i < b.length) {
  const len = b.readUInt32BE(i);
  const type = b.subarray(i+4, i+8).toString('ascii');
  if (type === 'IDAT') {
    const inflated = zlib.inflateSync(b.subarray(i+8, i+8+len));
    console.log('R G B =', inflated[1], inflated[2], inflated[3]);
    break;
  }
  i += 12 + len;
}
"
```

If the bytes match the assertion target but the model still answers
wrong, the problem is on the model side — re-run once before flagging
it as a regression.

### send_file harness gets `[e2e] FAIL: at least one FilePart artifact`

The model received the prompt but did not invoke the tool. Re-run with
a more directive prompt:

```bash
E2E_PROMPT='Call send_file with path "/tmp/claude-send-file-e2e/tool-output.txt" right now. Reply only after the tool returns.' \
  node packages/client/scripts/e2e-claude-send-file.mjs
```

If the tool is invoked but `bytes` don't match, the most likely cause
is a path-canonicalization mismatch between `allowedRoots` and the path
the model passed. Add `console.log` inside `claude.ts` near the
`registerActiveTask` site to confirm what the MCP server actually saw.

### Process hangs after `task.status state=working`

The CLI is waiting on input. The harness `end()`s stdin immediately
after writing the envelope, so a hang here means the spawned `claude`
either didn't see the EOF (check `--input-format stream-json` is
present in argv) or is blocked on the first model call. Re-run with
`--debug` appended to `extraArgs` in the harness to see CLI internals.

## Coverage matrix

| Path | Harness | Validates |
|---|---|---|
| Text → text | text-smoke | stream-json stdin envelope, `--session-id`, `result` event parsing |
| Image FilePart → model | input-image | image content block reaches vision |
| URI image FilePart → model | input-image-uri | client-side file URI fetch, image content block reaches vision |
| PDF FilePart → model | input-pdf | document content block reaches doc parser |
| Model → file artifact | send-file | `--mcp-config` injection, R1 routing, MCP `send_file` tool, bounded read, `task.artifact` round-trip |

The `tool_result` image passthrough (issue #86 task 2a) is covered by
the unit test `emits FilePart artifact when tool_result contains an
image block`. An e2e harness for that path would require a separate MCP
server that actually returns image blocks; deferred until a real use
case lands.

## Progress visibility and traces (issues #100, #111)

Long-running tool work used to look identical to a hung process: a
single `task.status: working` followed by a multi-minute silence until
the final assistant text. The bridge now separates caller-visible
progress from execution trace details:

- A configurable idle-silence heartbeat (`heartbeatMs`, default 30 s)
  emits a bare `task.status: working` whenever no other frame has gone
  out for that many ms. Disabled with `heartbeatMs: 0`. Backstop for
  any future case where work happens without an interleaved model turn.
- When the caller opts into the Traceability Extension with
  `X-A2A-Extensions: https://github.com/a2aproject/a2a-samples/extensions/traceability/v1`,
  `tool_use` blocks inside an `assistant` event become
  `claude-tool-call` artifacts. Each artifact carries a head-truncated
  `<tool>: <input>` text part (<= 200 chars — **size guard only**, not a
  secrets guard; tokens or keys appearing in the head will still be
  emitted) plus a `data` part with `{ toolName, toolUseId }` for
  filtering. The artifact also carries the Traceability Extension URI in
  `artifact.extensions`.
- Tool-result image/PDF media from Claude's synthetic `user` events is
  also treated as trace output and is only emitted when the same
  extension is requested.

Text-only `tool_result` blocks are still dropped — gating that stream
needs a truncation policy that hasn't been settled (see #100 "B"). The
explicit `send_file` MCP artifact path is unchanged and remains visible
without Traceability Extension opt-in.
