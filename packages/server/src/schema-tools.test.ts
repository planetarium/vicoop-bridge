// Unit tests for the schema-tools cache, focused on the single-flight
// guarantee from #367: a cold cache hit by concurrent callers must trigger
// exactly one PostGraphile introspection, and a failed introspection must be
// retryable rather than poisoning the cache.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchemaTools, invalidateToolCache } from './schema-tools.js';

// Minimal but valid introspection payload: an empty schema is enough to drive
// the build path (empty tool defs + SDL) without standing up PostGraphile.
const EMPTY_SCHEMA = {
  data: {
    __schema: {
      queryType: { fields: [] },
      mutationType: { fields: [] },
      types: [],
    },
  },
};

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => payload,
  };
}

// Mock fetch so the introspection round-trip resolves after a delay,
// guaranteeing concurrent callers overlap on the in-flight promise. The delay
// can vary per call so a test can control which build resolves last.
function deferredFetch(
  payloadFor: (callIndex: number) => unknown,
  delayFor: (callIndex: number) => number = () => 5,
) {
  let calls = 0;
  const fn = async () => {
    const index = calls++;
    await new Promise((r) => setTimeout(r, delayFor(index)));
    return jsonResponse(payloadFor(index)) as unknown as Response;
  };
  return { fn, callCount: () => calls };
}

test('concurrent first calls trigger exactly one introspection (single-flight)', async (t) => {
  invalidateToolCache();
  const { fn, callCount } = deferredFetch(() => EMPTY_SCHEMA);
  t.mock.method(globalThis, 'fetch', fn);

  // Issue the calls synchronously so they race on the cold cache, and keep the
  // returned promises so we can assert they are the *same* in-flight promise
  // (true single-flight, not just "second caller read a warm cache").
  const pending = [
    getSchemaTools(),
    getSchemaTools(),
    getSchemaTools(),
    getSchemaTools(),
    getSchemaTools(),
  ];
  for (const p of pending) assert.equal(p, pending[0], 'concurrent callers share one in-flight promise');

  const results = await Promise.all(pending);

  assert.equal(callCount(), 1, 'introspection should run once across concurrent callers');
  // All callers observe the same cached object identity.
  for (const r of results) {
    assert.equal(r, results[0]);
    assert.ok(r.tools.execute_graphql, 'built tools should include the raw escape hatch');
  }

  // A subsequent call after the cache is warm performs no further fetch.
  const warm = await getSchemaTools();
  assert.equal(warm, results[0]);
  assert.equal(callCount(), 1, 'warm cache must not re-introspect');

  invalidateToolCache();
});

test('invalidateToolCache forces a fresh introspection', async (t) => {
  invalidateToolCache();
  const { fn, callCount } = deferredFetch(() => EMPTY_SCHEMA);
  t.mock.method(globalThis, 'fetch', fn);

  const first = await getSchemaTools();
  assert.equal(callCount(), 1);

  invalidateToolCache();

  const second = await getSchemaTools();
  assert.equal(callCount(), 2, 'invalidation should drop the cache and re-introspect');
  assert.notEqual(second, first, 'a rebuilt tool set is a new object');

  invalidateToolCache();
});

test('invalidation mid-build does not resurrect the stale result into the cache', async (t) => {
  invalidateToolCache();
  // Both builds use the same payload; we distinguish them by the object
  // identity of the tool set each build() returns. Build #1 is invalidated
  // while its fetch is still in flight; when it resolves it must NOT write its
  // (now stale) result back into cachedTools. Build #1's fetch is deliberately
  // slow (40ms) so it resolves *after* the post-invalidation build #2 (5ms).
  // Without the epoch guard, build #1's late .then would overwrite cachedTools
  // with its stale result — the bug.
  const { fn, callCount } = deferredFetch(
    () => EMPTY_SCHEMA,
    (i) => (i === 0 ? 40 : 5),
  );
  t.mock.method(globalThis, 'fetch', fn);

  // Start build #1 (captures generation 0) but don't await it yet.
  const stalePromise = getSchemaTools();
  // Invalidate while build #1 is parked on its slow fetch → bumps generation.
  invalidateToolCache();
  // Build #2 starts fresh under the new generation.
  const fresh = await getSchemaTools();
  // Drain build #1 so its .then runs; under the epoch guard it must be a no-op.
  await stalePromise;

  assert.equal(callCount(), 2, 'invalidation mid-build forces a second introspection');
  // The warm cache must reflect build #2, not the resurrected build #1.
  const afterDrain = await getSchemaTools();
  assert.equal(afterDrain, fresh, 'cache holds the fresh build, not the stale resurrected one');
  assert.equal(callCount(), 2, 'reading the warm cache after drain must not re-introspect');

  invalidateToolCache();
});

test('a failed introspection is retryable (in-flight promise is cleared on error)', async (t) => {
  invalidateToolCache();
  // First introspection returns GraphQL errors (buildSchema throws); the
  // second returns a valid schema. If the rejected promise were cached, the
  // retry would keep rejecting.
  const { fn, callCount } = deferredFetch((i) =>
    i === 0 ? { errors: [{ message: 'introspection boom' }] } : EMPTY_SCHEMA,
  );
  t.mock.method(globalThis, 'fetch', fn);

  await assert.rejects(getSchemaTools(), /Introspection failed/);
  assert.equal(callCount(), 1);

  // Retry succeeds — proves the in-flight promise was reset rather than stuck.
  const retried = await getSchemaTools();
  assert.equal(callCount(), 2);
  assert.ok(retried.tools.execute_graphql);

  invalidateToolCache();
});
