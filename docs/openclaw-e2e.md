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
