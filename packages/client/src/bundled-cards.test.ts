import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentCard, OPENAI_COMPAT_EXTENSION_URI } from '@vicoop-bridge/protocol';
import { BUNDLED_CARDS, resolveBundledCard } from './bundled-cards.js';

// Locks in the invariant the openai-compat/v1 `params.models` advertise
// relies on: bundled cards must be embedded (not fs-resolved) so they
// reach `Client.resolveEffectiveCard` from inside a `bun --compile`
// single-file binary, and the openai-compat extension must already be
// declared on every probe-capable backend's card — `withOpenAICompatModelsAdvertise`
// intentionally no-ops when the URI isn't already present.
const PROBE_CAPABLE_BACKENDS = ['claude', 'codex'] as const;

for (const kind of Object.keys(BUNDLED_CARDS)) {
  test(`bundled card for "${kind}" parses as an AgentCard`, () => {
    const raw = resolveBundledCard(kind);
    assert.ok(raw, `expected BUNDLED_CARDS["${kind}"] to be defined`);
    assert.doesNotThrow(() => AgentCard.parse(raw));
  });
}

for (const kind of PROBE_CAPABLE_BACKENDS) {
  test(`bundled card for "${kind}" declares the openai-compat extension`, () => {
    const card = AgentCard.parse(resolveBundledCard(kind));
    const exts = card.capabilities?.extensions ?? [];
    const hit = exts.find((e) => e.uri === OPENAI_COMPAT_EXTENSION_URI);
    assert.ok(
      hit,
      `card for "${kind}" must declare ${OPENAI_COMPAT_EXTENSION_URI} so the resolveCapabilities advertise has a merge target`,
    );
  });
}

test('resolveBundledCard returns null for an unknown backend kind', () => {
  assert.equal(resolveBundledCard('does-not-exist'), null);
});
