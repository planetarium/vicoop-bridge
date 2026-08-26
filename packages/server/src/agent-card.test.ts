import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTaskStore, type AgentCardV03, type AgentCardV10 } from '@a2x/sdk';
import {
  CALLER_CONTEXT_CAPABILITY,
  MENTIONABLE_IDENTITY_VC_EXTENSION_URI,
  SIWE_BEARER_AUTH_EXTENSION_URI,
  TRACEABILITY_EXTENSION_URI,
  type AgentCard,
} from '@vicoop-bridge/protocol';
import { X402_FOUNDATION_EXTENSION_URI } from '@a2x/sdk/x402';
import { buildAgentA2XServer } from './agent-card.js';
import { Registry, type ClientConnection } from './registry.js';
import { parseX402Pricing } from './x402/pricing.js';
import type { Sql } from './db.js';

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

test('identity VC extension is advertised only when capability, private trust, and verifier dependencies are ready', () => {
  const wireCard: AgentCard = {
    name: 'claude',
    description: 'Claude Code',
    version: '0.0.1',
    protocolVersion: '0.3.0',
    capabilities: {
      streaming: true,
      // A wire client cannot self-advertise verification the bridge did not wire.
      extensions: [{ uri: MENTIONABLE_IDENTITY_VC_EXTENSION_URI, required: true }],
    },
  };
  const fakeSql = {} as Sql;
  const ready = buildAgentA2XServer(
    fakeConn(wireCard, {
      protocolCapabilities: [CALLER_CONTEXT_CAPABILITY],
      identityTrust: { trustedIssuers: ['did:web:issuer.example'] },
    }),
    new InMemoryTaskStore(),
    new Registry(),
    { publicUrl: 'https://bridge.example', deviceFlowEnabled: false, db: fakeSql },
  ).getAgentCard() as AgentCardV03;
  const entries = (ready.capabilities.extensions ?? []).filter(
    (extension) => extension.uri === MENTIONABLE_IDENTITY_VC_EXTENSION_URI,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.required, false);
  assert.equal(entries[0]!.params, undefined, 'private trust entries must not be exposed');

  for (const overrides of [
    { protocolCapabilities: [], identityTrust: { trustedIssuers: ['did:web:issuer.example'] } },
    { protocolCapabilities: [CALLER_CONTEXT_CAPABILITY], identityTrust: { trustedIssuers: [] } },
  ] satisfies Partial<ClientConnection>[]) {
    const notReady = buildAgentA2XServer(
      fakeConn(wireCard, overrides),
      new InMemoryTaskStore(),
      new Registry(),
      { publicUrl: 'https://bridge.example', deviceFlowEnabled: false, db: fakeSql },
    ).getAgentCard() as AgentCardV03;
    assert.equal(
      notReady.capabilities.extensions?.some(
        (extension) => extension.uri === MENTIONABLE_IDENTITY_VC_EXTENSION_URI,
      ) ?? false,
      false,
    );
  }
});

test('buildAgentA2XServer publishes v1 JSON-RPC and HTTP+JSON on one versioned base URL', () => {
  const agent = buildAgentA2XServer(
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
    {
      publicUrl: 'https://bridge.example',
      deviceFlowEnabled: false,
      protocolVersion: '1.0',
    },
  );

  const card = agent.getAgentCard() as AgentCardV10;
  assert.deepEqual(card.supportedInterfaces, [
    {
      url: 'https://bridge.example/agents/claude/v1',
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    },
    {
      url: 'https://bridge.example/agents/claude/v1',
      protocolBinding: 'HTTP+JSON',
      protocolVersion: '1.0',
    },
  ]);
  assert.equal((card as AgentCardV10 & { protocolVersion?: string }).protocolVersion, undefined);
});

test('buildAgentA2XServer preserves advertised optional extensions', () => {
  const agent = buildAgentA2XServer(
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

test('buildAgentA2XServer advertises SIWE bearer-auth extension when restricted', () => {
  const agent = buildAgentA2XServer(
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
  // Mirror vicoop-db-agent-builder — fail-closed for clients that don't
  // understand the URI.
  assert.equal(siwe.required, true);
  assert.equal((siwe.params as { domain: string }).domain, 'bridge.example');
  assert.equal((siwe.params as { uri: string }).uri, 'https://bridge.example');
});

test('buildAgentA2XServer exposes bearerAuth + deviceFlow security schemes when restricted (mirrors dba)', () => {
  const agent = buildAgentA2XServer(
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
    { publicUrl: 'https://bridge.example', deviceFlowEnabled: true },
  );

  const card = agent.getAgentCard() as AgentCardV03;
  const schemes = card.securitySchemes ?? {};
  assert.ok(schemes.bearerAuth, 'expected bearerAuth scheme');
  assert.equal((schemes.bearerAuth as { type: string }).type, 'http');
  assert.equal((schemes.bearerAuth as { scheme: string }).scheme, 'bearer');
  assert.equal((schemes.bearerAuth as { bearerFormat: string }).bearerFormat, 'SIWE');
  assert.ok(schemes.deviceFlow, 'expected deviceFlow scheme');
  assert.equal((schemes.deviceFlow as { type: string }).type, 'oauth2');
  // Both should appear as alternatives in security[].
  assert.deepEqual(card.security, [{ bearerAuth: [] }, { deviceFlow: [] }]);
  // Old `bridge` key from before the dba-parity refactor must not survive.
  assert.equal((schemes as Record<string, unknown>).bridge, undefined);
});

test('buildAgentA2XServer omits deviceFlow when device flow is not enabled', () => {
  const agent = buildAgentA2XServer(
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
  const schemes = card.securitySchemes ?? {};
  assert.ok(schemes.bearerAuth, 'expected bearerAuth scheme');
  assert.equal((schemes as Record<string, unknown>).deviceFlow, undefined);
  assert.deepEqual(card.security, [{ bearerAuth: [] }]);
});

test('buildAgentA2XServer omits SIWE extension for public agents', () => {
  const agent = buildAgentA2XServer(
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

test('buildAgentA2XServer overrides a wire-declared SIWE extension with the bridge version', () => {
  // The bridge is authoritative for params (domain / endpoint / hints) and
  // for `required: true`; a client cannot weaken either via the wire card.
  const agent = buildAgentA2XServer(
    fakeConn(
      {
        name: 'claude',
        description: 'Claude Code',
        version: '0.0.1',
        protocolVersion: '0.3.0',
        capabilities: {
          streaming: true,
          extensions: [
            {
              uri: SIWE_BEARER_AUTH_EXTENSION_URI,
              description: 'wire-declared (downgraded)',
              required: false,
            },
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
  assert.equal(siweEntries.length, 1, 'expected exactly one SIWE extension entry');
  // Bridge-emitted, not wire-declared.
  assert.equal(siweEntries[0]!.required, true);
  assert.notEqual(siweEntries[0]!.description, 'wire-declared (downgraded)');
  assert.equal(
    (siweEntries[0]!.params as { domain: string }).domain,
    'bridge.example',
    'bridge must own the advertised SIWE domain',
  );
});

test('buildAgentA2XServer drops a wire-declared SIWE extension on restricted agents without publicUrl', () => {
  // Without publicUrl the middleware can't accept SIWE bearers (no
  // siweDomain). Letting a wire-declared SIWE extension pass through here
  // would advertise auth the server won't actually honor, so it must be
  // stripped — even though the bridge isn't emitting its own replacement.
  const agent = buildAgentA2XServer(
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
    { publicUrl: undefined, deviceFlowEnabled: false },
  );

  const card = agent.getAgentCard() as AgentCardV03;
  const siweEntries = (card.capabilities.extensions ?? []).filter(
    (e) => e.uri === SIWE_BEARER_AUTH_EXTENSION_URI,
  );
  assert.equal(siweEntries.length, 0);
});

test('buildAgentA2XServer leaves a wire-declared SIWE extension alone when not restricted', () => {
  // Public agent: the bridge does not enforce SIWE auth, so a wire card that
  // happens to declare the URI passes through unchanged.
  const agent = buildAgentA2XServer(
    fakeConn({
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
    }),
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

// ---- x402 advertisement ------------------------------------------------

const X402_PRICING = parseX402Pricing({
  network: 'eip155:84532',
  amount: '10000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x1111111111111111111111111111111111111111',
})!;

function cardWithX402Wire(): AgentCard {
  return {
    name: 'claude',
    description: 'Claude Code',
    version: '0.0.1',
    protocolVersion: '0.3.0',
    capabilities: {
      streaming: true,
      extensions: [
        { uri: TRACEABILITY_EXTENSION_URI, description: 'keep me' },
        // A client declaring its own price. Must never reach the card.
        {
          uri: X402_FOUNDATION_EXTENSION_URI,
          description: 'wire-declared x402',
          params: { amount: '1', payTo: '0x9999999999999999999999999999999999999999' },
        },
      ],
    },
    skills: [],
  };
}

function x402Entries(card: AgentCardV03) {
  return (card.capabilities.extensions ?? []).filter(
    (e) => e.uri === X402_FOUNDATION_EXTENSION_URI,
  );
}

test('a wire-declared x402 advertisement is dropped from a free agent', () => {
  // `addExtension` is append-only, so a passed-through entry would let an
  // agent quote a price the bridge never asks for.
  const agent = buildAgentA2XServer(
    fakeConn(cardWithX402Wire()),
    new InMemoryTaskStore(),
    new Registry(),
    { publicUrl: 'https://bridge.example', deviceFlowEnabled: false },
  );

  const card = agent.getAgentCard() as AgentCardV03;
  assert.equal(x402Entries(card).length, 0, 'a free agent must advertise no price');
  // Unrelated wire extensions still pass through.
  assert.ok(
    (card.capabilities.extensions ?? []).some((e) => e.uri === TRACEABILITY_EXTENSION_URI),
  );
});

test('a paid agent advertises exactly one x402 entry, the DB-owned one', () => {
  const agent = buildAgentA2XServer(
    fakeConn(cardWithX402Wire(), { x402Pricing: X402_PRICING }),
    new InMemoryTaskStore(),
    new Registry(),
    { publicUrl: 'https://bridge.example', deviceFlowEnabled: false, db: {} as never },
  );

  const card = agent.getAgentCard() as AgentCardV03;
  const entries = x402Entries(card);
  assert.equal(entries.length, 1, 'no duplicate URI at two different prices');
  assert.equal(
    (entries[0]!.params as { payTo: string }).payTo,
    '0x1111111111111111111111111111111111111111',
    'the DB price wins, not the wire-declared one',
  );
});

test('a paid agent without PUBLIC_URL advertises no price', () => {
  // x402 `resource` must be absolute; without one the offering could never
  // verify or settle, so the gate is withheld and the card must not quote a
  // price the gate is not installed to collect.
  const agent = buildAgentA2XServer(
    fakeConn(cardWithX402Wire(), { x402Pricing: X402_PRICING }),
    new InMemoryTaskStore(),
    new Registry(),
    { publicUrl: undefined, deviceFlowEnabled: false, db: {} as never },
  );

  const card = agent.getAgentCard() as AgentCardV03;
  assert.equal(x402Entries(card).length, 0);
});
