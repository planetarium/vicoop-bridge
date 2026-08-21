import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  encodeFrame,
  parseUpFrame,
  OPENAI_COMPAT_EXTENSION_URI,
  type Part,
  type TaskAssignFrame,
  type UpFrame,
} from '@vicoop-bridge/protocol';
import type { Backend, Emit } from './backend.js';
import { Client, processTask, summarizeParts } from './client.js';
import { type ConsoleSink, createLogger } from './logger.js';

interface CapturedSink {
  log: string[];
  warn: string[];
  error: string[];
  sink: ConsoleSink;
}

function makeSink(): CapturedSink {
  const log: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  const join = (a: unknown[]): string =>
    a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ');
  return {
    log,
    warn,
    error,
    sink: {
      log: (...a: unknown[]) => log.push(join(a)),
      warn: (...a: unknown[]) => warn.push(join(a)),
      error: (...a: unknown[]) => error.push(join(a)),
    },
  };
}

function captureSend(): { sent: UpFrame[]; send: (f: UpFrame) => void } {
  const sent: UpFrame[] = [];
  return {
    sent,
    send: (f) => {
      sent.push(f);
    },
  };
}

function makeAssign(taskId: string): TaskAssignFrame {
  return {
    type: 'task.assign',
    taskId,
    contextId: 'ctx',
    message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }], messageId: 'm1' },
  };
}

function backendOf(name: string, handle: Backend['handle']): Backend {
  return { name, handle };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return `ws://127.0.0.1:${addr.port}`;
}

async function closeServer(server: Server, wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve, reject) => {
    wss.close((wssErr) => {
      server.close((serverErr) => {
        const err = wssErr ?? serverErr;
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test('summarizeParts: empty', () => {
  assert.equal(summarizeParts([]), '(none)');
});

test('summarizeParts: text part reports text/plain', () => {
  const parts: Part[] = [{ kind: 'text', text: 'hi' }];
  assert.equal(summarizeParts(parts), 'text/plain');
});

test('summarizeParts: file part uses declared mimeType', () => {
  const parts: Part[] = [{ kind: 'file', file: { name: 'a.png', mimeType: 'image/png' } }];
  assert.equal(summarizeParts(parts), 'image/png');
});

test('summarizeParts: file part without mimeType falls back to octet-stream', () => {
  const parts: Part[] = [{ kind: 'file', file: { name: 'a.bin' } }];
  assert.equal(summarizeParts(parts), 'application/octet-stream');
});

test('summarizeParts: file part with empty/whitespace mimeType falls back to octet-stream', () => {
  const empty: Part[] = [{ kind: 'file', file: { name: 'a.bin', mimeType: '' } }];
  assert.equal(summarizeParts(empty), 'application/octet-stream');
  const whitespace: Part[] = [{ kind: 'file', file: { name: 'a.bin', mimeType: '   \t' } }];
  assert.equal(summarizeParts(whitespace), 'application/octet-stream');
});

test('summarizeParts: data part reports application/json', () => {
  const parts: Part[] = [{ kind: 'data', data: { foo: 'bar' } }];
  assert.equal(summarizeParts(parts), 'application/json');
});

test('summarizeParts: dedupes mime types and preserves first-seen order', () => {
  const parts: Part[] = [
    { kind: 'text', text: 'one' },
    { kind: 'file', file: { name: 'a.png', mimeType: 'image/png' } },
    { kind: 'text', text: 'two' },
    { kind: 'file', file: { name: 'b.png', mimeType: 'image/png' } },
    { kind: 'data', data: {} },
  ];
  assert.equal(summarizeParts(parts), 'text/plain,image/png,application/json');
});

test('summarizeParts: sanitizes hostile mimeType so it cannot inject newlines', () => {
  const parts: Part[] = [
    {
      kind: 'file',
      file: { name: 'a.png', mimeType: 'image/png\n[client] FAKE INJECTED LINE' },
    },
  ];
  const summary = summarizeParts(parts);
  assert.equal(summary.includes('\n'), false, 'summary must not contain raw newlines');
  assert.match(summary, /image\/png\\n\[client\] FAKE INJECTED LINE/);
});

test('summarizeParts: does not include user-supplied content', () => {
  const secret = 'super-secret-token';
  const parts: Part[] = [
    { kind: 'text', text: secret },
    { kind: 'file', file: { name: secret, mimeType: 'image/png', bytes: secret } },
    { kind: 'data', data: { token: secret } },
  ];
  const summary = summarizeParts(parts);
  assert.equal(summary.includes(secret), false);
});

test('Client logs identity block (mention/acct/a2a/card/webfinger) once on connect', async () => {
  // Operators shouldn't need to run `vicoop-client whoami` in a second
  // shell to learn the agent's externally-visible identifiers. The daemon
  // surfaces the same block as part of the connect log, exactly once per
  // process — reconnects don't repeat it because the data hasn't changed.
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);
  const connections: WebSocket[] = [];
  let helloCount = 0;
  wss.on('connection', (ws) => {
    connections.push(ws);
    ws.on('message', () => {
      helloCount++;
    });
  });

  const c = makeSink();
  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => {
      /* no tasks */
    }),
    logSink: c.sink,
    logLevel: 'info',
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    reconnectJitterRatio: 0,
    reconnectStableMs: 0,
    heartbeatIntervalMs: 0,
  });

  try {
    client.start();
    await waitFor(() => helloCount === 1, 'expected initial hello');
    // Initial connect produced the identity block.
    const identityLines = c.log.filter(
      (l) =>
        l.includes('mention:') ||
        l.includes('acct:') ||
        l.includes('[client] a2a:') ||
        l.includes('a2a card:') ||
        l.includes('webfinger:') ||
        l.includes('[client] agentId:'),
    );
    assert.equal(identityLines.length, 6, `expected 6 identity lines, got ${identityLines.length}: ${JSON.stringify(identityLines)}`);
    // Spot-check that the URLs were derived from the test server URL.
    assert.ok(c.log.some((l) => l.includes('@agent-1@127.0.0.1')), 'mention line not found');
    assert.ok(c.log.some((l) => l.includes('acct:agent-1@127.0.0.1')), 'acct line not found');
    assert.ok(c.log.some((l) => l.includes('/agents/agent-1')), 'a2a URL not found');

    // Force a reconnect and confirm the block is NOT printed again.
    const linesBeforeReconnect = c.log.length;
    connections[0]!.close(1012, 'service restart');
    await waitFor(() => helloCount === 2, 'expected hello after reconnect');
    const newLines = c.log.slice(linesBeforeReconnect);
    assert.ok(
      !newLines.some(
        (l) => l.includes('mention:') || l.includes('webfinger:'),
      ),
      `identity block should not repeat on reconnect, got: ${JSON.stringify(newLines)}`,
    );
  } finally {
    client.stop();
    await closeServer(server, wss);
  }
});

test('Client.stop invokes backend.stop so long-lived children are torn down (#186)', async () => {
  // The codex backend keeps a `codex app-server` subprocess alive across
  // tasks via its `AppServerRpcClient` singleton — per-task AbortSignal
  // doesn't reach it. Without an explicit `backend.stop()` on daemon
  // shutdown, the child gets re-parented to init and lingers, which is
  // what the macOS report in #186 observed. Assert here that Client.stop
  // calls the optional hook, and tolerates a throwing implementation
  // without crashing the shutdown path (the daemon entrypoint follows
  // stop() with process.exit, so an unhandled throw would suppress the
  // exit semantics callers depend on).
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);

  let stopCalls = 0;
  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: {
      name: 'stub',
      handle: async () => {
        /* no tasks */
      },
      stop: () => {
        stopCalls++;
      },
    },
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    reconnectJitterRatio: 0,
    reconnectStableMs: 0,
    heartbeatIntervalMs: 0,
  });

  try {
    client.start();
    await waitFor(() => wss.clients.size === 1, 'expected one ws client');
    client.stop();
    assert.equal(stopCalls, 1, 'Client.stop must invoke backend.stop exactly once');

    // A throwing stop must not propagate out of Client.stop — the daemon
    // entrypoint calls process.exit on the next line and shouldn't be
    // hijacked by a buggy backend.
    const throwingClient = new Client({
      serverUrl,
      token: 'client-token',
      agentId: 'agent-2',
      backendKind: 'echo',
      backend: {
        name: 'stub',
        handle: async () => {
          /* no tasks */
        },
        stop: () => {
          throw new Error('boom');
        },
      },
      reconnectDelayMs: 10,
      reconnectMaxDelayMs: 10,
      reconnectJitterRatio: 0,
      reconnectStableMs: 0,
      heartbeatIntervalMs: 0,
    });
    throwingClient.start();
    await waitFor(() => wss.clients.size === 1, 'expected one ws client after second start');
    assert.doesNotThrow(() => throwingClient.stop());
  } finally {
    await closeServer(server, wss);
  }
});

test('Client reconnects after WebSocket close and sends hello again', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);
  const connections: WebSocket[] = [];
  const hellos: UpFrame[] = [];
  wss.on('connection', (ws) => {
    connections.push(ws);
    ws.on('message', (raw) => {
      hellos.push(parseUpFrame(typeof raw === 'string' ? raw : raw.toString('utf8')));
    });
  });

  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => {
      /* no tasks in this test */
    }),
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    reconnectJitterRatio: 0,
    reconnectStableMs: 0,
    heartbeatIntervalMs: 0,
  });

  try {
    client.start();
    await waitFor(() => hellos.length === 1, 'expected initial hello');
    connections[0]!.close(1012, 'service restart');
    await waitFor(() => hellos.length === 2, 'expected hello after reconnect');
    for (const frame of hellos) {
      assert.equal(frame.type, 'hello');
      if (frame.type === 'hello') {
        assert.equal(frame.agentId, 'agent-1');
        assert.equal(frame.token, 'client-token');
        assert.deepEqual(frame.protocolCapabilities, ['caller-context-v1']);
      }
    }
  } finally {
    client.stop();
    await closeServer(server, wss);
  }
});

test('Client stops on 4014 "client deleted", invokes onFatal, and does NOT reconnect (#166)', async () => {
  // When the bridge deletes the client mid-flight, the daemon must:
  //   1. surface the fatal close via `onFatal` so the entrypoint can
  //      drive process exit (the Client itself never calls process.exit),
  //   2. mark itself stopped and clear the reconnect timer so it does
  //      not loop forever against a permanently-failing auth.
  //
  // Asserting both: the recording onFatal must fire exactly once with
  // code 4014, and no second `hello` ever lands on the server.
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);
  const connections: WebSocket[] = [];
  let helloCount = 0;
  wss.on('connection', (ws) => {
    connections.push(ws);
    ws.on('message', () => helloCount++);
  });

  const fatalCalls: Array<{ code: number; reason: string }> = [];
  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => {
      /* no tasks */
    }),
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    reconnectJitterRatio: 0,
    reconnectStableMs: 0,
    heartbeatIntervalMs: 0,
    onFatal: (info) => fatalCalls.push(info),
  });

  interface Internals {
    stopped: boolean;
    reconnectTimer: unknown;
  }
  const internals = client as unknown as Internals;

  try {
    client.start();
    await waitFor(() => helloCount === 1, 'expected initial hello');
    connections[0]!.close(4014, 'client deleted');
    await waitFor(() => fatalCalls.length === 1, 'expected onFatal to fire');
    assert.equal(fatalCalls[0]!.code, 4014);
    assert.equal(fatalCalls[0]!.reason, 'client deleted');
    assert.equal(internals.stopped, true, 'client must mark itself stopped');
    assert.equal(internals.reconnectTimer, null, 'reconnect must not be scheduled');
    // Give the (would-be) reconnect plenty of headroom to misfire — if
    // the 4014 branch fell through to scheduleReconnect we'd see a
    // second hello within ~50ms (delay=10ms + a few ms of slack).
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(helloCount, 1, 'must not reconnect after 4014');
  } finally {
    client.stop();
    await closeServer(server, wss);
  }
});

test('Client stops on 4005 "bad token" too (delete-then-relaunch case, #166)', async () => {
  // 4005 is what ws.ts emits when the token lookup returns no row —
  // either the operator pasted the wrong secret, or the daemon was
  // relaunched after deletion without rotating. Both are permanent
  // auth failures, so the daemon must surface onFatal instead of
  // looping reconnects against an unreachable row.
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);
  const connections: WebSocket[] = [];
  let helloCount = 0;
  wss.on('connection', (ws) => {
    connections.push(ws);
    ws.on('message', () => helloCount++);
  });

  const fatalCalls: Array<{ code: number; reason: string }> = [];
  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => {
      /* no tasks */
    }),
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    reconnectJitterRatio: 0,
    reconnectStableMs: 0,
    heartbeatIntervalMs: 0,
    onFatal: (info) => fatalCalls.push(info),
  });

  try {
    client.start();
    await waitFor(() => helloCount === 1, 'expected initial hello');
    connections[0]!.close(4005, 'bad token');
    await waitFor(() => fatalCalls.length === 1, 'expected onFatal to fire on 4005');
    assert.equal(fatalCalls[0]!.code, 4005);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(helloCount, 1, 'must not reconnect after 4005');
  } finally {
    client.stop();
    await closeServer(server, wss);
  }
});

test('Client surfaces 4009 "duplicate token" with a dedicated warn and floors the reconnect delay (#270)', async () => {
  // The default 4009 path before this fix logged only the generic
  // "disconnected: 4009 …" line and looped reconnects at the normal
  // exponential backoff. Two daemons authenticated with the same
  // CLIENT_TOKEN (the bridge's clientId-level collision check, not the
  // operator-visible agent identity) ended up ping-ponging each other
  // indefinitely at the 30 s cap.
  //
  // The contract we're locking in here:
  //   1. A clear warn line names both the cause (same CLIENT_TOKEN) and
  //      the remediation (`pgrep -fl vicoop-client`).
  //   2. The next reconnect waits at least `collisionBackoffMs` so the
  //      duplicate-token loop damps out on the first cycle instead of
  //      hammering the server at the 30 s cap forever.
  //   3. 4009 is NOT fatal — if the other daemon goes away, this side
  //      still recovers automatically (just slowly).
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);
  const connections: WebSocket[] = [];
  let helloCount = 0;
  wss.on('connection', (ws) => {
    connections.push(ws);
    ws.on('message', () => helloCount++);
  });

  const fatalCalls: Array<{ code: number; reason: string }> = [];
  const captured = makeSink();
  // Small collisionBackoffMs keeps the test fast — the production default
  // is 5 min, which would dominate the test runtime. The point of the
  // assertion below is the floor *exists*, not its specific value.
  const COLLISION_FLOOR = 200;
  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => {
      /* no tasks */
    }),
    // Normal backoff would be 10 ms here. The collision floor (200 ms)
    // must override it.
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    reconnectJitterRatio: 0,
    reconnectStableMs: 0,
    heartbeatIntervalMs: 0,
    collisionBackoffMs: COLLISION_FLOOR,
    onFatal: (info) => fatalCalls.push(info),
    logSink: captured.sink,
  });

  try {
    client.start();
    await waitFor(() => helloCount === 1, 'expected initial hello');
    const closedAt = Date.now();
    connections[0]!.close(4009, 'another client with the same token connected');
    // The warn line must name both the CLIENT_TOKEN cause and the
    // pgrep-based remediation — both halves of the contract above.
    await waitFor(
      () => captured.warn.some((l) => l.includes('CLIENT_TOKEN') && l.includes('pgrep')),
      `expected dedicated 4009 warn, got warns: ${captured.warn.join(' | ')}`,
    );
    // Reconnect must respect the collision floor, not the 10 ms normal
    // delay. Wait until the second hello lands and verify the elapsed time
    // is at least the floor (with a small slack for test scheduling).
    await waitFor(() => helloCount === 2, 'expected reconnect after collision', 2000);
    const elapsed = Date.now() - closedAt;
    assert.ok(
      elapsed >= COLLISION_FLOOR - 20,
      `reconnect fired in ${elapsed}ms, expected >= ~${COLLISION_FLOOR}ms (collision floor)`,
    );
    // 4009 is not fatal — onFatal must NOT have fired.
    assert.deepEqual(fatalCalls, [], 'onFatal must not fire on 4009');
  } finally {
    client.stop();
    await closeServer(server, wss);
  }
});

test('Client treats reconnectable closes (1012) as non-terminal and does NOT call onFatal', async () => {
  // Companion to the 4014/4005 tests: a transient close code (here 1012
  // service restart, the same code the reconnect-happy-path test uses)
  // must fall through to the normal reconnect path and never trigger
  // the fatal callback.
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);
  const connections: WebSocket[] = [];
  let helloCount = 0;
  wss.on('connection', (ws) => {
    connections.push(ws);
    ws.on('message', () => helloCount++);
  });

  const fatalCalls: Array<{ code: number; reason: string }> = [];
  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => {
      /* no tasks */
    }),
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    reconnectJitterRatio: 0,
    reconnectStableMs: 0,
    heartbeatIntervalMs: 0,
    onFatal: (info) => fatalCalls.push(info),
  });

  try {
    client.start();
    await waitFor(() => helloCount === 1, 'expected initial hello');
    connections[0]!.close(1012, 'service restart');
    await waitFor(() => helloCount === 2, 'expected reconnect after non-fatal close');
    assert.deepEqual(fatalCalls, [], 'onFatal must not fire on reconnectable closes');
  } finally {
    client.stop();
    await closeServer(server, wss);
  }
});

test('Client reconnect timer is refed so a disconnected daemon stays alive (#156)', async () => {
  // Regression: scheduleReconnect() previously called `.unref()` on the
  // reconnect timer. With the WS dropped and the heartbeat / reset timers
  // already cleared, that left the daemon process with no refed handles
  // and Node exited before the first reconnect attempt fired. The existing
  // "reconnects after WebSocket close" test above passes regardless of the
  // unref because the test process has the mock WebSocketServer and http
  // server keeping the loop alive on their own. We assert directly on the
  // refed-ness of the scheduled timer instead, so the regression is caught
  // even in-process.
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);
  const connections: WebSocket[] = [];
  let helloCount = 0;
  wss.on('connection', (ws) => {
    connections.push(ws);
    ws.on('message', () => helloCount++);
  });

  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => {
      /* no tasks */
    }),
    // Keep the reconnect delay long enough that the timer is still pending
    // when we inspect it below. Without this we'd race the reconnect itself.
    reconnectDelayMs: 5000,
    reconnectMaxDelayMs: 5000,
    reconnectJitterRatio: 0,
    reconnectStableMs: 0,
    heartbeatIntervalMs: 0,
  });

  // Private-field access for the regression check. The reconnect timer is
  // an implementation detail, but the invariant ("must keep the event loop
  // alive while disconnected") is part of the daemon contract — and the
  // only way to assert that in-process without a subprocess is to look at
  // the timer's `hasRef()`. Kept narrow so a refactor renaming the field
  // will fail loudly here.
  interface Internals {
    reconnectTimer: { hasRef(): boolean } | null;
  }
  const internals = client as unknown as Internals;

  try {
    client.start();
    await waitFor(() => helloCount === 1, 'expected initial hello');
    // Forcibly drop the connection on the server side. `terminate()` skips
    // the close-frame handshake so the client observes a 1006 abnormal
    // closure — matching the production repro in the issue and avoiding
    // the "1006 is not a transmissible code" error that `close(1006, ...)`
    // would throw on the server-side socket.
    connections[0]!.terminate();
    await waitFor(
      () => internals.reconnectTimer !== null,
      'expected reconnect timer to be scheduled after disconnect',
    );
    assert.equal(
      internals.reconnectTimer!.hasRef(),
      true,
      'reconnect timer must keep the event loop alive — without this the daemon exits on first disconnect (#156)',
    );
  } finally {
    client.stop();
    await closeServer(server, wss);
  }
});

test('Client daemon (subprocess) survives WS disconnect and reconnects (#156)', async () => {
  // End-to-end regression: spawn a real Node child that runs only the
  // Client (no other refed handles), force-close its WS, and assert that
  // the child stays alive long enough to reconnect. This is the scenario
  // the in-process tests can't reproduce — there the WebSocketServer and
  // http.Server keep the loop alive regardless of how the reconnect timer
  // is refed.
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);
  let helloCount = 0;
  wss.on('connection', (ws) => {
    ws.on('message', () => {
      helloCount++;
      // Drop the connection on the first hello so the child has to recover
      // via its reconnect path. 1006 is delivered as an abnormal closure on
      // the client side, matching the production reproduction in the issue.
      if (helloCount === 1) ws.terminate();
    });
  });

  const fixturePath = fileURLToPath(
    new URL('./reconnect-daemon-fixture.ts', import.meta.url),
  );
  // Invoke tsx's CLI script directly instead of `node --import tsx ...`.
  // `--import` was added in Node 20.6.0, but the repo's `engines.node` only
  // requires `>=20`, so 20.0–20.5 must also work; tsx 4.x's own CLI
  // registers its loader internally and is portable across every Node 20+
  // minor. Pinning to `process.execPath` keeps us off PATH so the child
  // runs under the same node binary as the parent test process.
  // `tsx/cli` is tsx 4.x's exported entry point that maps to its CLI
  // script (see the package's `exports` field). `tsx/dist/cli.mjs`
  // isn't a publicly exported path and throws ERR_PACKAGE_PATH_NOT_EXPORTED
  // under Node's exports-field enforcement.
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  const child = spawn(
    process.execPath,
    [tsxCli, fixturePath, serverUrl],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let exited = false;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.on('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });
  const stderr: string[] = [];
  child.stderr.on('data', (b: Buffer) => stderr.push(b.toString('utf8')));
  // The single try/finally below wraps the readiness wait *and* the
  // assertions so the child + mock server are cleaned up even when the
  // readiness path itself rejects (timeout or early exit). An earlier
  // shape put the readiness wait outside the try and would leak the child
  // and leave the WebSocketServer / http.Server open on those failure
  // modes, flaking the rest of the suite.
  try {
    // Wait for the child to print `daemon-ready` so we know the Client has
    // been constructed and `start()` has been called. Without this we could
    // race the child's startup and observe `helloCount === 0` purely
    // because the fixture hasn't connected yet. The three terminal paths
    // are unified through a single `cleanup` so an early `exit` rejects
    // the promise (it used to merely clear the timeout, which left the
    // promise pending forever on startup failures), the readiness signal
    // can resolve once, and the 5s timeout still fires if the child
    // neither readies nor exits.
    await new Promise<void>((resolve, reject) => {
      let buf = '';
      const cleanup = (): void => {
        child.stdout.off('data', onData);
        child.off('exit', onExit);
        clearTimeout(timeout);
      };
      const onData = (b: Buffer): void => {
        buf += b.toString('utf8');
        if (buf.includes('daemon-ready')) {
          cleanup();
          resolve();
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(
          new Error(
            `daemon fixture exited before becoming ready (code=${code} signal=${signal}). stderr: ${stderr.join('')}`,
          ),
        );
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `daemon fixture did not become ready within 5s. stderr: ${stderr.join('')}`,
          ),
        );
      }, 5000);
      child.stdout.on('data', onData);
      child.on('exit', onExit);
    });

    await waitFor(() => helloCount === 1, 'expected initial hello from child', 3000);
    // The server terminated the socket after the first hello. If the
    // daemon is healthy it reconnects after reconnectDelayMs (100ms in
    // the fixture) and sends a second hello. If the unref regression is
    // back, the child exits before the reconnect fires.
    await waitFor(
      () => helloCount === 2,
      `expected reconnect hello from daemon — child exited=${exited} info=${JSON.stringify(exitInfo)} stderr=${stderr.join('')}`,
      3000,
    );
    assert.equal(
      exited,
      false,
      `daemon must survive the disconnect; exited with ${JSON.stringify(exitInfo)} stderr=${stderr.join('')}`,
    );
  } finally {
    if (!exited) child.kill('SIGTERM');
    await closeServer(server, wss);
  }
});

// processTask lifecycle tests — exercise the runTask body directly with
// stub backends and a capturing send/logger so we don't need a real ws.

test('processTask: backend emits task.complete -> logs backend.start and task.complete', async () => {
  const c = makeSink();
  const s = captureSend();
  const backend = backendOf('stub', async (_t, emit: Emit) => {
    emit({ type: 'task.complete', taskId: 'T1', status: { state: 'completed' } });
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].type, 'task.complete');
  assert.equal(c.log.length, 2);
  assert.match(c.log[0], /backend\.start taskId=T1 backend=stub/);
  assert.match(c.log[1], /task\.complete taskId=T1 elapsedMs=\d+ artifacts=0/);
});

test('processTask: artifacts are deduped by artifactId across chunks', async () => {
  const c = makeSink();
  const s = captureSend();
  const backend = backendOf('stub', async (_t, emit) => {
    emit({
      type: 'task.artifact',
      taskId: 'T1',
      artifact: { artifactId: 'A', parts: [{ kind: 'text', text: 'p1' }] },
    });
    emit({
      type: 'task.artifact',
      taskId: 'T1',
      artifact: { artifactId: 'A', parts: [{ kind: 'text', text: 'p2' }] },
      lastChunk: true,
    });
    emit({
      type: 'task.artifact',
      taskId: 'T1',
      artifact: { artifactId: 'B', parts: [{ kind: 'text', text: 'b' }] },
      lastChunk: true,
    });
    emit({ type: 'task.complete', taskId: 'T1', status: { state: 'completed' } });
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  const completeLog = c.log.find((l) => l.includes('task.complete'));
  assert.ok(completeLog, 'task.complete log should be emitted');
  assert.match(completeLog, /artifacts=2/);
});

test('processTask: counts tagged liveness heartbeats and logs the count, ignoring plain working statuses (issue #414 hop-1 instrumentation)', async () => {
  const c = makeSink();
  const s = captureSend();
  const hb = { [OPENAI_COMPAT_EXTENSION_URI]: { heartbeat: true } };
  const backend = backendOf('stub', async (_t, emit: Emit) => {
    emit({ type: 'task.status', taskId: 'T1', status: { state: 'working' }, metadata: hb });
    emit({ type: 'task.status', taskId: 'T1', status: { state: 'working' }, metadata: hb });
    // A plain working status (no heartbeat marker) must NOT count as a beat.
    emit({ type: 'task.status', taskId: 'T1', status: { state: 'working' } });
    emit({ type: 'task.complete', taskId: 'T1', status: { state: 'completed' } });
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  const completeLog = c.log.find((l) => l.includes('task.complete'));
  assert.ok(completeLog, 'task.complete log should be emitted');
  assert.match(completeLog, /heartbeats=2/);
});

test('processTask: backend emits task.fail -> logs task.fail with code and message (#147)', async () => {
  const c = makeSink();
  const s = captureSend();
  const backend = backendOf('stub', async (_t, emit) => {
    emit({
      type: 'task.fail',
      taskId: 'T1',
      error: { code: 'rate_limited', message: 'slow down' },
    });
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  const failLog = c.log.find((l) => l.includes('task.fail'));
  assert.ok(failLog);
  assert.match(failLog, /code=rate_limited/);
  // The message must be surfaced so operators can debug from the
  // foreground log without enabling bridge-side wire tracing. Backends
  // pack stderr tails / argv / exit detail into error.message; the
  // previous log line dropped all of it.
  assert.match(failLog, /message=slow down/);
});

test('processTask: task.fail with multi-line message stays on a single log line', async () => {
  const c = makeSink();
  const s = captureSend();
  const backend = backendOf('stub', async (_t, emit) => {
    emit({
      type: 'task.fail',
      taskId: 'T1',
      error: {
        code: 'codex_exit_nonzero',
        message: 'codex exited with code 1: Not inside a trusted directory\nextra line',
      },
    });
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  const failLog = c.log.find((l) => l.includes('task.fail'));
  assert.ok(failLog);
  // Embedded newline must be escaped so the log line stays single-line.
  assert.doesNotMatch(failLog, /\n.*extra line/);
  assert.match(failLog, /trusted directory/);
});

test('processTask: backend resolves silently -> warns about missing terminal', async () => {
  const c = makeSink();
  const s = captureSend();
  const backend = backendOf('stub', async () => {
    /* no emits */
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  assert.equal(s.sent.length, 0);
  assert.equal(c.warn.length, 1);
  assert.match(c.warn[0], /backend\.end taskId=T1 .* \(no terminal frame\)/);
});

test('processTask: backend throws without emit -> emits backend_error fail and logs task.fail', async () => {
  const c = makeSink();
  const s = captureSend();
  const backend = backendOf('stub', async () => {
    throw new Error('boom');
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  assert.equal(s.sent.length, 1);
  const sent = s.sent[0];
  assert.equal(sent.type, 'task.fail');
  if (sent.type === 'task.fail') {
    assert.equal(sent.error.code, 'backend_error');
    assert.equal(sent.error.message, 'boom');
  }
  const failLog = c.log.find((l) => l.includes('task.fail'));
  assert.ok(failLog);
  assert.match(failLog, /code=backend_error/);
});

test('processTask: late-throw debug log preserves long error messages (not truncated at 200)', async () => {
  const c = makeSink();
  const s = captureSend();
  const longMessage = 'x'.repeat(1500);
  const backend = backendOf('stub', async (_t, emit) => {
    emit({ type: 'task.complete', taskId: 'T1', status: { state: 'completed' } });
    throw new Error(longMessage);
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  const debugLine = c.log.find((l) =>
    /backend threw after terminal taskId=T1.*message=/.test(l),
  );
  assert.ok(debugLine, `expected debug late-throw line, got: ${c.log.join(' | ')}`);
  // The full 1500-char message must be present (default lifecycle-token
  // limit of 200 would truncate it; this debug log uses a generous cap).
  assert.ok(
    debugLine.includes(longMessage),
    `expected full error message, got debug line of length ${debugLine.length}`,
  );
});

test('processTask: backend emits complete then throws -> does not double-emit, warns with errorClass only', async () => {
  const c = makeSink();
  const s = captureSend();
  // Use a custom Error subclass so we can assert the class name in the warn.
  class LateBoom extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'LateBoom';
    }
  }
  const backend = backendOf('stub', async (_t, emit) => {
    emit({ type: 'task.complete', taskId: 'T1', status: { state: 'completed' } });
    throw new LateBoom('user-prompt-secret-leak');
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  // Wire saw only the original task.complete; no fallback fail was sent.
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].type, 'task.complete');
  // warn: includes terminal kind + errorClass, but NOT the raw message.
  const warnLine = c.warn.find((l) => /backend threw after terminal taskId=T1/.test(l));
  assert.ok(warnLine, `expected late-throw warn, got: ${c.warn.join(' | ')}`);
  assert.match(warnLine, /terminal=complete/);
  assert.match(warnLine, /errorClass=LateBoom/);
  assert.equal(
    warnLine.includes('user-prompt-secret-leak'),
    false,
    'warn line must not include the raw error message',
  );
  // debug: full message available for opt-in operators.
  assert.ok(
    c.log.some((l) => /backend threw after terminal taskId=T1.*message=user-prompt-secret-leak/.test(l)),
  );
});

test('processTask: backend emits fail then throws -> does not double-emit, warns with errorClass only', async () => {
  const c = makeSink();
  const s = captureSend();
  const backend = backendOf('stub', async (_t, emit) => {
    emit({
      type: 'task.fail',
      taskId: 'T1',
      error: { code: 'upstream', message: 'gateway 500' },
    });
    throw new Error('post-fail boom');
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  assert.equal(s.sent.length, 1);
  const sent = s.sent[0];
  assert.equal(sent.type, 'task.fail');
  if (sent.type === 'task.fail') assert.equal(sent.error.code, 'upstream');
  const warnLine = c.warn.find((l) => /backend threw after terminal taskId=T1/.test(l));
  assert.ok(warnLine, `expected late-throw warn, got: ${c.warn.join(' | ')}`);
  assert.match(warnLine, /terminal=fail/);
  assert.match(warnLine, /errorClass=Error/);
  assert.equal(warnLine.includes('post-fail boom'), false, 'warn must not include raw message');
});

test('processTask: backend.start log uses the backend name', async () => {
  const c = makeSink();
  const s = captureSend();
  const backend = backendOf('my-special-backend', async (_t, emit) => {
    emit({ type: 'task.complete', taskId: 'T1', status: { state: 'completed' } });
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  assert.match(c.log[0], /backend\.start taskId=T1 backend=my-special-backend/);
});

test('processTask: backend throws after abort -> emits canceled task.complete, logs task.canceled (not task.fail)', async () => {
  const c = makeSink();
  const s = captureSend();
  const controller = new AbortController();
  controller.abort();
  const backend = backendOf('stub', async (_t, emit, signal) => {
    // Backend may have streamed an artifact before observing the abort —
    // the canceled log should still surface the artifact count.
    emit({
      type: 'task.artifact',
      taskId: 'T1',
      artifact: { artifactId: 'A', parts: [{ kind: 'text', text: 'partial' }] },
    });
    if (signal.aborted) throw new Error('aborted');
  });
  await processTask(makeAssign('T1'), controller.signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  // Wire saw the artifact + a canceled-state task.complete — not a backend_error fail.
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[0].type, 'task.artifact');
  const sent = s.sent[1];
  assert.equal(sent.type, 'task.complete');
  if (sent.type === 'task.complete') {
    assert.equal(sent.status.state, 'canceled');
    assert.ok(typeof sent.status.timestamp === 'string' && sent.status.timestamp.length > 0);
  }
  assert.ok(
    c.log.some((l) => /task\.canceled taskId=T1 elapsedMs=\d+ artifacts=1/.test(l)),
    `expected task.canceled log with artifacts=1, got: ${c.log.join(' | ')}`,
  );
  assert.ok(
    !c.log.some((l) => /task\.fail/.test(l)),
    'should not log task.fail when the throw is from cancellation',
  );
});

test('processTask: backend emits canceled task.complete on abort -> uses backend frame, logs task.canceled', async () => {
  // Well-behaved backend (like claude.ts): observes signal and emits its
  // own canceled-state task.complete instead of throwing. processTask
  // must use that frame as-is, not synthesize a fallback, and log it as
  // `task.canceled` (not `task.complete`) so the lifecycle log clearly
  // distinguishes a successful completion from a cancel.
  const c = makeSink();
  const s = captureSend();
  const controller = new AbortController();
  controller.abort();
  const backend = backendOf('stub', async (_t, emit, signal) => {
    if (signal.aborted) {
      emit({
        type: 'task.complete',
        taskId: 'T1',
        status: { state: 'canceled', timestamp: '2026-01-01T00:00:00Z' },
      });
    }
  });
  await processTask(makeAssign('T1'), controller.signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  assert.equal(s.sent.length, 1);
  const sent = s.sent[0];
  assert.equal(sent.type, 'task.complete');
  if (sent.type === 'task.complete') {
    assert.equal(sent.status.state, 'canceled');
    assert.equal(sent.status.timestamp, '2026-01-01T00:00:00Z');
  }
  assert.ok(
    c.log.some((l) => /task\.canceled taskId=T1 elapsedMs=\d+ artifacts=\d+/.test(l)),
    `expected task.canceled log, got: ${c.log.join(' | ')}`,
  );
  assert.ok(
    !c.log.some((l) => /task\.complete taskId=T1/.test(l)),
    'should not log task.complete for a canceled-state completion',
  );
});

test('processTask: sanitizes hostile taskId so wire data cannot inject log lines', async () => {
  const c = makeSink();
  const s = captureSend();
  const hostileTaskId = 'T1\n[client] FAKE INJECTED LINE';
  const backend = backendOf('stub', async (_t, emit) => {
    emit({ type: 'task.complete', taskId: hostileTaskId, status: { state: 'completed' } });
  });
  await processTask(
    { ...makeAssign(hostileTaskId), taskId: hostileTaskId },
    new AbortController().signal,
    {
      backend,
      send: s.send,
      logger: createLogger('debug', c.sink),
    },
  );
  // Every log line must remain single-line — no line should contain a raw
  // newline carried over from the taskId interpolation.
  for (const line of [...c.log, ...c.warn, ...c.error]) {
    assert.equal(
      line.includes('\n'),
      false,
      `log line contained a raw newline (log injection): ${JSON.stringify(line)}`,
    );
  }
  // The hostile suffix must appear escaped — operators can still see what
  // arrived, but it cannot break out of the line.
  assert.ok(
    c.log.some((l) => /backend\.start taskId=T1\\n\[client\] FAKE INJECTED LINE/.test(l)),
    `expected escaped taskId in backend.start, got: ${c.log.join(' | ')}`,
  );
});

test('processTask: forwards non-terminal frames (e.g. task.artifact, task.status) to send', async () => {
  const c = makeSink();
  const s = captureSend();
  const backend = backendOf('stub', async (_t, emit) => {
    emit({ type: 'task.status', taskId: 'T1', status: { state: 'working' } });
    emit({
      type: 'task.artifact',
      taskId: 'T1',
      artifact: { artifactId: 'A', parts: [{ kind: 'text', text: 'a' }] },
    });
    emit({ type: 'task.complete', taskId: 'T1', status: { state: 'completed' } });
  });
  await processTask(makeAssign('T1'), new AbortController().signal, {
    backend,
    send: s.send,
    logger: createLogger('debug', c.sink),
  });
  assert.deepEqual(
    s.sent.map((f) => f.type),
    ['task.status', 'task.artifact', 'task.complete'],
  );
});

// ── usage.request → usage.response dispatch ──────────────────────────────────
// Stand up a fake bridge server that, on hello, sends a `usage.request` down
// the wire, and capture the client's `usage.response`.
async function runUsageDispatch(backend: Backend): Promise<UpFrame[]> {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);
  const upFrames: UpFrame[] = [];
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const f = parseUpFrame(typeof raw === 'string' ? raw : raw.toString('utf8'));
      if (f.type === 'hello') {
        ws.send(encodeFrame({ type: 'usage.request', requestId: 'req-1' }));
      } else {
        upFrames.push(f);
      }
    });
  });
  const c = makeSink();
  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: backend.name,
    backend,
    logSink: c.sink,
    logLevel: 'info',
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    reconnectJitterRatio: 0,
    reconnectStableMs: 0,
    heartbeatIntervalMs: 0,
  });
  try {
    client.start();
    await waitFor(
      () => upFrames.some((f) => f.type === 'usage.response'),
      'expected a usage.response frame',
    );
    return upFrames;
  } finally {
    client.stop();
    await closeServer(server, wss);
  }
}

test('usage.request: client queries backend.usage() and replies usage.response', async () => {
  const payload = { accounts: [{ key: 'k1', email: 'a@x.com' }] };
  const backend: Backend = {
    name: 'vicoop-codex',
    handle: async () => {},
    usage: async () => payload,
  };
  const frames = await runUsageDispatch(backend);
  const resp = frames.find((f) => f.type === 'usage.response');
  assert.ok(resp && resp.type === 'usage.response');
  assert.equal(resp.requestId, 'req-1');
  assert.equal(resp.ok, true);
  assert.deepEqual(resp.usage, payload);
});

test('usage.request: backend without usage() replies ok:false / unsupported', async () => {
  const frames = await runUsageDispatch(backendOf('echo', async () => {}));
  const resp = frames.find((f) => f.type === 'usage.response');
  assert.ok(resp && resp.type === 'usage.response');
  assert.equal(resp.ok, false);
  assert.equal(resp.error?.code, 'unsupported');
});

test('usage.request: a throwing backend.usage() replies ok:false / usage_failed', async () => {
  const backend: Backend = {
    name: 'vicoop-codex',
    handle: async () => {},
    usage: async () => {
      throw new Error('serve down');
    },
  };
  const frames = await runUsageDispatch(backend);
  const resp = frames.find((f) => f.type === 'usage.response');
  assert.ok(resp && resp.type === 'usage.response');
  assert.equal(resp.ok, false);
  assert.equal(resp.error?.code, 'usage_failed');
  assert.match(resp.error?.message ?? '', /serve down/);
});

// ---------------------------------------------------------------------------
// Offline frame buffer (vicoop-bridge#474 follow-up).
//
// `send()` used to drop any frame produced while the socket was down. The
// server-side reconnect grace keeps the task alive across the drop, but that
// only helps if the client's output actually arrives — so frames produced
// during the outage are buffered and replayed on the next connection.
// ---------------------------------------------------------------------------

test('frames produced while disconnected are replayed on the next connection', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);

  // Every frame the server ever receives, across both connections.
  const received: Array<Record<string, unknown>> = [];
  let connections = 0;
  let firstSocket: WebSocket | undefined;
  wss.on('connection', (ws) => {
    connections++;
    if (connections === 1) firstSocket = ws;
    ws.on('message', (raw) => {
      received.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
    });
  });

  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => undefined),
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    reconnectJitterRatio: 0,
    logLevel: 'silent',
  });

  try {
    client.start();
    await waitFor(() => received.some((f) => f.type === 'hello'), 'first hello');

    // Kill the connection from the server side and let the client notice.
    firstSocket!.close(1012, 'restarting');
    await waitFor(() => (client as never as { ws?: { readyState: number } }).ws?.readyState !== 1, 'socket down');

    // The backend keeps working through the outage: a delta, then the terminal.
    const send = (client as never as { send(f: unknown): void }).send.bind(client);
    send({
      type: 'task.artifact',
      taskId: 't-1',
      artifact: { artifactId: 'a-1', parts: [{ kind: 'text', text: 'lost text' }] },
      append: true,
      lastChunk: false,
    });
    send({
      type: 'task.complete',
      taskId: 't-1',
      status: { state: 'completed', timestamp: new Date().toISOString() },
    });

    // Nothing reached the server yet — the socket was down.
    assert.equal(received.filter((f) => f.taskId === 't-1').length, 0);

    await waitFor(() => connections >= 2, 'reconnect');
    await waitFor(
      () => received.some((f) => f.type === 'task.complete' && f.taskId === 't-1'),
      'the buffered terminal to be replayed',
    );

    const forTask = received.filter((f) => f.taskId === 't-1');
    assert.deepEqual(
      forTask.map((f) => f.type),
      ['task.artifact', 'task.complete'],
      'replay must preserve production order',
    );
    // The artifact must arrive intact — this is the text that used to vanish.
    const artifact = forTask[0] as { artifact: { parts: Array<{ text: string }> } };
    assert.equal(artifact.artifact.parts[0]?.text, 'lost text');

    // And it lands behind the new hello, so the server has claimed the
    // connection before the replay reaches it.
    const helloIdx = received.findIndex((f, i) => f.type === 'hello' && i > 0);
    const replayIdx = received.findIndex((f) => f.taskId === 't-1');
    assert.ok(helloIdx >= 0 && helloIdx < replayIdx, 'replay must follow the reconnect hello');
  } finally {
    client.stop();
    await closeServer(server, wss);
  }
});

test('a task that overflows the buffer is failed rather than replayed with a hole', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);

  const received: Array<Record<string, unknown>> = [];
  let connections = 0;
  let firstSocket: WebSocket | undefined;
  wss.on('connection', (ws) => {
    connections++;
    if (connections === 1) firstSocket = ws;
    ws.on('message', (raw) => {
      received.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
    });
  });

  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => undefined),
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    reconnectJitterRatio: 0,
    maxPendingFrames: 2,
    logLevel: 'silent',
  });

  try {
    client.start();
    await waitFor(() => received.some((f) => f.type === 'hello'), 'first hello');
    firstSocket!.close(1012, 'restarting');
    await waitFor(() => (client as never as { ws?: { readyState: number } }).ws?.readyState !== 1, 'socket down');

    const send = (client as never as { send(f: unknown): void }).send.bind(client);
    for (const text of ['one', 'two', 'three', 'four']) {
      send({
        type: 'task.artifact',
        taskId: 't-big',
        artifact: { artifactId: 'a-1', parts: [{ kind: 'text', text }] },
        append: true,
        lastChunk: false,
      });
    }

    await waitFor(() => connections >= 2, 'reconnect');
    await waitFor(
      () => received.some((f) => f.type === 'task.fail' && f.taskId === 't-big'),
      'the truncated task to be failed',
    );

    const forTask = received.filter((f) => f.taskId === 't-big');
    // A partial replay would be the silent hole this whole mechanism exists to
    // prevent, so the surviving frames are discarded in favour of an honest
    // failure the caller can retry.
    assert.deepEqual(forTask.map((f) => f.type), ['task.fail']);
    const failure = forTask[0] as { error: { code: string } };
    assert.equal(failure.error.code, 'client_buffer_overflow');
  } finally {
    client.stop();
    await closeServer(server, wss);
  }
});

test('maxPendingFrames: 0 restores the previous drop-on-the-floor behavior', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);

  const received: Array<Record<string, unknown>> = [];
  let connections = 0;
  let firstSocket: WebSocket | undefined;
  wss.on('connection', (ws) => {
    connections++;
    if (connections === 1) firstSocket = ws;
    ws.on('message', (raw) => {
      received.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
    });
  });

  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => undefined),
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    reconnectJitterRatio: 0,
    maxPendingFrames: 0,
    logLevel: 'silent',
  });

  try {
    client.start();
    await waitFor(() => received.some((f) => f.type === 'hello'), 'first hello');
    firstSocket!.close(1012, 'restarting');
    await waitFor(() => (client as never as { ws?: { readyState: number } }).ws?.readyState !== 1, 'socket down');

    (client as never as { send(f: unknown): void }).send.call(client, {
      type: 'task.complete',
      taskId: 't-off',
      status: { state: 'completed', timestamp: new Date().toISOString() },
    });

    await waitFor(() => connections >= 2, 'reconnect');
    // Give any replay a chance to arrive before asserting its absence.
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(received.filter((f) => f.taskId === 't-off'), []);
  } finally {
    client.stop();
    await closeServer(server, wss);
  }
});
test('the offline buffer is bounded by bytes, not just frame count', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);

  const received: Array<Record<string, unknown>> = [];
  let connections = 0;
  let firstSocket: WebSocket | undefined;
  wss.on('connection', (ws) => {
    connections++;
    if (connections === 1) firstSocket = ws;
    ws.on('message', (raw) => {
      received.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
    });
  });

  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => undefined),
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    reconnectJitterRatio: 0,
    maxPendingFrames: 1_000,
    maxPendingBytes: 4_000,
    logLevel: 'silent',
  });

  try {
    client.start();
    await waitFor(() => received.some((f) => f.type === 'hello'), 'first hello');
    firstSocket!.close(1012, 'restarting');
    await waitFor(
      () => (client as never as { ws?: { readyState: number } }).ws?.readyState !== 1,
      'socket down',
    );

    const send = (client as never as { send(f: unknown): void }).send.bind(client);
    const chunk = 'x'.repeat(1_500);
    for (let i = 0; i < 6; i++) {
      send({
        type: 'task.artifact',
        taskId: 't-bytes',
        artifact: { artifactId: 'a-1', parts: [{ kind: 'text', text: chunk }] },
        append: true,
        lastChunk: false,
      });
    }

    await waitFor(() => connections >= 2, 'reconnect');
    await waitFor(
      () => received.some((f) => f.type === 'task.fail' && f.taskId === 't-bytes'),
      'the byte-budget eviction to fail the task',
    );

    const forTask = received.filter((f) => f.taskId === 't-bytes');
    assert.deepEqual(forTask.map((f) => f.type), ['task.fail']);
    const failure = forTask[0] as { error: { code: string } };
    assert.equal(failure.error.code, 'client_buffer_overflow');
  } finally {
    client.stop();
    await closeServer(server, wss);
  }
});

test('a single frame larger than the whole budget is refused without evicting the queue', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);

  const received: Array<Record<string, unknown>> = [];
  let connections = 0;
  let firstSocket: WebSocket | undefined;
  wss.on('connection', (ws) => {
    connections++;
    if (connections === 1) firstSocket = ws;
    ws.on('message', (raw) => {
      received.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
    });
  });

  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => undefined),
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    reconnectJitterRatio: 0,
    maxPendingBytes: 4_000,
    logLevel: 'silent',
  });

  try {
    client.start();
    await waitFor(() => received.some((f) => f.type === 'hello'), 'first hello');
    firstSocket!.close(1012, 'restarting');
    await waitFor(
      () => (client as never as { ws?: { readyState: number } }).ws?.readyState !== 1,
      'socket down',
    );

    const send = (client as never as { send(f: unknown): void }).send.bind(client);
    send({
      type: 'task.complete',
      taskId: 't-small',
      status: { state: 'completed', timestamp: new Date().toISOString() },
    });
    send({
      type: 'task.artifact',
      taskId: 't-huge',
      artifact: { artifactId: 'a-1', parts: [{ kind: 'text', text: 'y'.repeat(10_000) }] },
      append: true,
      lastChunk: false,
    });

    await waitFor(() => connections >= 2, 'reconnect');
    await waitFor(
      () => received.some((f) => f.type === 'task.fail' && f.taskId === 't-huge'),
      'the oversized frame to fail its own task',
    );

    assert.deepEqual(
      received.filter((f) => f.taskId === 't-small').map((f) => f.type),
      ['task.complete'],
    );
  } finally {
    client.stop();
    await closeServer(server, wss);
  }
});
function replayHarness(onConnect?: (ws: WebSocket, n: number) => void) {
  const received: Array<Record<string, unknown>> = [];
  const sockets: WebSocket[] = [];
  let connections = 0;
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  wss.on('connection', (ws) => {
    connections++;
    sockets.push(ws);
    ws.on('message', (raw) => {
      received.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
    });
    onConnect?.(ws, connections);
  });
  return {
    server,
    wss,
    received,
    sockets,
    get connections() {
      return connections;
    },
  };
}

function sendOffline(client: Client, frame: Record<string, unknown>): void {
  (client as never as { send(f: unknown): void }).send.call(client, frame);
}

async function waitOffline(client: Client): Promise<void> {
  await waitFor(
    () => (client as never as { ws?: { readyState: number } }).ws?.readyState !== 1,
    'socket down',
  );
}

test('buffered output older than the replay window is failed, not replayed', async () => {
  const h = replayHarness();
  const serverUrl = await listen(h.server);

  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => undefined),
    reconnectDelayMs: 60,
    reconnectMaxDelayMs: 60,
    reconnectJitterRatio: 0,
    maxPendingAgeMs: 1,
    logLevel: 'silent',
  });

  try {
    client.start();
    await waitFor(() => h.received.some((f) => f.type === 'hello'), 'first hello');
    h.sockets[0]!.close(1012, 'restarting');
    await waitOffline(client);

    sendOffline(client, {
      type: 'task.complete',
      taskId: 't-stale',
      status: { state: 'completed', timestamp: new Date().toISOString() },
    });

    await waitFor(() => h.connections >= 2, 'reconnect');
    await waitFor(
      () => h.received.some((f) => f.type === 'task.fail' && f.taskId === 't-stale'),
      'the stale entry to be failed instead',
    );

    assert.deepEqual(
      h.received.filter((f) => f.taskId === 't-stale').map((f) => f.type),
      ['task.fail'],
      'a stale terminal must never be replayed',
    );
  } finally {
    client.stop();
    await closeServer(h.server, h.wss);
  }
});

test('a bridge that rejects pipelined replay (4003) disables it instead of looping', async () => {
  const captured = makeSink();
  const h = replayHarness((ws, n) => {
    if (n === 2) {
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString('utf8')) as { type?: string };
        if (f.type !== 'hello') ws.close(4003, 'expected hello');
      });
    }
  });
  const serverUrl = await listen(h.server);

  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => undefined),
    reconnectDelayMs: 20,
    reconnectMaxDelayMs: 20,
    reconnectJitterRatio: 0,
    logLevel: 'warn',
    logSink: captured.sink,
  });

  try {
    client.start();
    await waitFor(() => h.received.some((f) => f.type === 'hello'), 'first hello');
    h.sockets[0]!.close(1012, 'restarting');
    await waitOffline(client);

    sendOffline(client, {
      type: 'task.complete',
      taskId: 't-old-bridge',
      status: { state: 'completed', timestamp: new Date().toISOString() },
    });

    await waitFor(
      () => captured.warn.some((l) => l.includes('predates reconnect replay support')),
      'the incompatibility warning',
    );

    await waitFor(() => h.connections >= 3, 'a third connection');
    await new Promise((r) => setTimeout(r, 150));
    const settled = h.connections;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(h.connections, settled, 'the client must stop reconnecting in a loop');
  } finally {
    client.stop();
    await closeServer(h.server, h.wss);
  }
});

test('a replay onto a connection that dies before proving itself is retried, not lost', async () => {
  const h = replayHarness((ws, n) => {
    if (n === 2) {
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString('utf8')) as { type?: string };
        if (f.type === 'hello') setTimeout(() => ws.close(1012, 'restarting'), 5);
      });
    }
  });
  const serverUrl = await listen(h.server);

  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => undefined),
    reconnectDelayMs: 20,
    reconnectMaxDelayMs: 20,
    reconnectJitterRatio: 0,
    reconnectStableMs: 5_000,
    logLevel: 'silent',
  });

  try {
    client.start();
    await waitFor(() => h.received.some((f) => f.type === 'hello'), 'first hello');
    h.sockets[0]!.close(1012, 'restarting');
    await waitOffline(client);

    sendOffline(client, {
      type: 'task.complete',
      taskId: 't-retry',
      status: { state: 'completed', timestamp: new Date().toISOString() },
    });

    await waitFor(() => h.connections >= 3, 'a third connection');
    await waitFor(
      () => h.received.filter((f) => f.taskId === 't-retry').length >= 2,
      'the replay to be retried after the failed attempt',
    );
  } finally {
    client.stop();
    await closeServer(h.server, h.wss);
  }
});
test('a confirmed replay is never sent a second time on a later reconnect', async () => {
  const h = replayHarness();
  const serverUrl = await listen(h.server);

  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => undefined),
    reconnectDelayMs: 15,
    reconnectMaxDelayMs: 15,
    reconnectJitterRatio: 0,
    reconnectStableMs: 0,
    logLevel: 'silent',
  });

  try {
    client.start();
    await waitFor(() => h.received.some((f) => f.type === 'hello'), 'first hello');

    h.sockets[0]!.close(1012, 'restarting');
    await waitOffline(client);
    sendOffline(client, {
      type: 'task.complete',
      taskId: 't-once',
      status: { state: 'completed', timestamp: new Date().toISOString() },
    });

    await waitFor(
      () => h.received.some((f) => f.taskId === 't-once'),
      'the replay to be delivered',
    );
    assert.equal(h.connections, 2);

    h.sockets[1]!.close(1012, 'restarting');
    await waitOffline(client);
    await waitFor(() => h.connections >= 3, 'a third connection');
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(
      h.received.filter((f) => f.taskId === 't-once').length,
      1,
      'a delivered replay must not be re-sent',
    );
  } finally {
    client.stop();
    await closeServer(h.server, h.wss);
  }
});

test('replay eligibility is judged on the outage, not on each frame\'s own age', async () => {
  const h = replayHarness();
  const serverUrl = await listen(h.server);

  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => undefined),
    reconnectDelayMs: 400,
    reconnectMaxDelayMs: 400,
    reconnectJitterRatio: 0,
    maxPendingAgeMs: 100,
    logLevel: 'silent',
  });

  try {
    client.start();
    await waitFor(() => h.received.some((f) => f.type === 'hello'), 'first hello');
    h.sockets[0]!.close(1012, 'restarting');
    await waitOffline(client);

    await new Promise((r) => setTimeout(r, 250));
    sendOffline(client, {
      type: 'task.complete',
      taskId: 't-late',
      status: { state: 'completed', timestamp: new Date().toISOString() },
    });

    await waitFor(() => h.connections >= 2, 'reconnect');
    await waitFor(
      () => h.received.some((f) => f.type === 'task.fail' && f.taskId === 't-late'),
      'the late frame to be failed rather than replayed',
    );

    assert.deepEqual(
      h.received.filter((f) => f.taskId === 't-late').map((f) => f.type),
      ['task.fail'],
      'output from an over-long outage must never be replayed',
    );
  } finally {
    client.stop();
    await closeServer(h.server, h.wss);
  }
});
test('a truncated run is silenced, so its late canceled terminal never reaches the bridge', async () => {
  const h = replayHarness();
  const serverUrl = await listen(h.server);

  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });

  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('slow', async (task, emit) => {
      await held;
      emit({
        type: 'task.complete',
        taskId: task.taskId,
        status: { state: 'completed', timestamp: new Date().toISOString() },
      });
    }),
    reconnectDelayMs: 15,
    reconnectMaxDelayMs: 15,
    reconnectJitterRatio: 0,
    maxPendingFrames: 1,
    logLevel: 'silent',
  });

  try {
    client.start();
    await waitFor(() => h.received.some((f) => f.type === 'hello'), 'first hello');

    h.sockets[0]!.send(JSON.stringify({
      type: 'task.assign',
      taskId: 't-late-cancel',
      contextId: 'ctx',
      message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }], messageId: 'm1' },
    }));
    await new Promise((r) => setTimeout(r, 20));
    h.sockets[0]!.close(1012, 'restarting');
    await waitOffline(client);

    for (const text of ['a', 'b']) {
      sendOffline(client, {
        type: 'task.artifact',
        taskId: 't-late-cancel',
        artifact: { artifactId: 'a-1', parts: [{ kind: 'text', text }] },
        append: true,
        lastChunk: false,
      });
    }

    await waitFor(
      () => h.received.some((f) => f.type === 'task.fail' && f.taskId === 't-late-cancel'),
      'the truncation failure',
    );

    release();
    await new Promise((r) => setTimeout(r, 80));

    const terminals = h.received.filter(
      (f) => f.taskId === 't-late-cancel' && (f.type === 'task.complete' || f.type === 'task.fail'),
    );
    assert.deepEqual(
      terminals.map((f) => f.type),
      ['task.fail'],
      'a suppressed run must not emit a second terminal',
    );
  } finally {
    release();
    client.stop();
    await closeServer(h.server, h.wss);
  }
});

test('overflowing the truncated-task bookkeeping discards the buffer rather than replaying part of it', async () => {
  const h = replayHarness();
  const serverUrl = await listen(h.server);

  const client = new Client({
    serverUrl,
    token: 'client-token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('stub', async () => undefined),
    reconnectDelayMs: 20,
    reconnectMaxDelayMs: 20,
    reconnectJitterRatio: 0,
    maxPendingFrames: 1,
    logLevel: 'silent',
  });

  try {
    client.start();
    await waitFor(() => h.received.some((f) => f.type === 'hello'), 'first hello');
    h.sockets[0]!.close(1012, 'restarting');
    await waitOffline(client);

    for (let i = 0; i < 40; i++) {
      sendOffline(client, {
        type: 'task.artifact',
        taskId: `t-many-${i}`,
        artifact: { artifactId: 'a', parts: [{ kind: 'text', text: `chunk-${i}` }] },
        append: true,
        lastChunk: false,
      });
    }

    await waitFor(() => h.connections >= 2, 'reconnect');
    await new Promise((r) => setTimeout(r, 80));

    for (let i = 0; i < 40; i++) {
      const forTask = h.received.filter((f) => f.taskId === `t-many-${i}`);
      const kinds = new Set(forTask.map((f) => f.type));
      assert.ok(
        !kinds.has('task.artifact') || !kinds.has('task.fail'),
        `task ${i} got both a replayed artifact and a failure`,
      );
    }
  } finally {
    client.stop();
    await closeServer(h.server, h.wss);
  }
});
