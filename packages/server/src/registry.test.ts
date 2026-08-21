import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { OPENAI_COMPAT_EXTENSION_URI, type AgentCard } from '@vicoop-bridge/protocol';
import {
  FALLBACK_DISCONNECT_GRACE_MS,
  MAX_DISCONNECT_GRACE_MS,
  Registry,
  resolveDisconnectGraceMs,
  type TaskBinding,
} from './registry.js';

// Mirrors the `ws` library's ReadyState constants; the stubs below are typed as
// WebSocket, so these have to agree with the real values.
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

// Minimal WebSocket stub — Registry uses `.close()` on replacement, equality
// (`existing.ws !== ws`) on unregister, and `readyState` to tell a live
// duplicate-token collision from a client that is merely reconnecting after its
// socket already died (issue #474). Defaults to OPEN, which is what every
// pre-#474 test implicitly assumed.
//
// `close()` MUST move readyState to CLOSING, because the real `ws` library does
// so synchronously inside close() — and a stub that froze readyState instead
// would let `registry.ts` read it *after* closing the socket and still appear
// to work, certifying a branch that real sockets can never take. That is not
// hypothetical: it is exactly the bug this stub previously hid.
function makeWs(readyState: number = WS_OPEN): WebSocket {
  const ws = {
    readyState,
    OPEN: WS_OPEN,
    close: () => {
      ws.readyState = WS_CLOSING;
    },
  };
  return ws as unknown as WebSocket;
}

interface RecordingWs extends WebSocket {
  closeArgs: Array<{ code: number; reason: string }>;
}

function makeRecordingWs(): RecordingWs {
  const closeArgs: Array<{ code: number; reason: string }> = [];
  const ws = {
    closeArgs,
    readyState: WS_OPEN,
    OPEN: WS_OPEN,
    close(code: number, reason: string) {
      closeArgs.push({ code, reason });
      // Same fidelity requirement as makeWs().
      ws.readyState = WS_CLOSING;
    },
  } as unknown as RecordingWs & { readyState: number };
  return ws;
}

function makeCard(streaming: boolean): AgentCard {
  return {
    name: 'test',
    description: 'test',
    version: '0.0.0',
    protocolVersion: '0.3.0',
    capabilities: { streaming },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 's1', name: 'skill', description: 'd', tags: [] }],
  };
}

test('onAgentChange fires on first registration', () => {
  const registry = new Registry();
  const seen: string[] = [];
  registry.onAgentChange((id) => seen.push(id));
  const result = registry.registerAgent({
    agentId: 'a1',
    clientId: 'c1',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeCard(false),
    allowedCallers: [],
    ws: makeWs(),
    connectedAt: 0,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen, ['a1']);
});

test('onAgentChange fires again when the same client reconnects with an updated card', () => {
  // This is the fix's core guarantee: a client upgrading from streaming:false
  // to streaming:true must trigger invalidation so consumers (e.g. the HTTP
  // layer's cached JsonRpcTransportHandler) rebuild against the fresh card.
  const registry = new Registry();
  const seen: string[] = [];
  registry.onAgentChange((id) => seen.push(id));
  const base = {
    agentId: 'a1',
    clientId: 'c1',
    ownerPrincipal: 'eth:0x0',
    allowedCallers: [],
    connectedAt: 0,
  };
  registry.registerAgent({ ...base, agentCard: makeCard(false), ws: makeWs() });
  registry.registerAgent({ ...base, agentCard: makeCard(true), ws: makeWs() });
  assert.deepEqual(seen, ['a1', 'a1']);
  // Current conn reflects the new card, confirming we're not just firing
  // the notification — the registry state is actually advancing.
  const current = registry.getAgent('a1');
  assert.ok(current);
  assert.equal(current.agentCard.capabilities?.streaming, true);
});

test('onAgentChange does NOT fire when registration is refused (different client owns the agentId)', () => {
  const registry = new Registry();
  registry.registerAgent({
    agentId: 'a1',
    clientId: 'c1',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeCard(false),
    allowedCallers: [],
    ws: makeWs(),
    connectedAt: 0,
  });
  const seen: string[] = [];
  registry.onAgentChange((id) => seen.push(id));
  const rejected = registry.registerAgent({
    agentId: 'a1',
    clientId: 'c2', // different client
    ownerPrincipal: 'eth:0x0',
    agentCard: makeCard(true),
    allowedCallers: [],
    ws: makeWs(),
    connectedAt: 0,
  });
  assert.equal(rejected.ok, false);
  // A rejected registration must not invalidate the incumbent's cached
  // transport — it has not been replaced.
  assert.deepEqual(seen, []);
});

test('onAgentChange fires on disconnect (unregister) so stale transports do not persist past a dead connection', () => {
  const registry = new Registry();
  const ws = makeWs();
  registry.registerAgent({
    agentId: 'a1',
    clientId: 'c1',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeCard(false),
    allowedCallers: [],
    ws,
    connectedAt: 0,
  });
  const seen: string[] = [];
  registry.onAgentChange((id) => seen.push(id));
  registry.unregisterAgent('a1', ws);
  assert.deepEqual(seen, ['a1']);
});

// 4009 (duplicate CLIENT_TOKEN) stands in for any app-level close: the bridge
// only sends 4xxx when it has decided the connection must not continue, so
// those skip the reconnect grace hold and fail in-flight tasks immediately
// (issue #474). The terminal shape asserted here is the one a graced task also
// ends up with once its hold expires — see the grace tests below.
test('unregisterAgent reports mid-task disconnect with structured error metadata', () => {
  const registry = new Registry();
  const ws = makeWs();
  registry.registerAgent({
    agentId: 'a1',
    clientId: 'c1',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeCard(false),
    allowedCallers: [],
    ws,
    connectedAt: 0,
  });

  const statuses: Array<{ status: { message?: { metadata?: unknown; extensions?: string[] } } }> = [];
  let finished = false;
  registry.bindTask({
    agentId: 'a1',
    taskId: 't-disc',
    contextId: 'ctx-disc',
    requestedExtensions: [OPENAI_COMPAT_EXTENSION_URI],
    sink: {
      pushStatus: (event) => statuses.push(event),
      pushArtifact: () => undefined,
      finish: () => {
        finished = true;
      },
    },
  });

  registry.unregisterAgent('a1', ws, 4009);

  assert.equal(finished, true);
  assert.equal(registry.getBinding('t-disc'), undefined);
  assert.deepEqual(statuses[0]?.status.message?.metadata, {
    [OPENAI_COMPAT_EXTENSION_URI]: {
      terminal_error: {
        code: 'disconnected',
        message: 'client disconnected mid-task',
      },
    },
    error: {
      code: 'disconnected',
      message: 'client disconnected mid-task',
    },
  });
  assert.deepEqual(statuses[0]?.status.message?.extensions, [OPENAI_COMPAT_EXTENSION_URI]);
});

test('unregisterAgent omits terminal error metadata when openai-compat extension was not requested', () => {
  const registry = new Registry();
  const ws = makeWs();
  registry.registerAgent({
    agentId: 'a1',
    clientId: 'c1',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeCard(false),
    allowedCallers: [],
    ws,
    connectedAt: 0,
  });

  const statuses: Array<{ status: { message?: { metadata?: unknown; extensions?: string[] } } }> = [];
  registry.bindTask({
    agentId: 'a1',
    taskId: 't-disc-plain',
    contextId: 'ctx-disc-plain',
    sink: {
      pushStatus: (event) => statuses.push(event),
      pushArtifact: () => undefined,
      finish: () => undefined,
    },
  });

  registry.unregisterAgent('a1', ws, 4009);

  // Assert a terminal was actually pushed before asserting what it omits —
  // without this the two checks below pass vacuously on an empty array.
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]?.status.message?.metadata, undefined);
  assert.equal(statuses[0]?.status.message?.extensions, undefined);
});

test('onAgentChange does NOT fire on unregister if the ws does not match the current connection', () => {
  // Defensive: a late-arriving close event from a superseded socket must not
  // trigger invalidation of the new connection's cached transport.
  const registry = new Registry();
  const oldWs = makeWs();
  registry.registerAgent({
    agentId: 'a1',
    clientId: 'c1',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeCard(false),
    allowedCallers: [],
    ws: oldWs,
    connectedAt: 0,
  });
  // New connection replaces the old one (fires once, as expected).
  const newWs = makeWs();
  registry.registerAgent({
    agentId: 'a1',
    clientId: 'c1',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeCard(true),
    allowedCallers: [],
    ws: newWs,
    connectedAt: 0,
  });
  const seen: string[] = [];
  registry.onAgentChange((id) => seen.push(id));
  // Late unregister from the *old* ws — should be a no-op.
  registry.unregisterAgent('a1', oldWs);
  assert.deepEqual(seen, []);
  // Registry still holds the new connection.
  const current = registry.getAgent('a1');
  assert.ok(current, 'agent should still be registered');
  assert.equal(current.agentCard.capabilities?.streaming, true);
});

test('a throwing onAgentChange listener does not abort other listeners or the registerAgent call', (t) => {
  // The change notification runs inside registerAgent/unregisterAgent. A bad
  // listener must not corrupt the caller's control flow or prevent
  // subsequent listeners from receiving the event.
  //
  // Use the test runner's scoped mock so parallel tests that also touch
  // console.log don't race with this stub — node:test auto-restores the
  // original at test teardown, removing the need for a manual try/finally
  // and the "what if the test body throws before finally" window.
  const logs: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  const registry = new Registry();
  const seen: string[] = [];
  registry.onAgentChange(() => {
    throw new Error('listener boom');
  });
  registry.onAgentChange((id) => seen.push(id));
  const result = registry.registerAgent({
    agentId: 'a1',
    clientId: 'c1',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeCard(false),
    allowedCallers: [],
    ws: makeWs(),
    connectedAt: 0,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen, ['a1']);
  // Error is emitted as a structured logEvent() JSON line — assert on both
  // the event name and the embedded error text so we catch regressions
  // where the event is renamed or the error is dropped.
  const errorLine = logs.find(
    (l) => l.includes('registry_agent_listener_error') && l.includes('listener boom'),
  );
  assert.ok(errorLine, `expected structured error log, got: ${logs.join(' | ')}`);
});

test('notifyAgentChange log cannot be hijacked by newline injection via agentId', (t) => {
  // agentId originates from the client's hello frame and is an
  // unconstrained string at this layer. A malicious client sending
  // "a\nfake-log-line" as its agentId must not be able to synthesize
  // a second line in operator logs. logEvent() serializes via
  // JSON.stringify which escapes newlines; this test locks that
  // invariant in place so a future switch back to a raw
  // console.error(`...${agentId}...`) template-string regresses loudly.
  const logs: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  const registry = new Registry();
  registry.onAgentChange(() => {
    throw new Error('boom');
  });
  registry.registerAgent({
    agentId: 'good\nevent: fake_login\nextra: attacker-controlled',
    clientId: 'c1',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeCard(false),
    allowedCallers: [],
    ws: makeWs(),
    connectedAt: 0,
  });
  assert.equal(logs.length, 1, 'exactly one log line must be emitted');
  // Raw newlines in the output would split into multiple lines when a
  // downstream log aggregator processes them. JSON.stringify escapes
  // them as `\n`, which survives as a single physical line.
  assert.ok(!logs[0].includes('\n'), 'structured log must not contain raw newlines');
  assert.ok(logs[0].includes('\\n'), 'newlines must be JSON-escaped');
  // Parse the log and verify the attacker's pseudo-fields live *inside*
  // the agentId string value, not as top-level fields of the JSON object.
  // A raw console.error(`...${agentId}...`) would have smuggled a second
  // "event: fake_login" line past a line-oriented log scanner; structured
  // logging keeps it bottled up inside the quoted agentId string.
  const parsed = JSON.parse(logs[0]) as Record<string, unknown>;
  assert.equal(parsed.event, 'registry_agent_listener_error');
  assert.equal(
    typeof parsed.agentId === 'string' && (parsed.agentId as string).includes('fake_login'),
    true,
    'agentId value should retain the attacker input verbatim (escaped, not stripped)',
  );
  assert.equal(
    parsed.fake_login,
    undefined,
    'attacker payload must not surface as a top-level JSON field',
  );
});

test('disconnectClient closes every ws bound to the client_id with code 4014', () => {
  // Two agents owned by the deleted client + one agent owned by an unrelated
  // client. After disconnectClient('c1'), only the first two sockets see a
  // close, and they see code 4014 with the "client deleted" reason. The
  // unrelated socket is untouched.
  const registry = new Registry();
  const ws1 = makeRecordingWs();
  const ws2 = makeRecordingWs();
  const ws3 = makeRecordingWs();
  const base = {
    ownerPrincipal: 'eth:0x0',
    agentCard: makeCard(false),
    allowedCallers: [],
    connectedAt: 0,
  };
  registry.registerAgent({ ...base, agentId: 'a1', clientId: 'c1', ws: ws1 });
  registry.registerAgent({ ...base, agentId: 'a2', clientId: 'c1', ws: ws2 });
  registry.registerAgent({ ...base, agentId: 'a3', clientId: 'c2', ws: ws3 });

  const closed = registry.disconnectClient('c1');
  assert.equal(closed, 2);
  assert.deepEqual(ws1.closeArgs, [{ code: 4014, reason: 'client deleted' }]);
  assert.deepEqual(ws2.closeArgs, [{ code: 4014, reason: 'client deleted' }]);
  assert.deepEqual(ws3.closeArgs, []);
});

test('registerAgent emits client_collision and closes the prior ws with the descriptive 4009 reason', (t) => {
  // Two daemons authenticated with the same CLIENT_TOKEN — so the token
  // hash resolves to the same client row, hence the same clientId — show
  // up here as a second registerAgent() for the same agentId + clientId.
  // The prior ws must
  // receive close(4009, 'another client with the same token connected')
  // — both the code and the reason text — so the surviving client surfaces
  // the cause directly in its disconnect log line. A structured
  // `client_collision` event must also fire so aggregated server logs can
  // be grepped for flapping agents independently of normal connect/
  // disconnect noise.
  const logs: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  const registry = new Registry();
  const ws1 = makeRecordingWs();
  const ws2 = makeRecordingWs();
  const base = {
    agentId: 'a1',
    clientId: 'c1',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeCard(false),
    allowedCallers: [],
  };
  registry.registerAgent({ ...base, ws: ws1, connectedAt: 1000 });
  registry.registerAgent({ ...base, ws: ws2, connectedAt: 2000 });
  assert.deepEqual(ws1.closeArgs, [
    { code: 4009, reason: 'another client with the same token connected' },
  ]);
  // The new ws is the live one and must not have been closed.
  assert.deepEqual(ws2.closeArgs, []);
  const collisionLine = logs.find((l) => l.includes('client_collision'));
  assert.ok(collisionLine, `expected client_collision event, got: ${logs.join(' | ')}`);
  const parsed = JSON.parse(collisionLine) as Record<string, unknown>;
  assert.equal(parsed.event, 'client_collision');
  assert.equal(parsed.agentId, 'a1');
  assert.equal(parsed.clientId, 'c1');
  // previousConnectedAt surfaces the displaced connection's connectedAt so
  // operators can see how long the loser had been live before being
  // replaced — useful when triaging a fast ping-pong vs. a legit handoff
  // after a long-stable session.
  assert.equal(parsed.previousConnectedAt, 1000);
});

test('same-token reconnect eventually fails the displaced connection in-flight bindings (issue #365)', () => {
  // A second daemon authenticating with the same CLIENT_TOKEN replaces the
  // incumbent. The old connection's in-flight task must receive a terminal
  // `failed` status and have its sink finished + binding dropped — otherwise
  // the task's HTTP stream hangs forever (if the new daemon is a separate
  // process that never knew the old taskId, it can't complete it either).
  //
  // Since #474 that outcome is delayed by the reconnect grace, which exists
  // because the new daemon is USUALLY the same client coming back and can
  // finish the task. Grace 0 keeps this test on its original subject — that a
  // displaced binding is never orphaned, and that this path's terminal is
  // `superseded` — while the graced variants are covered separately below.
  const registry = new Registry(0);
  const oldWs = makeWs();
  const base = {
    agentId: 'a1',
    clientId: 'c1',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeCard(false),
    allowedCallers: [],
    connectedAt: 0,
  };
  registry.registerAgent({ ...base, ws: oldWs });

  // Two in-flight tasks on the displaced connection — both must be failed, so
  // a future reintroduction of an early-return in the loop regresses loudly.
  const statuses: Array<{
    status: { state?: string; message?: { messageId?: string; metadata?: unknown } };
  }> = [];
  const finished = new Set<string>();
  for (const taskId of ['t-live', 't-live-2']) {
    registry.bindTask({
      agentId: 'a1',
      taskId,
      contextId: `ctx-${taskId}`,
      requestedExtensions: [OPENAI_COMPAT_EXTENSION_URI],
      sink: {
        pushStatus: (event) => statuses.push(event),
        pushArtifact: () => undefined,
        finish: () => {
          finished.add(taskId);
        },
      },
    });
  }

  // Same token (clientId) reconnects on a fresh socket → replacement branch.
  registry.registerAgent({ ...base, ws: makeWs(), connectedAt: 1 });

  assert.deepEqual([...finished].sort(), ['t-live', 't-live-2'], 'every displaced sink must be finished');
  assert.equal(registry.getBinding('t-live'), undefined, 'binding must be dropped');
  assert.equal(registry.getBinding('t-live-2'), undefined, 'binding must be dropped');
  assert.equal(statuses[0]?.status.state, 'failed');
  // messageId carries the per-path suffix wired through failBindingsForAgent —
  // the disconnect path uses `-disc`, this reconnect path uses `-superseded`.
  assert.equal(statuses[0]?.status.message?.messageId, 't-live-superseded');
  assert.deepEqual(statuses[0]?.status.message?.metadata, {
    [OPENAI_COMPAT_EXTENSION_URI]: {
      terminal_error: {
        code: 'superseded',
        message: 'superseded by a reconnect from the same client token',
      },
    },
    error: {
      code: 'superseded',
      message: 'superseded by a reconnect from the same client token',
    },
  });
});

test('a late close from the superseded socket does not double-fail the new connection bindings (issue #365)', () => {
  // After the reconnect path has already terminated the old connection's
  // bindings, the old socket's close handler eventually fires
  // unregisterAgent(agentId, oldWs). The ws-identity guard must make that a
  // no-op so it can't touch a task the *new* connection has since bound.
  const registry = new Registry();
  const oldWs = makeWs();
  const base = {
    agentId: 'a1',
    clientId: 'c1',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeCard(false),
    allowedCallers: [],
    connectedAt: 0,
  };
  registry.registerAgent({ ...base, ws: oldWs });
  const newWs = makeWs();
  registry.registerAgent({ ...base, ws: newWs, connectedAt: 1 });

  // New connection binds a fresh task after the swap.
  let finished = false;
  registry.bindTask({
    agentId: 'a1',
    taskId: 't-new',
    contextId: 'ctx-new',
    sink: {
      pushStatus: () => undefined,
      pushArtifact: () => undefined,
      finish: () => {
        finished = true;
      },
    },
  });

  // Late close from the displaced socket — must not disturb t-new.
  registry.unregisterAgent('a1', oldWs);

  assert.equal(finished, false, 'new connection binding must survive a stale unregister');
  assert.ok(registry.getBinding('t-new'), 'new binding must still be present');
});

test('disconnectClient returns 0 when no agents are bound to the client', () => {
  const registry = new Registry();
  registry.registerAgent({
    agentId: 'a1',
    clientId: 'c1',
    ownerPrincipal: 'eth:0x0',
    agentCard: makeCard(false),
    allowedCallers: [],
    ws: makeWs(),
    connectedAt: 0,
  });
  assert.equal(registry.disconnectClient('orphan-client'), 0);
});

// A recording sink whose finish() flips a flag — enough to observe whether a
// binding was terminated by the registry.
function recordingBinding(agentId: string, taskId: string) {
  const statuses: unknown[] = [];
  const state = { finished: false };
  const binding = {
    agentId,
    taskId,
    contextId: `ctx-${taskId}`,
    sink: {
      pushStatus: (e: unknown) => statuses.push(e),
      pushArtifact: () => undefined,
      finish: () => {
        state.finished = true;
      },
    },
  };
  return { binding, statuses, state };
}

test('unbindTask is identity-scoped — a stale binding never clobbers a newer one', () => {
  const registry = new Registry();
  const first = recordingBinding('a1', 't-reuse');
  registry.bindTask(first.binding);

  // A second run claims the SAME taskId. bindTask terminates the first (it is a
  // live binding) and installs the second.
  const second = recordingBinding('a1', 't-reuse');
  registry.bindTask(second.binding);
  assert.equal(first.state.finished, true, 'displaced live binding must be finished');
  assert.equal(registry.getBinding('t-reuse'), second.binding);

  // The first run's late teardown must NOT delete the second's binding.
  registry.unbindTask('t-reuse', first.binding);
  assert.equal(
    registry.getBinding('t-reuse'),
    second.binding,
    'stale unbind must not clobber the newer binding',
  );

  // The second run's own teardown removes it.
  registry.unbindTask('t-reuse', second.binding);
  assert.equal(registry.getBinding('t-reuse'), undefined);
});

test('bindTask leaves a self-rebind untouched (same object is not a displacement)', () => {
  const registry = new Registry();
  const only = recordingBinding('a1', 't-self');
  registry.bindTask(only.binding);
  registry.bindTask(only.binding);
  assert.equal(only.state.finished, false, 'rebinding the same object must not fail it');
  assert.equal(registry.getBinding('t-self'), only.binding);
});

test('bindTask rejects a different agent without displacing the owner binding', () => {
  const registry = new Registry();
  const victim = recordingBinding('victim', 't-owned');
  const attacker = recordingBinding('attacker', 't-owned');

  assert.equal(registry.bindTask(victim.binding), true);
  assert.equal(registry.bindTask(attacker.binding), false);

  assert.equal(
    registry.getBinding('t-owned'),
    victim.binding,
    'the victim must retain ownership of the live task id',
  );
  assert.equal(victim.state.finished, false, 'the victim stream must remain open');
  assert.equal(victim.statuses.length, 0, 'the victim must not receive a forged terminal status');
  assert.equal(attacker.state.finished, false, 'the rejected binding was never installed');
});

test('bindTask displacing a live binding emits a superseded terminal on the old sink', () => {
  const registry = new Registry();
  const first = recordingBinding('a1', 't-sup');
  registry.bindTask(first.binding);
  const second = recordingBinding('a1', 't-sup');
  registry.bindTask(second.binding);

  assert.equal(first.state.finished, true);
  const terminal = first.statuses[0] as {
    final?: boolean;
    status?: { state?: string; message?: { parts?: Array<{ text?: string }> } };
  };
  assert.equal(terminal?.final, true);
  assert.equal(terminal?.status?.state, 'failed');
  assert.match(terminal?.status?.message?.parts?.[0]?.text ?? '', /superseded/);
});
interface CapturedTask {
  statuses: unknown[];
  state: { finished: boolean };
}

// Terminal-status reader, matching recordingBinding's `unknown[]` idiom above:
// the sink receives full TaskStatusUpdateEvents, and these tests only care
// about the human-readable reason on the first one.
function terminalText(task: CapturedTask): string {
  const first = task.statuses[0] as
    | { status?: { message?: { parts?: Array<{ text?: string }> } } }
    | undefined;
  return first?.status?.message?.parts?.[0]?.text ?? '';
}

function bindCapturing(registry: Registry, agentId: string, taskId: string): CapturedTask {
  const statuses: unknown[] = [];
  const state = { finished: false };
  registry.bindTask({
    agentId,
    taskId,
    contextId: `ctx-${taskId}`,
    sink: {
      pushStatus: (event) => statuses.push(event),
      pushArtifact: () => undefined,
      finish: () => {
        state.finished = true;
      },
    },
  });
  return { statuses, state };
}

function registerFor(registry: Registry, ws: WebSocket, agentId = 'a1', clientId = 'c1'): void {
  registry.registerAgent({
    agentId,
    clientId,
    ownerPrincipal: 'eth:0x0',
    agentCard: makeCard(false),
    allowedCallers: [],
    ws,
    connectedAt: 0,
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('grace hold keeps the binding alive across a recoverable disconnect instead of failing it', () => {
  const registry = new Registry(10_000);
  const ws = makeWs();
  registerFor(registry, ws);
  const task = bindCapturing(registry, 'a1', 't-grace');

  registry.unregisterAgent('a1', ws, 1012);

  assert.ok(registry.getBinding('t-grace'), 'binding must survive the disconnect');
  assert.equal(task.state.finished, false);
  assert.deepEqual(task.statuses, [], 'no terminal may be emitted during the hold');
  assert.equal(registry.getAgent('a1'), undefined);
});

test('a frame from the reconnected client resumes a held binding and cancels its expiry', async () => {
  const registry = new Registry(25);
  const ws = makeWs();
  registerFor(registry, ws);
  const task = bindCapturing(registry, 'a1', 't-resume');

  registry.unregisterAgent('a1', ws, 1012);
  registry.resumeBinding('t-resume', 'a1');

  await sleep(80);

  assert.ok(registry.getBinding('t-resume'), 'resumed binding must not be reaped');
  assert.equal(task.state.finished, false);
  assert.deepEqual(task.statuses, []);
});

test('grace hold expires into the identical disconnected terminal it always produced', async () => {
  const registry = new Registry(15);
  const ws = makeWs();
  registerFor(registry, ws);

  const statuses: Array<{ status: { message?: { metadata?: unknown } } }> = [];
  let finished = false;
  registry.bindTask({
    agentId: 'a1',
    taskId: 't-expire',
    contextId: 'ctx-expire',
    requestedExtensions: [OPENAI_COMPAT_EXTENSION_URI],
    sink: {
      pushStatus: (event) => statuses.push(event),
      pushArtifact: () => undefined,
      finish: () => {
        finished = true;
      },
    },
  });

  registry.unregisterAgent('a1', ws, 1012);
  await sleep(80);

  assert.equal(finished, true);
  assert.equal(registry.getBinding('t-expire'), undefined);
  assert.deepEqual(statuses[0]?.status.message?.metadata, {
    [OPENAI_COMPAT_EXTENSION_URI]: {
      terminal_error: {
        code: 'disconnected',
        message: 'client disconnected mid-task',
      },
    },
    error: {
      code: 'disconnected',
      message: 'client disconnected mid-task',
    },
  });
});

test('a task completing during the hold is not failed by the expiry timer afterwards', async () => {
  const registry = new Registry(20);
  const ws = makeWs();
  registerFor(registry, ws);
  const task = bindCapturing(registry, 'a1', 't-late-complete');
  const binding = registry.getBinding('t-late-complete');
  assert.ok(binding);

  registry.unregisterAgent('a1', ws, 1012);
  registry.resumeBinding('t-late-complete', 'a1');
  registry.unbindTask('t-late-complete', binding);

  await sleep(80);

  assert.equal(task.state.finished, false, 'a completed task must not be failed later');
  assert.deepEqual(task.statuses, []);
});

test('app-level close codes skip the hold entirely and fail in-flight tasks at once', () => {
  for (const code of [4014, 4009, 1000]) {
    const registry = new Registry(10_000);
    const ws = makeWs();
    registerFor(registry, ws);
    const task = bindCapturing(registry, 'a1', `t-terminal-${code}`);

    registry.unregisterAgent('a1', ws, code);

    assert.equal(
      registry.getBinding(`t-terminal-${code}`),
      undefined,
      `close code ${code} must not be graced`,
    );
    assert.equal(task.state.finished, true);
    assert.match(terminalText(task), /disconnected mid-task/);
  }
});

test('a grace of 0 restores the pre-#474 fail-immediately behavior', () => {
  const registry = new Registry(0);
  const ws = makeWs();
  registerFor(registry, ws);
  const task = bindCapturing(registry, 'a1', 't-nograce');

  registry.unregisterAgent('a1', ws, 1012);

  assert.equal(registry.getBinding('t-nograce'), undefined);
  assert.equal(task.state.finished, true);
});

test('reconnect arriving BEFORE the old socket close holds the task instead of superseding it', () => {
  const registry = new Registry(10_000);
  const deadWs = makeWs(WS_CLOSED);
  registerFor(registry, deadWs);
  const task = bindCapturing(registry, 'a1', 't-race');

  registerFor(registry, makeWs());

  assert.ok(registry.getBinding('t-race'), 'a reconnect must not supersede its own in-flight task');
  assert.equal(task.state.finished, false);
  assert.deepEqual(task.statuses, []);

});

test('a hold armed by the reconnect branch really is a hold: it resumes and it expires', async () => {
  // Presence of the binding right after the reconnect proves nothing — a
  // binding simply left alone, with no timer at all, looks identical at that
  // instant and would then hang until the executor's 10-minute backstop. Drive
  // both ends of the lifecycle instead.
  const armed = new Registry(20);
  registerFor(armed, makeWs(WS_CLOSED));
  const abandoned = bindCapturing(armed, 'a1', 't-race-expire');
  registerFor(armed, makeWs());
  await sleep(80);
  assert.equal(abandoned.state.finished, true, 'the reconnect branch armed no expiry');
  assert.equal(armed.getBinding('t-race-expire'), undefined);

  const resumed = new Registry(20);
  registerFor(resumed, makeWs(WS_CLOSED));
  const reclaimed = bindCapturing(resumed, 'a1', 't-race-resume');
  registerFor(resumed, makeWs());
  resumed.resumeBinding('t-race-resume', 'a1');
  await sleep(80);
  assert.equal(reclaimed.state.finished, false, 'a resumed hold must not expire');
  assert.ok(resumed.getBinding('t-race-resume'));
});

test('a same-token reconnect is held whether or not the old socket looks live', async () => {
  // `readyState === OPEN` is NOT a liveness test — it only means the server has
  // not observed a close. The server runs no keepalive, and the client pings
  // every 30s and terminates on a missed pong, so on a dead path the client
  // notices first and its next hello arrives here with the old socket still
  // nominally OPEN. Killing on "looks live" would kill the common recovered
  // drop — the exact bug #474 exists to fix, relabeled `superseded`.
  //
  // So both socket states take the hold, and an unresumed hold expires into the
  // `superseded` terminal this path has always produced.
  for (const [label, state] of [
    ['live-looking', WS_OPEN],
    ['dead', WS_CLOSED],
  ] as const) {
    const registry = new Registry(20);
    registerFor(registry, makeWs(state));
    const task = bindCapturing(registry, 'a1', `t-collision-${label}`);

    registerFor(registry, makeWs());

    assert.ok(registry.getBinding(`t-collision-${label}`), `${label}: must be held, not killed`);
    assert.equal(task.state.finished, false, `${label}: no premature terminal`);

    await sleep(80);

    assert.equal(task.state.finished, true, `${label}: an unresumed hold must expire`);
    assert.equal(registry.getBinding(`t-collision-${label}`), undefined);
    assert.match(terminalText(task), /superseded/, `${label}: expiry keeps this path's terminal`);
  }
});

test('a reconnect reclaiming its task survives, even when the old socket still looked live', async () => {
  // The payoff of the above: the client that reconnected is normally the SAME
  // client, and one frame on the new connection rescues its in-flight work.
  const registry = new Registry(20);
  registerFor(registry, makeWs(WS_OPEN));
  const task = bindCapturing(registry, 'a1', 't-collision-reclaim');

  registerFor(registry, makeWs());
  registry.resumeBinding('t-collision-reclaim', 'a1');

  await sleep(80);

  assert.equal(task.state.finished, false, 'a reclaimed task must not be failed');
  assert.ok(registry.getBinding('t-collision-reclaim'));
});

test('a connection this server condemned is never rescued by a reconnect', () => {
  // disconnectClient() closes with 4014 because the owner deleted the client.
  // A hello arriving on that token before the close event lands must not
  // resurrect its tasks through the reconnect branch.
  const registry = new Registry(10_000);
  const ws = makeWs();
  registerFor(registry, ws, 'a1', 'c1');
  const task = bindCapturing(registry, 'a1', 't-condemned');

  assert.equal(registry.disconnectClient('c1'), 1);
  registerFor(registry, makeWs(), 'a1', 'c1'); // the racing reconnect

  assert.equal(
    registry.getBinding('t-condemned'),
    undefined,
    'a deleted client must not be graced',
  );
  assert.equal(task.state.finished, true);
  assert.match(terminalText(task), /disconnected mid-task/);
});

test('the late close of an already-replaced socket does not re-hold or double-fail', () => {
  const registry = new Registry(10_000);
  const deadWs = makeWs(WS_CLOSED);
  registerFor(registry, deadWs);
  const task = bindCapturing(registry, 'a1', 't-late-close');

  registerFor(registry, makeWs()); // holds t-late-close
  registry.resumeBinding('t-late-close', 'a1'); // client's first frame resumes it

  registry.unregisterAgent('a1', deadWs, 1006);

  assert.ok(registry.getBinding('t-late-close'));
  assert.equal(task.state.finished, false);
});

test("resumeBinding cannot be used by one agent to rescue another agent's held task", () => {
  const registry = new Registry(10_000);
  const ws = makeWs();
  registerFor(registry, ws, 'a1', 'c1');
  bindCapturing(registry, 'a1', 't-owned');

  registry.unregisterAgent('a1', ws, 1012);
  registry.resumeBinding('t-owned', 'other-agent');

  assert.ok(registry.getBinding('t-owned'));
});
test('with the grace disabled, the reconnect race keeps its original superseded terminal', () => {
  const registry = new Registry(0);
  registerFor(registry, makeWs(WS_CLOSED));
  const task = bindCapturing(registry, 'a1', 't-nograce-race');

  registerFor(registry, makeWs());

  assert.equal(registry.getBinding('t-nograce-race'), undefined);
  assert.equal(task.state.finished, true);
  assert.match(terminalText(task), /superseded/);
});

// ---------------------------------------------------------------------------
// Guard coverage.
//
// The three `clearGraceHold` call sites and the "don't slide the deadline" skip
// are individually invisible to a test that only checks the binding right after
// the event: the timer's own identity guard independently suppresses a stale
// fire, so deleting either half of that pair changes nothing observable at that
// moment. What DOES expose a missing clear is the *next* hold for the same
// taskId — `holdBindingsForAgent` skips a taskId that already has an entry, so
// a hold left behind by a finished binding silently denies its successor a
// hold, and that successor then never expires. Each test below drives exactly
// that sequence through one of the clear sites.
//
// Not covered, deliberately: the identity guards inside `resumeBinding` and the
// expiry timer. With every clear site intact, `graceHolds` can only ever hold
// an entry for the binding currently occupying that taskId, so those guards are
// unreachable defense-in-depth against a future missing clear — no behavioral
// test can distinguish them. They are kept precisely because the tests here
// cannot speak for them.
// ---------------------------------------------------------------------------

// Re-hold a taskId after its previous binding is gone, and prove the new
// binding still gets a working hold of its own (i.e. that the old one's entry
// was cleared). `settle` performs whatever terminated the previous binding.
async function assertSuccessorIsHeld(
  registry: Registry,
  settle: (binding: TaskBinding) => void,
  taskId: string,
): Promise<void> {
  const ws1 = makeWs();
  registerFor(registry, ws1);
  bindCapturing(registry, 'a1', taskId);
  const first = registry.getBinding(taskId);
  assert.ok(first);

  registry.unregisterAgent('a1', ws1, 1012); // first binding is now held
  settle(first);

  // A new run claims the same taskId, then its client drops too.
  const successor = bindCapturing(registry, 'a1', taskId);
  const ws2 = makeWs();
  registerFor(registry, ws2);
  registry.unregisterAgent('a1', ws2, 1012);

  await sleep(80);

  // The successor must have been held and then expired. A stale entry from the
  // first binding would have made `holdBindingsForAgent` skip it, leaving it
  // bound and unfinished forever.
  assert.equal(successor.state.finished, true, 'successor was never held, so it never expired');
  assert.equal(registry.getBinding(taskId), undefined);
  assert.match(terminalText(successor), /disconnected mid-task/);
}

test('unbindTask clears the hold, so the next binding for that taskId can be held', async () => {
  const registry = new Registry(20);
  await assertSuccessorIsHeld(
    registry,
    (binding) => registry.unbindTask(binding.taskId, binding),
    't-clear-unbind',
  );
});

test('a displacing bindTask clears the hold, so the displacing binding can be held', async () => {
  const registry = new Registry(20);
  // bindCapturing inside the helper is what displaces the held binding here.
  await assertSuccessorIsHeld(registry, () => undefined, 't-clear-rebind');
});

test('failBindingsForAgent clears the hold, so the next binding for that taskId can be held', async () => {
  const registry = new Registry(20);
  await assertSuccessorIsHeld(
    registry,
    () => {
      // Reconnect and take an app-level close: fails the held binding outright.
      const ws = makeWs();
      registerFor(registry, ws);
      registry.unregisterAgent('a1', ws, 4009);
    },
    't-clear-fail',
  );
});

test('a second disconnect leaves no extra expiry timer behind', async () => {
  // `holdBindingsForAgent` skips a taskId that already has a hold rather than
  // arming a second timer for it. Overwriting instead would look harmless — the
  // newer timer replaces the map entry — but the ORIGINAL timer stays pending
  // and unreferenced, and `resumeBinding` can only cancel the one it can see.
  // The orphan then fires on the old deadline and fails a task that was already
  // resumed and is happily running.
  const registry = new Registry(60);
  const ws1 = makeWs();
  registerFor(registry, ws1);
  const task = bindCapturing(registry, 'a1', 't-one-timer');

  registry.unregisterAgent('a1', ws1, 1012);

  // A second drop, comfortably inside the first hold's window.
  await sleep(20);
  const ws2 = makeWs();
  registerFor(registry, ws2);
  registry.unregisterAgent('a1', ws2, 1012);

  // The client comes back for good and resumes the task.
  registry.resumeBinding('t-one-timer', 'a1');

  // Past the first hold's deadline. Nothing may fire.
  await sleep(100);

  assert.equal(task.state.finished, false, 'an orphaned expiry timer failed a resumed task');
  assert.ok(registry.getBinding('t-one-timer'));
});

test('a foreign agent resuming a hold does not stop it from expiring', async () => {
  // The agentId check in resumeBinding is the whole of its authorization. Held
  // bindings stay in the map either way, so asserting presence proves nothing —
  // only expiry does.
  const registry = new Registry(20);
  const ws = makeWs();
  registerFor(registry, ws, 'a1', 'c1');
  const task = bindCapturing(registry, 'a1', 't-foreign');

  registry.unregisterAgent('a1', ws, 1012);
  registry.resumeBinding('t-foreign', 'other-agent');

  await sleep(80);

  assert.equal(task.state.finished, true, 'a foreign agent cancelled the hold');
  assert.equal(registry.getBinding('t-foreign'), undefined);
});

test('the owning agent resuming a hold does stop it from expiring', async () => {
  // Companion to the above: same shape, correct agentId, opposite outcome — so
  // the pair pins the check rather than just the expiry.
  const registry = new Registry(20);
  const ws = makeWs();
  registerFor(registry, ws, 'a1', 'c1');
  const task = bindCapturing(registry, 'a1', 't-owner');

  registry.unregisterAgent('a1', ws, 1012);
  registry.resumeBinding('t-owner', 'a1');

  await sleep(80);

  assert.equal(task.state.finished, false);
  assert.ok(registry.getBinding('t-owner'));
});

test('a close code the bridge itself sent is terminal even when it comes back as 1006', () => {
  // `disconnectClient` closes with 4014, but the code we OBSERVE is whatever
  // our socket ends up with: a peer that never echoes the close frame leaves
  // `ws` to time out and report 1006, which is graceable. The deleted client's
  // tasks must still die immediately.
  const registry = new Registry(10_000);
  const ws = makeWs();
  registerFor(registry, ws, 'a1', 'c1');
  const task = bindCapturing(registry, 'a1', 't-deleted');

  assert.equal(registry.disconnectClient('c1'), 1);
  registry.unregisterAgent('a1', ws, 1006); // peer never acked; ws reports 1006

  assert.equal(registry.getBinding('t-deleted'), undefined, 'a deleted client must not be graced');
  assert.equal(task.state.finished, true);
});

test('close-code classification at the app-level boundaries', () => {
  // 4000-4999 is the bridge's own range; 5000 and up is not ours and is treated
  // like any other unexpected close.
  const cases: Array<[number, boolean]> = [
    [4000, false],
    [4999, false],
    [5000, true],
    [3999, true],
    [1001, true],
    [1005, true],
  ];
  for (const [code, expectHold] of cases) {
    const registry = new Registry(10_000);
    const ws = makeWs();
    registerFor(registry, ws);
    bindCapturing(registry, 'a1', `t-code-${code}`);
    registry.unregisterAgent('a1', ws, code);
    assert.equal(
      registry.getBinding(`t-code-${code}`) !== undefined,
      expectHold,
      `close code ${code} should ${expectHold ? 'hold' : 'fail immediately'}`,
    );
  }
});

test('unregisterAgent with no close code holds (the #364 reconcile path)', () => {
  // ws.ts reconciles a socket that died during async auth by calling
  // unregisterAgent with no code. Absence of a code is not evidence the client
  // is gone for good, so it is graceable — and in that path there are no
  // bindings anyway, since registration never completed.
  const registry = new Registry(10_000);
  const ws = makeWs();
  registerFor(registry, ws);
  const task = bindCapturing(registry, 'a1', 't-nocode');

  registry.unregisterAgent('a1', ws);

  assert.ok(registry.getBinding('t-nocode'));
  assert.equal(task.state.finished, false);
});

// ---------------------------------------------------------------------------
// Blast radius: a hold or a failure must touch ONE agent's tasks.
//
// The agent filters in failBindingsForAgent/holdBindingsForAgent were entirely
// unconstrained — deleting either left the suite green, because no test had two
// agents holding bindings at the same time. Without them a single client's
// disconnect fails (or, 30s later, kills) every other client's in-flight work.
// ---------------------------------------------------------------------------

test('one agent disconnecting does not fail another agent\'s in-flight task', () => {
  const registry = new Registry(0); // grace off: the immediate-fail path
  const wsA = makeWs();
  const wsB = makeWs();
  registerFor(registry, wsA, 'a1', 'c1');
  registerFor(registry, wsB, 'a2', 'c2');
  const mine = bindCapturing(registry, 'a1', 't-mine');
  const theirs = bindCapturing(registry, 'a2', 't-theirs');

  registry.unregisterAgent('a1', wsA, 1012);

  assert.equal(mine.state.finished, true);
  assert.equal(theirs.state.finished, false, "another agent's task was failed");
  assert.ok(registry.getBinding('t-theirs'));
  assert.deepEqual(theirs.statuses, []);
});

test('one agent disconnecting does not hold — or later kill — another agent\'s task', async () => {
  const registry = new Registry(20); // grace on: the hold path
  const wsA = makeWs();
  const wsB = makeWs();
  registerFor(registry, wsA, 'a1', 'c1');
  registerFor(registry, wsB, 'a2', 'c2');
  bindCapturing(registry, 'a1', 't-a-task');
  const theirs = bindCapturing(registry, 'a2', 't-b-task');

  registry.unregisterAgent('a1', wsA, 1012);

  // Past the deadline: a1's task expires, a2's — never held — must be untouched.
  await sleep(80);

  assert.equal(registry.getBinding('t-a-task'), undefined, "the disconnecting agent's task expired");
  assert.equal(theirs.state.finished, false, "another agent's task was swept up in the hold");
  assert.ok(registry.getBinding('t-b-task'));
  assert.ok(registry.getAgent('a2'), 'the other agent is still connected');
});

// ---------------------------------------------------------------------------
// The expiry timer's own cleanup is a FOURTH clear site.
//
// The guard-coverage note above lists three explicit clearGraceHold calls, but
// the timer deletes its own map entry too. Leave that out and a naturally
// expired hold's entry outlives it, and the `has()` skip then denies the next
// binding for that taskId a hold of its own — the same successor failure the
// three explicit sites are tested through.
// ---------------------------------------------------------------------------

test('a naturally expired hold clears its own entry, so the taskId can be held again', async () => {
  const registry = new Registry(20);
  const ws1 = makeWs();
  registerFor(registry, ws1);
  const first = bindCapturing(registry, 'a1', 't-reexpire');

  registry.unregisterAgent('a1', ws1, 1012);
  await sleep(80);
  assert.equal(first.state.finished, true, 'precondition: the first hold expired');
  assert.equal(registry.getBinding('t-reexpire'), undefined);

  // The same taskId comes round again (A2A reuses a taskId across turns) and
  // its client drops too.
  const successor = bindCapturing(registry, 'a1', 't-reexpire');
  const ws2 = makeWs();
  registerFor(registry, ws2);
  registry.unregisterAgent('a1', ws2, 1012);

  await sleep(80);

  assert.equal(successor.state.finished, true, 'a stale entry denied the successor its hold');
  assert.equal(registry.getBinding('t-reexpire'), undefined);
});

// ---------------------------------------------------------------------------
// The production configuration path.
//
// `index.ts` constructs `new Registry()` with no argument, so the default, the
// env parse and the clamp are exactly the code no other test reaches — every
// grace test injects its value through the constructor. A typo'd default or a
// broken parse would ship with a green suite.
// ---------------------------------------------------------------------------

test('resolveDisconnectGraceMs covers default, env, clamp and rejection', () => {
  assert.deepEqual(resolveDisconnectGraceMs(undefined), {
    ms: FALLBACK_DISCONNECT_GRACE_MS,
    source: 'default',
  });
  assert.deepEqual(resolveDisconnectGraceMs(''), {
    ms: FALLBACK_DISCONNECT_GRACE_MS,
    source: 'default',
  });
  assert.deepEqual(resolveDisconnectGraceMs('45000'), { ms: 45_000, source: 'env' });
  // 0 is the documented kill switch and must survive as a real 0, not be
  // mistaken for "unset".
  assert.deepEqual(resolveDisconnectGraceMs('0'), { ms: 0, source: 'env' });
  assert.deepEqual(resolveDisconnectGraceMs(String(MAX_DISCONNECT_GRACE_MS)), {
    ms: MAX_DISCONNECT_GRACE_MS,
    source: 'env',
  });
  // Past setTimeout's ceiling the timer would collapse to 1ms — i.e. asking for
  // a very long hold would silently give none at all.
  assert.deepEqual(resolveDisconnectGraceMs(String(MAX_DISCONNECT_GRACE_MS + 1)), {
    ms: MAX_DISCONNECT_GRACE_MS,
    source: 'clamped',
  });
  // `-1` is a common "disable" idiom; silently restoring the 30s default would
  // be the opposite of the operator's intent, so it is reported as invalid.
  assert.deepEqual(resolveDisconnectGraceMs('-1'), {
    ms: FALLBACK_DISCONNECT_GRACE_MS,
    source: 'invalid',
  });
  assert.deepEqual(resolveDisconnectGraceMs('30s'), {
    ms: FALLBACK_DISCONNECT_GRACE_MS,
    source: 'invalid',
  });
});

test('a default-constructed Registry actually grants a grace hold', async () => {
  // The shape production runs (`new Registry()`, index.ts). Guards the default
  // constant itself: at 0 the feature is off and this binding would be failed
  // on the spot.
  const registry = new Registry();
  const ws = makeWs();
  registerFor(registry, ws);
  const task = bindCapturing(registry, 'a1', 't-default');

  registry.unregisterAgent('a1', ws, 1012);

  assert.ok(registry.getBinding('t-default'), 'the default grace is disabled');
  assert.equal(task.state.finished, false);

  // Long enough to prove it is not a near-zero timer, short enough to stay a
  // unit test. The real deadline is minutes away in wall-clock terms.
  await sleep(60);
  assert.ok(registry.getBinding('t-default'), 'the default grace is far too short');

  // Don't leave a live 30s hold behind for the runner to trip over.
  registry.unbindTask('t-default', registry.getBinding('t-default')!);
});
