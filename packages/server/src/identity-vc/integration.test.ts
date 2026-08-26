import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CALLER_CONTEXT_CAPABILITY, type AgentCard } from '@vicoop-bridge/protocol';
import type { WebSocket } from 'ws';
import type { ClientConnection } from '../registry.js';
import { createIdentityVcFixture } from './test-fixtures.js';
import {
  IDENTITY_VC_PRESENTED_METADATA_KEY,
  type IdentityReplayStore,
  type ResolvedDidDocument,
} from './types.js';
import { canonicalAgentMention, prepareIdentityVcAtBoundary } from './integration.js';

function connection(overrides: Partial<ClientConnection> = {}): ClientConnection {
  return {
    agentId: 'agent',
    clientId: 'client',
    ownerPrincipal: 'eth:0x0',
    agentCard: { name: 'agent', version: '1' } as AgentCard,
    allowedCallers: [],
    ws: {} as WebSocket,
    connectedAt: 0,
    ...overrides,
  };
}

function memoryReplayStore(): IdentityReplayStore {
  const consumed = new Set<string>();
  return {
    async consume(input) {
      const key = JSON.stringify([input.issuer, input.domain, input.challenge]);
      if (consumed.has(key)) return false;
      consumed.add(key);
      return true;
    },
  };
}

test('HTTP boundary strips the raw carrier and hands only normalized verified identity to the executor', async () => {
  const { credential, didDocument } = await createIdentityVcFixture();
  const conn = connection({
    protocolCapabilities: [CALLER_CONTEXT_CAPABILITY],
    identityTrust: { trustedIssuers: [credential.issuer] },
  });
  const message: Record<string, unknown> = {
    messageId: 'message-1',
    metadata: {
      keep: true,
      mentionable: {
        verifiable_credentials: [credential],
        identity_evidence: [{ raw: 'legacy-secret' }],
        policy: { keep: true },
      },
    },
  };
  const result = await prepareIdentityVcAtBoundary(message, {
    conn,
    expectedDomain: '@agent@bridge.example',
    resolver: { async resolve(): Promise<ResolvedDidDocument> { return didDocument; } },
    replayStore: memoryReplayStore(),
    now: () => new Date('2026-08-18T14:00:00.000Z'),
  });

  assert.deepEqual(result, { accepted: 1, rejections: [] });
  const metadata = message.metadata as Record<string, unknown>;
  assert.deepEqual(metadata.keep, true);
  assert.deepEqual(metadata.mentionable, { policy: { keep: true } });
  assert.deepEqual(metadata[IDENTITY_VC_PRESENTED_METADATA_KEY], [
    {
      credentialId: credential.id,
      issuer: credential.issuer,
      subject: 'slack:T123/U456',
      method: 'urn:mentionable:auth:slack-workspace-member:v0.1',
      assurance: 'platform',
      platform: { provider: 'slack', workspaceId: 'T123' },
      observedInvocation: { target: '@agent@bridge.example' },
      profile: { displayName: 'Alice', username: 'alice' },
    },
  ]);
  const serialized = JSON.stringify(message);
  assert.equal(serialized.includes('proofValue'), false);
  assert.equal(serialized.includes('legacy-secret'), false);
  assert.equal(serialized.includes('discard-me'), false);
});

test('carrier is stripped without parsing or fetching when capability/trust gating is off', async () => {
  let resolutions = 0;
  const message: Record<string, unknown> = {
    messageId: 'message-1',
    metadata: {
      mentionable: { verifiable_credentials: [{ issuer: 'did:web:attacker.example' }] },
    },
  };
  const result = await prepareIdentityVcAtBoundary(message, {
    conn: connection(),
    expectedDomain: '@agent@bridge.example',
    resolver: {
      async resolve(): Promise<ResolvedDidDocument> {
        resolutions++;
        throw new Error('must not resolve');
      },
    },
    replayStore: memoryReplayStore(),
  });
  assert.deepEqual(result, { accepted: 0, rejections: [] });
  assert.equal(resolutions, 0);
  assert.equal(message.metadata, undefined);
});

test('invalid optional VC is discarded while ordinary request metadata survives', async () => {
  const message: Record<string, unknown> = {
    messageId: 'message-1',
    metadata: {
      keep: 'yes',
      mentionable: { verifiable_credentials: [{ not: 'a credential' }] },
    },
  };
  const result = await prepareIdentityVcAtBoundary(message, {
    conn: connection({
      protocolCapabilities: [CALLER_CONTEXT_CAPABILITY],
      identityTrust: { trustedIssuers: ['did:web:issuer.example'] },
    }),
    expectedDomain: '@agent@bridge.example',
    resolver: { async resolve(): Promise<ResolvedDidDocument> { throw new Error('unused'); } },
    replayStore: memoryReplayStore(),
  });
  assert.deepEqual(result, { accepted: 0, rejections: [{ code: 'unsupported_profile' }] });
  assert.deepEqual(message.metadata, { keep: 'yes' });
});

test('canonical recipient mention derives from configured public URL only', () => {
  assert.equal(canonicalAgentMention('agent', 'https://bridge.example:8443/base'), '@agent@bridge.example');
  assert.equal(canonicalAgentMention('agent', undefined), undefined);
  assert.equal(canonicalAgentMention('agent', 'not a URL'), undefined);
});
