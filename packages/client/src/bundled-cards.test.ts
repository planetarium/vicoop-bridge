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

// Stateful-context advertisement (#410). The bundled card is what the client
// sends in its hello frame and thus what the bridge advertises to the router
// verbatim, so `params.statefulContext` must live HERE (not only in the
// server's canonical fallback cards) to reach the wire. It is coupled to the
// connector's `contextHistory` fold shipping in the same client build — only
// backends whose delta path is E2E-verified carry it.
const STATEFUL_CONTEXT_BACKENDS = ['claude', 'codex', 'vicoop-codex'] as const;

for (const kind of STATEFUL_CONTEXT_BACKENDS) {
  test(`bundled card for "${kind}" advertises params.statefulContext on openai-compat`, () => {
    const card = AgentCard.parse(resolveBundledCard(kind));
    const ext = (card.capabilities?.extensions ?? []).find(
      (e) => e.uri === OPENAI_COMPAT_EXTENSION_URI,
    );
    assert.ok(ext, `card for "${kind}" must declare the openai-compat extension`);
    assert.equal(
      (ext.params as { statefulContext?: unknown } | undefined)?.statefulContext,
      true,
      `card for "${kind}" must advertise params.statefulContext: true`,
    );
  });
}

test('bundled card for "openclaw" does NOT advertise statefulContext (not delta-verified)', () => {
  const card = AgentCard.parse(resolveBundledCard('openclaw'));
  const ext = (card.capabilities?.extensions ?? []).find(
    (e) => e.uri === OPENAI_COMPAT_EXTENSION_URI,
  );
  assert.ok(ext, 'openclaw must declare the openai-compat extension');
  assert.notEqual(
    (ext.params as { statefulContext?: unknown } | undefined)?.statefulContext,
    true,
    'openclaw must not advertise statefulContext until its delta path is verified',
  );
});

test('resolveBundledCard returns null for an unknown backend kind', () => {
  assert.equal(resolveBundledCard('does-not-exist'), null);
});
