import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebSocket } from 'ws';
import type { AgentCard } from '@vicoop-bridge/protocol';
import type { Sql } from './db.js';
import { CALLER_POLICY_CHANNEL, watchCallerPolicyChanges } from './caller-policy-watch.js';
import { Registry, type ClientConnection } from './registry.js';

test('caller-policy notifications refresh the instance holding the agent socket', async () => {
  let listener: ((payload: string) => void) | undefined;
  let refreshed!: () => void;
  const refreshedPromise = new Promise<void>((resolve) => { refreshed = resolve; });
  const sql = (async () => {
    refreshed();
    return [{ allowed_callers: ['federated:v1:new'] }];
  }) as unknown as Sql;
  sql.listen = (async (channel: string, callback: (payload: string) => void) => {
    assert.equal(channel, CALLER_POLICY_CHANNEL);
    listener = callback;
    return { unlisten: async () => undefined };
  }) as Sql['listen'];

  const registry = new Registry();
  registry.registerAgent({
    agentId: 'agent-1',
    clientId: 'client-1',
    ownerPrincipal: 'eth:0x0000000000000000000000000000000000000001',
    allowedCallers: ['federated:v1:old'],
    agentCard: { name: 'agent', version: '1', protocolVersion: '0.3.0' } as AgentCard,
    ws: { close() {} } as unknown as WebSocket,
    connectedAt: Date.now(),
  } satisfies ClientConnection);

  await watchCallerPolicyChanges(sql, registry);
  listener?.('agent-1');
  await refreshedPromise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(registry.getAgent('agent-1')?.allowedCallers, ['federated:v1:new']);
});
