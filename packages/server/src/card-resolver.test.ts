import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HelloFrame } from '@vicoop-bridge/protocol';
import { resolveHelloAgentCard } from './card-resolver.js';

function frame(overrides: Partial<HelloFrame>): Pick<HelloFrame, 'agentCard' | 'backendKind'> {
  return overrides;
}

test('resolves canonical server card from backendKind when inline card is absent', () => {
  const result = resolveHelloAgentCard(frame({ backendKind: 'claude' }));

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.source, 'canonical');
  assert.equal(result.ok && result.agentCard.name, 'claude');
  assert.deepEqual(
    result.ok && result.agentCard.defaultInputModes,
    ['text/plain', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'],
  );
});

test('inline card overrides backendKind', () => {
  const inline = {
    name: 'operator-custom',
    description: 'custom card',
    version: '9.9.9',
    protocolVersion: '0.3.0',
    capabilities: { streaming: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
  };

  const result = resolveHelloAgentCard(frame({ backendKind: 'claude', agentCard: inline }));

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.source, 'inline');
  assert.equal(result.ok && result.agentCard.name, 'operator-custom');
  assert.equal(result.ok && result.agentCard.capabilities?.streaming, false);
});

test('rejects hello without inline card or backendKind', () => {
  const result = resolveHelloAgentCard(frame({}));

  assert.deepEqual(result, {
    ok: false,
    code: 4012,
    reason: 'missing agent card or backend kind',
  });
});

test('rejects unknown backendKind when no inline card is provided', () => {
  const result = resolveHelloAgentCard(frame({ backendKind: 'custom' }));

  assert.deepEqual(result, {
    ok: false,
    code: 4013,
    reason: 'unknown backend kind: custom',
  });
});
