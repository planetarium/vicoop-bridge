import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  a2aCardUrl,
  a2aEndpoint,
  deriveIdentity,
  formatAcct,
  formatMention,
  hostFromServerUrl,
  isValidMentionableLocal,
  webfingerUrl,
} from './identity.js';

test('isValidMentionableLocal accepts letters, digits, dot, hyphen, underscore', () => {
  for (const ok of ['claude', 'agent-1', 'a_b', '6eec0b6e-claude', 'a.b']) {
    assert.equal(isValidMentionableLocal(ok), true, `expected valid: ${ok}`);
  }
});

test('isValidMentionableLocal rejects unsafe / out-of-charset locals', () => {
  for (const bad of ['', '.', '..', 'foo@bar', 'a/b', 'a\nb', 'a b', 'a'.repeat(65)]) {
    assert.equal(isValidMentionableLocal(bad), false, `expected invalid: ${JSON.stringify(bad)}`);
  }
});

test('formatMention / formatAcct render the canonical strings', () => {
  const id = { agentId: 'claude', host: 'bridge.example.com' };
  assert.equal(formatMention(id), '@claude@bridge.example.com');
  assert.equal(formatAcct(id), 'acct:claude@bridge.example.com');
});

test('a2aEndpoint / a2aCardUrl render the bridge routes for this agent', () => {
  const id = { agentId: '6eec0b6e-claude', host: 'bridge.example.com' };
  assert.equal(a2aEndpoint(id), 'https://bridge.example.com/agents/6eec0b6e-claude');
  assert.equal(
    a2aCardUrl(id),
    'https://bridge.example.com/agents/6eec0b6e-claude/.well-known/agent-card.json',
  );
});

test('webfingerUrl percent-encodes the acct resource', () => {
  const id = { agentId: 'a', host: 'h.example' };
  const url = webfingerUrl(id);
  assert.equal(
    url,
    'https://h.example/.well-known/webfinger?resource=acct%3Aa%40h.example',
  );
});

test('hostFromServerUrl returns hostname for ws / wss / http urls', () => {
  assert.equal(hostFromServerUrl('wss://bridge.example.com/ws'), 'bridge.example.com');
  assert.equal(hostFromServerUrl('ws://localhost:8787/ws'), 'localhost');
  assert.equal(hostFromServerUrl('https://bridge.example.com'), 'bridge.example.com');
});

test('hostFromServerUrl returns null for malformed input', () => {
  assert.equal(hostFromServerUrl('not a url'), null);
  assert.equal(hostFromServerUrl(''), null);
});

test('deriveIdentity returns null when agentId is not a valid local', () => {
  assert.equal(
    deriveIdentity('bad/agent', 'wss://bridge.example.com/ws'),
    null,
  );
});

test('deriveIdentity returns null when host cannot be derived', () => {
  assert.equal(deriveIdentity('claude', 'not-a-url'), null);
});

test('deriveIdentity returns a populated identity on the happy path', () => {
  assert.deepEqual(
    deriveIdentity('claude', 'wss://bridge.example.com/ws'),
    { agentId: 'claude', host: 'bridge.example.com' },
  );
});
