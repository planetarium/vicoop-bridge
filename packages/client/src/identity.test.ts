import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  a2aCardUrl,
  a2aEndpoint,
  deriveIdentity,
  formatAcct,
  formatMention,
  hostFromServerUrl,
  httpOriginFromServerUrl,
  isValidMentionableLocal,
  webfingerUrl,
} from './identity.js';

const HTTPS = 'https://bridge.example.com';

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
  const id = { agentId: 'claude', host: 'bridge.example.com', httpOrigin: HTTPS };
  assert.equal(formatMention(id), '@claude@bridge.example.com');
  assert.equal(formatAcct(id), 'acct:claude@bridge.example.com');
});

test('a2aEndpoint / a2aCardUrl render the bridge routes for this agent', () => {
  const id = { agentId: '6eec0b6e-claude', host: 'bridge.example.com', httpOrigin: HTTPS };
  assert.equal(a2aEndpoint(id), 'https://bridge.example.com/agents/6eec0b6e-claude');
  assert.equal(
    a2aCardUrl(id),
    'https://bridge.example.com/agents/6eec0b6e-claude/.well-known/agent-card.json',
  );
});

test('a2aEndpoint percent-encodes agentId so an out-of-charset id still yields a valid URL', () => {
  const id = { agentId: 'bad/agent', host: 'bridge.example.com', httpOrigin: HTTPS };
  assert.equal(a2aEndpoint(id), 'https://bridge.example.com/agents/bad%2Fagent');
});

test('webfingerUrl uses httpOrigin (preserving ws→http and port)', () => {
  const id = { agentId: 'a', host: 'localhost', httpOrigin: 'http://localhost:8787' };
  assert.equal(
    webfingerUrl(id),
    'http://localhost:8787/.well-known/webfinger?resource=acct%3Aa%40localhost',
  );
});

test('webfingerUrl percent-encodes the acct resource', () => {
  const id = { agentId: 'a', host: 'h.example', httpOrigin: 'https://h.example' };
  assert.equal(
    webfingerUrl(id),
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

test('httpOriginFromServerUrl maps ws→http and wss→https, preserving port', () => {
  assert.equal(httpOriginFromServerUrl('ws://localhost:8787/ws'), 'http://localhost:8787');
  assert.equal(httpOriginFromServerUrl('wss://bridge.example.com/ws'), 'https://bridge.example.com');
  assert.equal(
    httpOriginFromServerUrl('wss://bridge.example.com:9443/ws'),
    'https://bridge.example.com:9443',
  );
});

test('httpOriginFromServerUrl passes through http(s) URLs unchanged at the origin', () => {
  assert.equal(httpOriginFromServerUrl('https://bridge.example.com'), 'https://bridge.example.com');
  assert.equal(httpOriginFromServerUrl('http://localhost:8787/'), 'http://localhost:8787');
});

test('httpOriginFromServerUrl returns null for malformed input', () => {
  assert.equal(httpOriginFromServerUrl('not a url'), null);
  assert.equal(httpOriginFromServerUrl(''), null);
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

test('deriveIdentity carries both hostname and httpOrigin on the happy path', () => {
  assert.deepEqual(
    deriveIdentity('claude', 'wss://bridge.example.com/ws'),
    { agentId: 'claude', host: 'bridge.example.com', httpOrigin: 'https://bridge.example.com' },
  );
});

test('deriveIdentity preserves port for local dev (ws → http)', () => {
  assert.deepEqual(
    deriveIdentity('claude', 'ws://localhost:8787/ws'),
    { agentId: 'claude', host: 'localhost', httpOrigin: 'http://localhost:8787' },
  );
});
