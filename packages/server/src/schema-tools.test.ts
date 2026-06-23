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

// Mock fetch so the introspection round-trip resolves on the next tick,
// guaranteeing concurrent callers overlap on the in-flight promise.
function deferredFetch(payloadFor: (callIndex: number) => unknown) {
  let calls = 0;
  const fn = async () => {
    const index = calls++;
    await new Promise((r) => setTimeout(r, 5));
    return jsonResponse(payloadFor(index)) as unknown as Response;
  };
  return { fn, callCount: () => calls };
}

test('concurrent first calls trigger exactly one introspection (single-flight)', async (t) => {
  invalidateToolCache();
  const { fn, callCount } = deferredFetch(() => EMPTY_SCHEMA);
  t.mock.method(globalThis, 'fetch', fn);

  const results = await Promise.all([
    getSchemaTools(),
    getSchemaTools(),
    getSchemaTools(),
    getSchemaTools(),
    getSchemaTools(),
  ]);

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
