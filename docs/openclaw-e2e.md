# OpenClaw backend E2E

Workflow for exercising the `openclaw` backend directly against a real
OpenClaw gateway in Docker, without standing up the bridge server / caller
token / A2A HTTP stack. Useful when changing `packages/client/src/backends/openclaw.ts`
or debugging a contract mismatch with OpenClaw itself.

The faked-gateway unit tests in `openclaw.test.ts` cover most shapes, but
they can't catch divergence from the real image (protocol version drift,
event ordering, stop-reason strings, etc.). This guide fills that gap.

## Prerequisites

- Docker running (colima, Docker Desktop, or Linux-native).
- Repo built: `pnpm install && pnpm --filter @vicoop-bridge/client build`.
- Network egress to `ghcr.io` if the image isn't pulled yet.

## Bring up the gateway

```bash
docker run --rm -d --name openclaw-e2e ghcr.io/openclaw/openclaw:latest
# Default entrypoint: `node openclaw.mjs gateway --allow-unconfigured`.
# Gateway binds to 127.0.0.1 INSIDE the container (loopback only).
sleep 8   # first boot writes config + starts listening
```

Extract the auto-generated auth token (the gateway rotates it per container
unless a config is mounted):

```bash
TOKEN=$(docker exec openclaw-e2e sh -c 'cat /home/node/.openclaw/openclaw.json' \
  | grep -oE '"token":\s*"[a-f0-9]+"' | head -1 | sed 's/.*"\([a-f0-9]*\)"/\1/')
echo "$TOKEN"
```

Confirm the gateway is listening:

```bash
docker logs openclaw-e2e 2>&1 | grep 'gateway.*listening'
# [gateway] listening on ws://127.0.0.1:18789, ws://[::1]:18789
```

## Drive the backend against it

Because the gateway binds to the container's loopback, the Mac host cannot
reach it directly via `-p 18789:18789` (the port forward doesn't bridge
loopback). Run the backend inside a sidecar Node container that shares the
gateway's network namespace.

Example script — drop at `packages/client/scripts/e2e-openclaw-cancel.mjs`
(path is arbitrary; the import paths below assume this location):

```js
import { createOpenclawBackend } from '../dist/backends/openclaw.js';

const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
if (!TOKEN) { console.error('set OPENCLAW_GATEWAY_TOKEN'); process.exit(1); }

const backend = createOpenclawBackend({
  url: 'ws://127.0.0.1:18789',
  token: TOKEN,
  debug: true,             // prints every chat event
  taskTimeoutMs: 60_000,
});

const frames = [];
const controller = new AbortController();

const task = {
  type: 'task.assign',
  taskId: `e2e-${Date.now()}`,
  contextId: `e2e-ctx-${Date.now()}`,
  message: {
    role: 'user',
    messageId: `e2e-msg-${Date.now()}`,
    parts: [{ kind: 'text', text: 'long prompt that OpenClaw will take a while on' }],
  },
};

const pending = backend.handle(task, (f) => { frames.push(f); console.log('[frame]', f.type, JSON.stringify(f).slice(0, 200)); }, controller.signal);

// Exercise the path you care about. Examples:
//   - post-ack cancel:   await sleep(1500); controller.abort();
//   - pre-ack cancel:    controller.abort();   (synchronous, before even chat.send)
//   - no cancel:         (skip the abort; observe a full completion)
await new Promise((r) => setTimeout(r, 1500));
controller.abort();

await pending;
console.log('terminal:', frames.find((f) => f.type === 'task.complete' || f.type === 'task.fail'));
```

Run it:

```bash
# Rebuild if src/ changed.
pnpm --filter @vicoop-bridge/client build

docker run --rm \
  --network container:openclaw-e2e \
  -v "$PWD":/w -w /w/packages/client \
  -e OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
  node:20 \
  node ./scripts/e2e-openclaw-cancel.mjs
```

`--network container:openclaw-e2e` shares the gateway's net namespace, so
`ws://127.0.0.1:18789` inside the sidecar points at the gateway's loopback.

### Expected output (post-ack cancel path)

```
[openclaw] connected ws://127.0.0.1:18789/
[frame] task.status  … state: working …
[openclaw] chat event: {"runId":…,"state":"aborted","stopReason":"rpc"}
[frame] task.complete … state: canceled …
```

`stopReason: "rpc"` is OpenClaw's confirmation that it stopped the run in
response to a `chat.abort` RPC — i.e. the backend's signal-abort path
reached the gateway correctly.

## Streaming verification

A second E2E exercise lives at `packages/client/scripts/e2e-openclaw-streaming.mjs`.
It sends a tool-use-prone prompt, collects the emitted A2A frames, and
asserts:

- at least one `task.artifact` arrives before `task.complete`,
- all `artifactId`s are distinct,
- the terminal frame is `task.complete` with `state: "completed"`,
- if two or more artifacts were emitted, the first precedes the
  terminal frame in time (otherwise the assertion is skipped — a
  single-artifact run is the documented graceful-degradation shape and
  still satisfies the streaming contract).

Run the same way as the cancel example, with the agent's auth
configured so a real model can respond:

```bash
# Either mount a prepared auth-profiles.json into the gateway:
docker run --rm -d --name openclaw-e2e \
  -v "$HOME/.openclaw-e2e/auth-profiles.json:/home/node/.openclaw/agents/main/agent/auth-profiles.json:ro" \
  ghcr.io/openclaw/openclaw:latest

# ...or interactively register a provider before running the sidecar:
docker exec -it openclaw-e2e openclaw agents add main

TOKEN=$(docker exec openclaw-e2e sh -c 'cat /home/node/.openclaw/openclaw.json' \
  | grep -oE '"token":\s*"[a-f0-9]+"' | head -1 | sed 's/.*"\([a-f0-9]*\)"/\1/')

docker run --rm \
  --network container:openclaw-e2e \
  -v "$PWD":/w -w /w/packages/client \
  -e OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
  node:20 \
  node ./scripts/e2e-openclaw-streaming.mjs
```

Without auth configured the harness still passes (the gateway emits a
single assistant "agent failed before reply" transcript entry, which
proves the `session.message → task.artifact` wiring end-to-end), but
you cannot verify the multi-artifact cadence a real tool-use run
produces. Use `DEBUG=1` in the sidecar env to see every chat /
session.message frame as it arrives.

## File-passthrough verification (caller → agent)

A third exercise at `packages/client/scripts/e2e-openclaw-file-passthrough.mjs`
verifies that bridge-client's non-image attachment mapping matches the
shape OpenClaw `>= v2026.4.27` expects on `chat.send`. The script sends
a tiny synthetic PDF as a `kind: 'file'` part with `mimeType:
'application/pdf'` and asserts:

- the gateway accepts the attachment shape (no `chat.send` error like
  "only image/* supported" or "non-image attachments are not supported
  on this entrypoint"),
- any failure that follows is downstream of attachment parsing
  (typically agent auth / model invocation, which is acceptable when
  no provider auth is configured).

Because the protocol-level test does not need a real model response,
you can run it against an unauthenticated gateway. The cleanest setup
is `gateway.auth.mode = "none"` + `--bind loopback` (avoids container
token extraction entirely):

```bash
docker run -d --name openclaw-e2e \
  --entrypoint /bin/sh \
  ghcr.io/openclaw/openclaw:latest \
  -c 'mkdir -p /home/node/.openclaw && \
      printf %s "{\"gateway\":{\"auth\":{\"mode\":\"none\"}}}" \
        > /home/node/.openclaw/openclaw.json && \
      exec docker-entrypoint.sh node openclaw.mjs gateway \
        --allow-unconfigured --bind loopback'

# wait for "[gateway] ready" in `docker logs openclaw-e2e`

docker run --rm \
  --network container:openclaw-e2e \
  -v "$PWD":/w -w /w/packages/client \
  -e DEBUG=1 \
  node:20 \
  node ./scripts/e2e-openclaw-file-passthrough.mjs
```

Expected tail:

```
[frame +Xms] task.artifact artifact id=… name=openclaw-result …
[frame +Xms] task.complete complete state=completed
[e2e] PASS: gateway accepted non-image attachment shape (no protocol-shape rejection)
[e2e] PASS: task.complete carries state=completed (got completed)
```

If you see a fail like `code=gateway_send_failed msg="…only image/* supported…"`,
the gateway image is older than v2026.4.27 and predates the non-image
attachment acceptance path (CHANGELOG: "Gateway/chat: accept non-image
attachments through chat.send by staging them as agent-readable media
paths"). Pull a newer tag.

> **Note**: `--bind loopback` is required when `auth.mode = "none"` —
> the container default of `bind=auto` (0.0.0.0) refuses to start
> unauthenticated. Loopback is fine because the sidecar shares the
> gateway container's network namespace via `--network container:…`
> and connects through `127.0.0.1` from inside.

## Outbound attachment verification (agent → caller)

A fourth exercise at
`packages/client/scripts/e2e-openclaw-attach-outputs.mjs` verifies the
opposite direction: bridge-client parses `[bridge-attach: <path>]`
markers in real assistant messages, reads the referenced file from
disk, and emits it as an A2A FilePart artifact alongside the cleaned
text.

The script:

- writes a fixture at `/tmp/attach-test/hello.txt` (sidecar-private —
  the gateway never sees it; markers are pure text in the chat
  transcript),
- configures bridge-client with `attachOutputs.allowedRoots: ['/tmp/attach-test']`,
- prompts the model to reply with EXACTLY `[bridge-attach: <fixture-path>]`,
- asserts that the resulting artifact carries a FilePart whose decoded
  bytes equal the fixture content, the filename matches, and the
  marker is stripped from the text part.

Unlike the file-passthrough exercise, this one needs a working agent
provider so the model actually replies. Cheapest setup is an
Anthropic API key + `anthropic/claude-sonnet-4-6`:

```bash
mkdir -p /tmp/oc-build-anthropic
cat > /tmp/oc-build-anthropic/Dockerfile << 'EOF'
FROM ghcr.io/openclaw/openclaw:latest
USER root
RUN mkdir -p /home/node/.openclaw && \
    printf '%s' '{"gateway":{"auth":{"mode":"none"}},"agents":{"defaults":{"model":{"primary":"anthropic/claude-sonnet-4-6"}}}}' \
      > /home/node/.openclaw/openclaw.json && \
    chown -R node:node /home/node/.openclaw
USER node
EOF
docker build -t oc-e2e-anthropic /tmp/oc-build-anthropic

docker run -d --name openclaw-e2e \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  oc-e2e-anthropic \
  node openclaw.mjs gateway --allow-unconfigured --bind loopback

# wait for "[gateway] ready"

docker run --rm \
  --network container:openclaw-e2e \
  -v "$PWD":/w -w /w/packages/client \
  -e DEBUG=1 \
  node:20 \
  node ./scripts/e2e-openclaw-attach-outputs.mjs
```

Expected tail (sonnet-4-6 will echo the marker exactly given the
"reply with EXACTLY" framing):

```
[frame +Xms] task.artifact artifact id=… name=openclaw-result parts=[file]
[frame +Xms] task.complete complete state=completed
[e2e] PASS: terminal frame is task.complete with state=completed
[e2e] PASS: at least one FilePart artifact emitted
[e2e] PASS: FilePart bytes match fixture
[e2e] PASS: FilePart name is fixture basename
[e2e] PASS: marker stripped from artifact text on success
```

Costs roughly one short Claude call per run (a few cents). Mounting a
real `auth-profiles.json` from the host instead of using
`ANTHROPIC_API_KEY` works too, but mind that OAuth-based providers
(e.g. `openai-codex`) may fail to refresh from inside a container with
restricted network paths — the API-key route is the most reliable.

## MCP send_file tool verification (agent → caller, structured path)

A fifth exercise at
`packages/client/scripts/e2e-openclaw-send-file.mjs` verifies the
tool-call alternative to text markers: bridge-client exposes a local
Streamable HTTP MCP server with a `send_file(path, name?)` tool, the
operator registers it in OpenClaw's `mcp.servers` config, and the
agent invokes the tool to deliver files instead of emitting a text
marker.

The script:

- writes a fixture at `/tmp/send-file-test/tool-output.txt` (sidecar-
  private),
- enables `sendFileMcp` on the backend with the fixture dir as an
  allowed root and a fixed port (default `19090`, override with
  `SEND_FILE_MCP_PORT`),
- prompts the model to call `send_file` with the fixture path,
- asserts the resulting artifact carries `name="send-file"` (the MCP
  tool path tag) and the FilePart bytes equal the fixture content.

Setup uses the stock OpenClaw image and the canonical
`openclaw mcp set` CLI to register the bridge-client MCP server —
matching how operators add MCP servers in production. The startup
shell writes a minimal config (auth + model), runs `openclaw mcp set`
to add the `send-file` server, then execs the gateway:

```bash
docker run -d --name openclaw-e2e \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  --entrypoint /bin/sh \
  ghcr.io/openclaw/openclaw:latest \
  -c '
    set -e
    mkdir -p /home/node/.openclaw
    printf "%s" "{\"gateway\":{\"auth\":{\"mode\":\"none\"}},\"agents\":{\"defaults\":{\"model\":{\"primary\":\"anthropic/claude-sonnet-4-6\"}}}}" \
      > /home/node/.openclaw/openclaw.json
    cd /app
    node openclaw.mjs mcp set send-file \
      "{\"url\":\"http://127.0.0.1:19090/mcp\",\"transport\":\"streamable-http\"}"
    exec docker-entrypoint.sh node openclaw.mjs gateway \
      --allow-unconfigured --bind loopback
  '

# wait for "[gateway] ready"

docker run --rm \
  --network container:openclaw-e2e \
  -v "$PWD":/w -w /w/packages/client \
  -e DEBUG=1 \
  node:20 \
  node ./scripts/e2e-openclaw-send-file.mjs
```

In production the same registration is a one-shot operator step:

```bash
openclaw mcp set send-file \
  '{"url":"http://127.0.0.1:19090/mcp","transport":"streamable-http"}'
```

The CLI persists the entry into `~/.openclaw/openclaw.json`'s
`mcp.servers.send-file`, picked up at the next gateway boot.

Expected tail:

```
[frame +Xms] task.artifact artifact id=… name=send-file parts=[file]
[frame +Xms] task.complete complete state=completed
[e2e] PASS: terminal frame is task.complete with state=completed
[e2e] PASS: at least one FilePart artifact emitted via send_file tool
[e2e] PASS: at least one artifact with name="send-file" (the MCP tool path tag)
[e2e] PASS: FilePart bytes match fixture
```

Notes:

- OpenClaw prefixes external MCP tool names with the server name, so
  the agent sees `send-file__send_file` in its tool catalog.
- The bridge-client lazy-starts the MCP HTTP listener inside `handle()`,
  so the gateway's `bundle-mcp` runtime must reach it AFTER bridge-client
  has registered an active task. With `--network container:` shared
  loopback this works because OpenClaw computes the per-session catalog
  on first `chat.send` (after bridge-client is up), not at boot.
- Routing: `sendFileMcp` follows R1 — single in-flight task per backend.
  Concurrent calls during overlapping tasks return `ambiguous-task`.
- The text-marker `attachOutputs` path remains supported and may be
  enabled simultaneously as a fallback for callers that don't register
  the MCP server.

## Teardown

```bash
docker rm -f openclaw-e2e
```

## Gotchas

- **Don't port-forward to the Mac host.** `-p 18789:18789` plus connecting
  to `ws://127.0.0.1:18789` from the host returns `socket hang up`: the
  gateway binds to the container's loopback (`127.0.0.1:18789` inside the
  container), and Docker's port forward reaches the container's external
  interface which isn't being listened on. Use `--network container:…`
  from a sidecar instead.

- **Don't pass `--bind lan` without a preconfigured `openclaw.json`.** It
  activates a Control UI origin check that fails the boot unless
  `gateway.controlUi.allowedOrigins` is set or
  `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback: true` is
  present. For E2E purposes the default loopback bind is easier.

- **Don't mount the worktree and run `tsx` inside the Linux sidecar.** The
  repo's `node_modules` on macOS contains `@esbuild/darwin-arm64`; the
  Linux sidecar needs `@esbuild/linux-arm64` and `tsx` will explode at the
  first `.ts` import. Build to `dist/` first and run plain `.mjs` / `.js`.

- **Auth token rotates per container start** unless you mount a config
  volume. Re-extract after each `docker run`.

- **`CLAUDE_AI_SESSION_KEY` is not required** for protocol-level tests
  (connect, `chat.send` ack, `chat.abort`, `state: aborted` echo). Cancel
  paths land before any real Claude invocation would matter. If you're
  testing happy-path completions with real model output, mount it via
  `-e CLAUDE_AI_SESSION_KEY=…` on the gateway container.

## When to use this vs. the unit tests

- **Unit tests (`pnpm --filter @vicoop-bridge/client test`)** — cover all
  shapes by faking the gateway. Fast. Run on every change.
- **This E2E** — run when you touch the gateway RPC contract (`chat.send`,
  `chat.abort`, event mapping, stop-reason handling), when bumping
  `GATEWAY_PROTOCOL_VERSION`, or when OpenClaw releases a new version and
  you want to confirm nothing drifted. Not part of CI.
