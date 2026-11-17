import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { formatFederatedPrincipal } from '@vicoop-bridge/protocol';
import { formatFederatedDelegation, parseFederatedDelegation, selectFederatedAuthorization, FEDERATION_RESTRICTED } from './federated-delegation.js';
import { validatePrincipal, matchPrincipal } from './principal.js';

const trust = { issuer: 'did:web:router.example', method: 'urn:vicoop:auth:verse8-user:v1' };
test('delegation authorizes distinct subjects only for its exact issuer/method', () => {
  const key = formatFederatedDelegation({ ...trust, id: randomUUID() })!;
  for (const subject of ['verse8:a:1', 'verse8:a:2']) assert.equal(selectFederatedAuthorization([key], { ...trust, subject }), key);
  assert.equal(selectFederatedAuthorization([key], { ...trust, issuer: 'did:web:other', subject: '1' }), undefined);
  assert.equal(selectFederatedAuthorization([key], { ...trust, method: 'other', subject: '1' }), undefined);
  assert.equal(selectFederatedAuthorization([key], { ...trust, subject: '' }), undefined);
  assert.equal(validatePrincipal(key), null);
  assert.equal(validatePrincipal(FEDERATION_RESTRICTED), null);
  assert.equal(matchPrincipal(FEDERATION_RESTRICTED, { principalId: 'any' }), false);
});
test('exact grants take precedence and ambiguous delegation fails closed', () => {
  const key = formatFederatedDelegation({ ...trust, id: randomUUID() })!;
  const other = formatFederatedDelegation({ ...trust, id: randomUUID() })!;
  const tuple = { ...trust, subject: 'user' };
  const exact = formatFederatedPrincipal(tuple)!;
  assert.equal(selectFederatedAuthorization([key, exact], tuple), exact);
  assert.equal(selectFederatedAuthorization([key, other], tuple), undefined);
  assert.equal(parseFederatedDelegation(key)?.issuer, trust.issuer);
  assert.equal(parseFederatedDelegation(key + 'x'), null);
});
