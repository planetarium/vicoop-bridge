import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESERVED_AGENT_IDS,
  findReservedAgentId,
  isReservedAgentId,
} from './reserved-agent-ids.js';

test('admin is reserved', () => {
  assert.equal(isReservedAgentId('admin'), true);
});

test('reservation is case-insensitive', () => {
  // Don't let a caller bypass by sending Admin / ADMIN / aDmIn.
  for (const variant of ['Admin', 'ADMIN', 'aDmIn']) {
    assert.equal(isReservedAgentId(variant), true, variant);
  }
});

test('typical client agentIds are not reserved', () => {
  for (const id of ['echo-agent', 'foo', 'bar.baz', 'agent_7', 'admin-tools']) {
    assert.equal(isReservedAgentId(id), false, id);
  }
});

test('findReservedAgentId returns the first reserved entry, in input case', () => {
  // Returning the offending value (not just a boolean) lets callers surface
  // it in error_description without having to re-walk the array.
  assert.equal(findReservedAgentId(['foo', 'Admin', 'bar']), 'Admin');
  assert.equal(findReservedAgentId(['foo', 'bar']), undefined);
});

test('RESERVED_AGENT_IDS is non-empty (the SQL mirror would silently no-op otherwise)', () => {
  assert.ok(RESERVED_AGENT_IDS.size > 0);
  assert.ok(RESERVED_AGENT_IDS.has('admin'));
});
