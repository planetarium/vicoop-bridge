import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripCallerSuppliedInternalKeys } from './http.js';

// Boundary-scrub regression for issue #128 (B):
//   A caller can put `_principalId` (or any other `_`-prefixed key) in the
//   request body's `message.metadata`. Downstream — the executor's binding
//   stamp + admin executor's auth resolve — treats `_*` keys as trusted
//   bridge-internal context. Without scrubbing at the HTTP boundary the
//   caller would spoof those fields. On public agents the auth middleware
//   doesn't inject anything, so a spoofed `_principalId` would flow into
//   `binding.principalId` and downstream `task_*` logs untouched.

test('stripCallerSuppliedInternalKeys removes _-prefixed keys from message.metadata in place', () => {
  const message: Record<string, unknown> = {
    role: 'user',
    parts: [{ kind: 'text', text: 'hi' }],
    messageId: 'm1',
    metadata: {
      _principalId: 'eth:victim',
      _bearerToken: 'vbc_caller_stolen',
      userField: 'keep',
    },
  };
  stripCallerSuppliedInternalKeys(message);
  assert.deepEqual(message.metadata, { userField: 'keep' });
});

test('stripCallerSuppliedInternalKeys deletes metadata entirely when only _-prefixed keys were present', () => {
  // Wire-shape guarantee: a message whose only metadata was caller-supplied
  // spoofs must look identical to a bare message on the wire — no
  // surprise empty `metadata: {}` for clients that key off
  // `metadata === undefined` as a "no metadata" sentinel.
  const message: Record<string, unknown> = {
    role: 'user',
    parts: [],
    messageId: 'm2',
    metadata: { _principalId: 'eth:victim' },
  };
  stripCallerSuppliedInternalKeys(message);
  assert.equal('metadata' in message, false);
});

test('stripCallerSuppliedInternalKeys is a no-op when metadata is absent', () => {
  const message: Record<string, unknown> = {
    role: 'user',
    parts: [],
    messageId: 'm3',
  };
  stripCallerSuppliedInternalKeys(message);
  assert.equal('metadata' in message, false);
});

test('stripCallerSuppliedInternalKeys is a no-op when metadata has no _-prefixed keys', () => {
  const message: Record<string, unknown> = {
    role: 'user',
    parts: [],
    messageId: 'm4',
    metadata: { foo: 'bar', nested: { _looksInternal: 'but is not top-level' } },
  };
  stripCallerSuppliedInternalKeys(message);
  // Top-level only — nested `_looksInternal` is the caller's own data and
  // must survive (the convention is about top-level keys downstream code
  // reads, not arbitrary nested structure).
  assert.deepEqual(message.metadata, {
    foo: 'bar',
    nested: { _looksInternal: 'but is not top-level' },
  });
});

test('stripCallerSuppliedInternalKeys leaves non-record metadata untouched', () => {
  // Defensive: caller might send `metadata: null` or `metadata: "junk"` —
  // those aren't records, downstream code already handles them as absent,
  // and the strip must not crash or coerce them.
  const messageNull: Record<string, unknown> = {
    role: 'user',
    parts: [],
    messageId: 'm5',
    metadata: null,
  };
  stripCallerSuppliedInternalKeys(messageNull);
  assert.equal(messageNull.metadata, null);

  const messageStr: Record<string, unknown> = {
    role: 'user',
    parts: [],
    messageId: 'm6',
    metadata: 'not-an-object',
  };
  stripCallerSuppliedInternalKeys(messageStr);
  assert.equal(messageStr.metadata, 'not-an-object');
});
