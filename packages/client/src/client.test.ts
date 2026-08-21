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
  TASK_REPLAY_CAPABILITY,
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
        assert.deepEqual(frame.protocolCapabilities, ['caller-context-v1', TASK_REPLAY_CAPABILITY]);
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

// ── acknowledged reconnect replay ───────────────────────────────────────────

test('reliable task frames carry one execution ID and consecutive sequences', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);
  const received: UpFrame[] = [];
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const frame = parseUpFrame(raw.toString('utf8'));
      if (frame.type === 'hello') {
        ws.send(encodeFrame({
          type: 'hello.ack',
          protocolCapabilities: [TASK_REPLAY_CAPABILITY],
          disconnectGraceMs: 30_000,
          maxFrameBytes: 16 * 1024 * 1024,
        }));
        ws.send(encodeFrame({ ...makeAssign('t-seq'), executionId: 'execution-seq' }));
        return;
      }
      received.push(frame);
      if ('executionId' in frame && frame.executionId && 'seq' in frame && frame.seq !== undefined) {
        ws.send(encodeFrame({
          type: 'task.ack',
          taskId: frame.taskId,
          executionId: frame.executionId,
          acceptedSeq: frame.seq,
        }));
      }
    });
  });
  const client = new Client({
    serverUrl,
    token: 'token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('echo', async (task, emit) => {
      emit({
        type: 'task.artifact',
        taskId: task.taskId,
        artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'hello' }] },
      });
      emit({ type: 'task.complete', taskId: task.taskId, status: { state: 'completed' } });
    }),
    heartbeatIntervalMs: 0,
    logLevel: 'silent',
  });
  try {
    client.start();
    await waitFor(() => received.filter((frame) => 'taskId' in frame).length === 2, 'task frames');
    const taskFrames = received.filter((frame) => 'taskId' in frame);
    assert.deepEqual(taskFrames.map((frame) => frame.type), ['task.artifact', 'task.complete']);
    assert.deepEqual(
      taskFrames.map((frame) => 'executionId' in frame ? [frame.executionId, frame.seq] : []),
      [['execution-seq', 0], ['execution-seq', 1]],
    );
  } finally {
    client.stop();
    await closeServer(server, wss);
  }
});

test('an unacknowledged frame is replayed with the same execution ID and sequence', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);
  const artifacts: Array<{ executionId?: string; seq?: number }> = [];
  let connections = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  wss.on('connection', (ws) => {
    const connection = ++connections;
    ws.on('message', (raw) => {
      const frame = parseUpFrame(raw.toString('utf8'));
      if (frame.type === 'hello') {
        ws.send(encodeFrame({
          type: 'hello.ack',
          protocolCapabilities: [TASK_REPLAY_CAPABILITY],
          disconnectGraceMs: 30_000,
          maxFrameBytes: 16 * 1024 * 1024,
        }));
        if (connection === 1) {
          ws.send(encodeFrame({ ...makeAssign('t-replay'), executionId: 'execution-replay' }));
        }
        return;
      }
      if (frame.type === 'task.artifact') {
        artifacts.push({ executionId: frame.executionId, seq: frame.seq });
        if (connection === 1) ws.close(1012, 'restart before ack');
        else if (frame.executionId && frame.seq !== undefined) {
          ws.send(encodeFrame({
            type: 'task.ack', taskId: frame.taskId,
            executionId: frame.executionId, acceptedSeq: frame.seq,
          }));
          release();
        }
      }
      if (frame.type === 'task.complete' && frame.executionId && frame.seq !== undefined) {
        ws.send(encodeFrame({
          type: 'task.ack', taskId: frame.taskId,
          executionId: frame.executionId, acceptedSeq: frame.seq,
        }));
      }
    });
  });
  const client = new Client({
    serverUrl,
    token: 'token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('echo', async (task, emit) => {
      emit({
        type: 'task.artifact', taskId: task.taskId,
        artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'once' }] },
      });
      await gate;
      emit({ type: 'task.complete', taskId: task.taskId, status: { state: 'completed' } });
    }),
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10,
    reconnectJitterRatio: 0,
    heartbeatIntervalMs: 0,
    logLevel: 'silent',
  });
  try {
    client.start();
    await waitFor(() => artifacts.length === 2, 'replayed artifact');
    assert.deepEqual(artifacts, [
      { executionId: 'execution-replay', seq: 0 },
      { executionId: 'execution-replay', seq: 0 },
    ]);
  } finally {
    release();
    client.stop();
    await closeServer(server, wss);
  }
});

test('an unacknowledged frame expires even while the socket stays open', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);
  let socketClosed = false;
  let backendAborted = false;
  wss.on('connection', (ws) => {
    ws.on('close', () => { socketClosed = true; });
    ws.on('message', (raw) => {
      const frame = parseUpFrame(raw.toString('utf8'));
      if (frame.type !== 'hello') return;
      ws.send(encodeFrame({
        type: 'hello.ack', protocolCapabilities: [TASK_REPLAY_CAPABILITY],
        disconnectGraceMs: 30_000, maxFrameBytes: 16 * 1024 * 1024,
      }));
      ws.send(encodeFrame({ ...makeAssign('t-expire'), executionId: 'execution-expire' }));
    });
  });
  const client = new Client({
    serverUrl,
    token: 'token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('echo', async (task, emit, signal) => {
      emit({
        type: 'task.artifact', taskId: task.taskId,
        artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'unacked' }] },
      });
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          backendAborted = true;
          resolve();
        }, { once: true });
      });
    }),
    maxPendingAgeMs: 20,
    reconnectDelayMs: 1_000,
    heartbeatIntervalMs: 0,
    logLevel: 'silent',
  });
  try {
    client.start();
    await waitFor(() => socketClosed, 'socket closed after acknowledgement timeout');
    assert.equal(backendAborted, true);
  } finally {
    client.stop();
    await closeServer(server, wss);
  }
});

for (const [bound, options] of [
  ['byte', { maxPendingBytes: 0 }],
  ['age', { maxPendingAgeMs: 0 }],
] as const) {
  test(`a zero ${bound} retention bound aborts a reliable run on disconnect`, async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server, path: '/connect' });
    const serverUrl = await listen(server);
    let backendAborted = false;
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = parseUpFrame(raw.toString('utf8'));
        if (frame.type === 'hello') {
          ws.send(encodeFrame({
            type: 'hello.ack', protocolCapabilities: [TASK_REPLAY_CAPABILITY],
            disconnectGraceMs: 30_000, maxFrameBytes: 16 * 1024 * 1024,
          }));
          ws.send(encodeFrame({
            ...makeAssign(`t-zero-${bound}`), executionId: `execution-zero-${bound}`,
          }));
        } else if (frame.type === 'task.artifact') {
          ws.close(1012, 'disconnect with retention disabled');
        }
      });
    });
    const client = new Client({
      serverUrl,
      token: 'token',
      agentId: 'agent-1',
      backendKind: 'echo',
      backend: backendOf('echo', async (task, emit, signal) => {
        emit({
          type: 'task.artifact', taskId: task.taskId,
          artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'one shot' }] },
        });
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            backendAborted = true;
            resolve();
          }, { once: true });
        });
      }),
      ...options,
      reconnectDelayMs: 5_000,
      heartbeatIntervalMs: 0,
      logLevel: 'silent',
    });
    try {
      client.start();
      await waitFor(() => backendAborted, `zero ${bound} bound did not abort the run`);
    } finally {
      client.stop();
      await closeServer(server, wss);
    }
  });
}

test('a replacement assignment suppresses the older run with the same taskId', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: '/connect' });
  const serverUrl = await listen(server);
  const completes: Array<{ executionId?: string; seq?: number }> = [];
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const frame = parseUpFrame(raw.toString('utf8'));
      if (frame.type === 'hello') {
        ws.send(encodeFrame({
          type: 'hello.ack', protocolCapabilities: [TASK_REPLAY_CAPABILITY],
          disconnectGraceMs: 30_000, maxFrameBytes: 16 * 1024 * 1024,
        }));
        ws.send(encodeFrame({ ...makeAssign('t-reuse'), executionId: 'execution-old' }));
        setTimeout(() => {
          ws.send(encodeFrame({ ...makeAssign('t-reuse'), executionId: 'execution-new' }));
        }, 10);
        return;
      }
      if (frame.type === 'task.complete') completes.push(frame);
    });
  });
  const client = new Client({
    serverUrl,
    token: 'token',
    agentId: 'agent-1',
    backendKind: 'echo',
    backend: backendOf('echo', async (task, emit) => {
      if (task.executionId === 'execution-old') await oldGate;
      emit({ type: 'task.complete', taskId: task.taskId, status: { state: 'completed' } });
    }),
    heartbeatIntervalMs: 0,
    logLevel: 'silent',
  });
  try {
    client.start();
    await waitFor(() => completes.some((frame) => frame.executionId === 'execution-new'), 'new run');
    releaseOld();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(completes.map((frame) => frame.executionId), ['execution-new']);
  } finally {
    releaseOld();
    client.stop();
    await closeServer(server, wss);
  }
});
