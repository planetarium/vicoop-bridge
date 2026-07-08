import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { OPENAI_COMPAT_EXTENSION_URI, type AgentCard } from '@vicoop-bridge/protocol';
import { Registry } from './registry.js';

// Minimal WebSocket stub — Registry only uses `.close()` on replacement and
// equality (`existing.ws !== ws`) on unregister. Nothing else on the real ws
// interface is exercised here.
function makeWs(): WebSocket {
  return { close: () => undefined } as unknown as WebSocket;
}

interface RecordingWs extends WebSocket {
  closeArgs: Array<{ code: number; reason: string }>;
}

function makeRecordingWs(): RecordingWs {
  const closeArgs: Array<{ code: number; reason: string }> = [];
  const ws = {
    closeArgs,
    close(code: number, reason: string) {
      closeArgs.push({ code, reason });
    },
  } as unknown as RecordingWs;
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

  registry.unregisterAgent('a1', ws);

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

  registry.unregisterAgent('a1', ws);

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

test('same-token reconnect fails the displaced connection in-flight bindings (issue #365)', () => {
  // A second daemon authenticating with the same CLIENT_TOKEN replaces the
  // incumbent. The old connection's in-flight task must receive a terminal
  // `failed` status and have its sink finished + binding dropped — otherwise
  // the task's HTTP stream hangs forever (the new daemon is a separate process
  // that never knew the old taskId, so it can't complete it either).
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
