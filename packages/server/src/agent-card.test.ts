import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTaskStore, type AgentCardV03 } from '@a2x/sdk';
import { TRACEABILITY_EXTENSION_URI, type AgentCard } from '@vicoop-bridge/protocol';
import { buildAgentA2XAgent } from './agent-card.js';
import { Registry, type ClientConnection } from './registry.js';

function fakeConn(card: AgentCard): ClientConnection {
  return {
    agentId: 'claude',
    clientId: 'client-1',
    ownerPrincipal: 'eth:0x0000000000000000000000000000000000000001',
    agentCard: card,
    allowedCallers: [],
    ws: {} as ClientConnection['ws'],
    connectedAt: Date.now(),
  };
}

test('buildAgentA2XAgent preserves advertised optional extensions', () => {
  const agent = buildAgentA2XAgent(
    fakeConn({
      name: 'claude',
      description: 'Claude Code',
      version: '0.0.1',
      protocolVersion: '0.3.0',
      capabilities: {
        streaming: true,
        extensions: [{ uri: TRACEABILITY_EXTENSION_URI, required: false }],
      },
      skills: [],
    }),
    new InMemoryTaskStore(),
    new Registry(),
    { publicUrl: 'https://bridge.example', deviceFlowEnabled: false },
  );

  const card = agent.getAgentCard() as AgentCardV03;
  assert.deepEqual(card.capabilities.extensions, [
    { uri: TRACEABILITY_EXTENSION_URI, required: false },
  ]);
});
