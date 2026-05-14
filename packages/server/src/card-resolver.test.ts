import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENAI_COMPAT_EXTENSION_URI,
  type HelloFrame,
} from '@vicoop-bridge/protocol';
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
    ['text/plain', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'application/json'],
  );
});

test('resolves canonical codex server card from backendKind', () => {
  const result = resolveHelloAgentCard(frame({ backendKind: 'codex' }));

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.source, 'canonical');
  assert.equal(result.ok && result.agentCard.name, 'codex');
  assert.deepEqual(
    result.ok && result.agentCard.defaultInputModes,
    ['text/plain', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/json'],
  );
  assert.deepEqual(result.ok && result.agentCard.defaultOutputModes, ['text/plain']);
});

test('resolves canonical codex-app-server card from backendKind', () => {
  // The new backend shares the codex capability surface (one Codex agent
  // either way; only the transport differs), so the canonical card mirrors
  // the codex one for input/output modes — callers fetching the
  // well-known agent-card.json shouldn't see a different contract just
  // because the operator opted into the persistent-process backend.
  const result = resolveHelloAgentCard(frame({ backendKind: 'codex-app-server' }));

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.source, 'canonical');
  assert.equal(result.ok && result.agentCard.name, 'codex-app-server');
  assert.deepEqual(
    result.ok && result.agentCard.defaultInputModes,
    ['text/plain', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/json'],
  );
  assert.deepEqual(result.ok && result.agentCard.defaultOutputModes, ['text/plain']);
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
    reason: 'unknown backend kind',
    backendKind: 'custom',
  });
});

// Pin the openai-compat advertisement on canonical cards: this is the
// surface external A2A callers fetch via `/agents/<id>/.well-known/agent-card.json`
// when an operator hasn't supplied an inline card override. The card-side
// advertisement and the client-side metadata-honoring code were shipped in
// PRs #152 / #159 / #161, but the original PRs touched only the
// client-bundled `packages/client/cards/*.json` files; without these
// canonical-card entries the URI silently disappears for every operator on
// the default `setup` path (which doesn't pass `--card`).
//
// If a future card edit drops the URI, callers that rely on the card to
// decide whether to send the openai-compat metadata payload will assume
// the bridge can't honor it and silently fall back to text injection or
// refuse the call. So pin it here.
for (const kind of ['claude', 'codex', 'codex-app-server', 'openclaw'] as const) {
  test(`canonical ${kind} card advertises the openai-compat extension URI`, () => {
    const result = resolveHelloAgentCard(frame({ backendKind: kind }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const uris =
      result.agentCard.capabilities?.extensions?.map((e) => e.uri) ?? [];
    assert.ok(
      uris.includes(OPENAI_COMPAT_EXTENSION_URI),
      `expected canonical ${kind} card to advertise ${OPENAI_COMPAT_EXTENSION_URI}, got: ${JSON.stringify(uris)}`,
    );
  });
}
