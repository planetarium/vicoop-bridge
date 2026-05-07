import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTaskStore, type AgentCardV03 } from '@a2x/sdk';
import {
  SIWE_BEARER_AUTH_EXTENSION_URI,
  TRACEABILITY_EXTENSION_URI,
  type AgentCard,
} from '@vicoop-bridge/protocol';
import { buildAgentA2XAgent } from './agent-card.js';
import { Registry, type ClientConnection } from './registry.js';

function fakeConn(card: AgentCard, overrides: Partial<ClientConnection> = {}): ClientConnection {
  return {
    agentId: 'claude',
    clientId: 'client-1',
    ownerPrincipal: 'eth:0x0000000000000000000000000000000000000001',
    agentCard: card,
    allowedCallers: [],
    ws: {} as ClientConnection['ws'],
    connectedAt: Date.now(),
    ...overrides,
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

test('buildAgentA2XAgent advertises SIWE bearer-auth extension when restricted', () => {
  const agent = buildAgentA2XAgent(
    fakeConn(
      {
        name: 'claude',
        description: 'Claude Code',
        version: '0.0.1',
        protocolVersion: '0.3.0',
        capabilities: { streaming: true },
        skills: [],
      },
      { allowedCallers: ['eth:0x0000000000000000000000000000000000000002'] },
    ),
    new InMemoryTaskStore(),
    new Registry(),
    { publicUrl: 'https://bridge.example', deviceFlowEnabled: false },
  );

  const card = agent.getAgentCard() as AgentCardV03;
  const siwe = card.capabilities.extensions?.find(
    (e) => e.uri === SIWE_BEARER_AUTH_EXTENSION_URI,
  );
  assert.ok(siwe, 'expected SIWE bearer-auth extension to be advertised');
  assert.equal((siwe.params as { domain: string }).domain, 'bridge.example');
  assert.equal((siwe.params as { uri: string }).uri, 'https://bridge.example');
});

test('buildAgentA2XAgent omits SIWE extension for public agents', () => {
  const agent = buildAgentA2XAgent(
    fakeConn({
      name: 'claude',
      description: 'Claude Code',
      version: '0.0.1',
      protocolVersion: '0.3.0',
      capabilities: { streaming: true },
      skills: [],
    }),
    new InMemoryTaskStore(),
    new Registry(),
    { publicUrl: 'https://bridge.example', deviceFlowEnabled: false },
  );

  const card = agent.getAgentCard() as AgentCardV03;
  const siwe = card.capabilities.extensions?.find(
    (e) => e.uri === SIWE_BEARER_AUTH_EXTENSION_URI,
  );
  assert.equal(siwe, undefined);
});

test('buildAgentA2XAgent does not double-add SIWE extension when wire already declares it', () => {
  const agent = buildAgentA2XAgent(
    fakeConn(
      {
        name: 'claude',
        description: 'Claude Code',
        version: '0.0.1',
        protocolVersion: '0.3.0',
        capabilities: {
          streaming: true,
          extensions: [
            { uri: SIWE_BEARER_AUTH_EXTENSION_URI, description: 'wire-declared', required: true },
          ],
        },
        skills: [],
      },
      { allowedCallers: ['eth:0x0000000000000000000000000000000000000002'] },
    ),
    new InMemoryTaskStore(),
    new Registry(),
    { publicUrl: 'https://bridge.example', deviceFlowEnabled: false },
  );

  const card = agent.getAgentCard() as AgentCardV03;
  const siweEntries = (card.capabilities.extensions ?? []).filter(
    (e) => e.uri === SIWE_BEARER_AUTH_EXTENSION_URI,
  );
  assert.equal(siweEntries.length, 1);
  assert.equal(siweEntries[0]!.description, 'wire-declared');
});
