import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import type { AgentCard } from '@vicoop-bridge/protocol';
import { Registry } from './registry.js';

// Minimal WebSocket stub — Registry only uses `.close()` on replacement and
// equality (`existing.ws !== ws`) on unregister. Nothing else on the real ws
// interface is exercised here.
function makeWs(): WebSocket {
  return { close: () => undefined } as unknown as WebSocket;
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
    ownerWallet: '0x0',
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
    ownerWallet: '0x0',
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
    ownerWallet: '0x0',
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
    ownerWallet: '0x0',
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
    ownerWallet: '0x0',
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

test('onAgentChange does NOT fire on unregister if the ws does not match the current connection', () => {
  // Defensive: a late-arriving close event from a superseded socket must not
  // trigger invalidation of the new connection's cached transport.
  const registry = new Registry();
  const oldWs = makeWs();
  registry.registerAgent({
    agentId: 'a1',
    clientId: 'c1',
    ownerWallet: '0x0',
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
    ownerWallet: '0x0',
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
  // console.error don't race with this stub — node:test auto-restores the
  // original at test teardown, removing the need for a manual try/finally
  // and the "what if the test body throws before finally" window.
  const errors: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
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
    ownerWallet: '0x0',
    agentCard: makeCard(false),
    allowedCallers: [],
    ws: makeWs(),
    connectedAt: 0,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen, ['a1']);
  assert.ok(errors.some((e) => e.includes('listener boom')));
});
